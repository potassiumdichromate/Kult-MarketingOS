// Loads .env the same way the worker does, before anything reads configuration.
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({
  path: [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../../.env')],
  quiet: true,
});

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { Job } from 'bullmq';
import {
  createOAuthState,
  createPkcePair,
  providerRequest,
  type TokenSet,
} from '@kult/integrations';
import { QUEUE_NAMES } from '@kult/shared';
import { createContext, destroyContext, type WorkerContext } from '../context.js';
import { JOB_NAMES } from '../jobs.js';
import { jobLogger } from '../logger.js';
import { processPublishContent } from '../processors/publishing.js';
import { processCollectMetrics } from '../processors/analytics.js';

/**
 * Live check of the X integration against a real X account.
 *
 * Everything about X has so far been verified against documentation and fake
 * tokens. This runs the real path once, end to end:
 *
 *   1. OAuth 2.0 + PKCE against x.com, with a local listener on X_REDIRECT_URI
 *   2. account lookup and the capability report the integrations UI would show
 *   3. one real post, published through the worker's own publishing processor
 *   4. the same job run again, which must return ALREADY_PUBLISHED and not post
 *   5. a metric read through the worker's own analytics processor
 *
 * It posts publicly, so it asks for confirmation before step 3. The records it
 * creates live in a throwaway organization that is deleted at the end, unless
 * --keep is passed (useful for watching the real worker collect metrics later).
 *
 * Usage (stop the API first: the listener binds X_REDIRECT_URI's port):
 *   pnpm --filter @kult/worker x:live-check [--keep] [--text "custom post text"]
 */

interface Options {
  keep: boolean;
  text: string | undefined;
}

function parseArgs(argv: string[]): Options {
  const textIndex = argv.indexOf('--text');
  return {
    keep: argv.includes('--keep'),
    text: textIndex >= 0 ? argv[textIndex + 1] : undefined,
  };
}

const prompt = createInterface({ input: process.stdin, output: process.stdout });

// This is an interactive CLI: its output is for the operator at the terminal, not the log stream.
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function step(title: string): void {
  say(`\n── ${title}`);
}

function pass(message: string): void {
  say(`  ✓ ${message}`);
}

function fail(message: string): never {
  throw new CheckFailure(message);
}

class CheckFailure extends Error {}

/**
 * Waits for X to redirect the browser back with ?code=&state=.
 *
 * Listens on the exact host, port and path of X_REDIRECT_URI, because X only
 * redirects to a callback registered on the developer app. When the port is
 * taken (usually by the API), the redirected URL can be pasted instead.
 */
async function awaitAuthorizationCode(redirectUri: string, expectedState: string): Promise<string> {
  const target = new URL(redirectUri);
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));

  const fromUrl = (raw: string): string => {
    const url = new URL(raw, redirectUri);
    const error = url.searchParams.get('error');
    if (error)
      fail(
        `X declined the authorization: ${error} ${url.searchParams.get('error_description') ?? ''}`,
      );
    if (url.searchParams.get('state') !== expectedState) {
      fail('The OAuth state did not match. Start the check again rather than reusing an old link.');
    }
    const code = url.searchParams.get('code');
    if (!code) fail('The callback carried no authorization code.');
    return code;
  };

  return new Promise<string>((resolveCode, rejectCode) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', redirectUri);
      if (url.pathname !== target.pathname) {
        response.writeHead(404).end();
        return;
      }
      try {
        const code = fromUrl(url.toString());
        response
          .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          .end('Kult X live check: authorization received. You can close this tab.');
        server.close();
        resolveCode(code);
      } catch (error) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error));
        server.close();
        rejectCode(error);
      }
    });

    server.once('error', async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') {
        rejectCode(error);
        return;
      }
      say(
        `  Port ${port} is unavailable (${error.code}), so the callback cannot be caught here.\n` +
          '  After approving, copy the full URL your browser was redirected to and paste it below.',
      );
      try {
        resolveCode(fromUrl((await prompt.question('  Redirected URL: ')).trim()));
      } catch (pasteError) {
        rejectCode(pasteError);
      }
    });

    server.listen(port, target.hostname === 'localhost' ? undefined : target.hostname);
  });
}

async function run(context: WorkerContext, options: Options): Promise<void> {
  const created: { organizationId?: string; userId?: string } = {};
  let publicationId: string | undefined;

  try {
    step('1. Configuration');
    const x = context.config.social.x;
    if (!x)
      fail('X is not configured. Set X_CLIENT_ID, X_CLIENT_SECRET and X_REDIRECT_URI in .env.');
    const adapter = context.social.getConfigured('X');
    pass(`client ${x.clientId.slice(0, 6)}…, callback ${x.redirectUri}`);

    step('2. Authorize with X');
    const state = createOAuthState();
    const { codeVerifier } = createPkcePair();
    const authorization = adapter.getAuthorizationUrl({ state, codeVerifier });
    say(
      `  Open this URL, sign in as the account to test, and approve:\n\n  ${authorization.url}\n`,
    );
    const code = await awaitAuthorizationCode(x.redirectUri, state);
    const tokens: TokenSet = await adapter.handleOAuthCallback({ code, codeVerifier });
    pass(`token received, expires ${tokens.expiresAt?.toISOString() ?? 'never'}`);
    pass(
      `refresh token ${tokens.refreshToken ? 'present' : 'ABSENT (offline.access not granted)'}`,
    );

    step('3. Account and capabilities');
    const account = await adapter.getAccount(tokens);
    pass(`@${account.accountUsername} (${account.accountName}), id ${account.providerAccountId}`);
    const capabilities = await adapter.resolveCapabilities({ tokens, account });
    say(`  granted:     ${capabilities.grantedScopes.join(' ') || '(none)'}`);
    say(`  missing:     ${capabilities.missingScopes.join(' ') || '(none)'}`);
    say(`  publishable: ${capabilities.publishableContentTypes.join(', ') || '(none)'}`);
    for (const [name, reason] of Object.entries(capabilities.unavailable)) {
      say(`  unavailable: ${name} — ${reason}`);
    }
    if (!capabilities.publishableContentTypes.includes('X_POST')) {
      fail('This connection cannot publish X_POST, so the publishing steps cannot run.');
    }

    if (options.text !== undefined && options.text.trim() === '') {
      fail('--text was given an empty value.');
    }
    // X rejects an exact duplicate of a recent post, so the default text is unique.
    const body = options.text ?? `Kult Marketing OS connection check · ${new Date().toISOString()}`;

    step('4. Publish one post through the worker');
    say(`  This will post PUBLICLY to @${account.accountUsername}:\n\n    "${body}"\n`);
    const answer = await prompt.question('  Type "post" to continue, anything else to stop: ');
    if (answer.trim() !== 'post') {
      say('  Stopped before publishing. Nothing was posted.');
      return;
    }

    const suffix = randomUUID().slice(0, 8);
    const organization = await context.prisma.organization.create({
      data: { name: `X live check ${suffix}`, slug: `x-live-check-${suffix}`, timezone: 'UTC' },
      select: { id: true },
    });
    created.organizationId = organization.id;

    const user = await context.prisma.user.create({
      data: {
        privyUserId: `did:privy:x-live-check-${suffix}`,
        email: `x-live-check-${suffix}@example.invalid`,
      },
      select: { id: true },
    });
    created.userId = user.id;
    await context.prisma.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id, role: 'OWNER' },
    });

    const connection = await context.prisma.socialConnection.create({
      data: {
        organizationId: organization.id,
        provider: 'X',
        providerAccountId: account.providerAccountId,
        accountName: account.accountName,
        accountUsername: account.accountUsername ?? null,
        accessTokenEncrypted: context.secrets.encrypt(tokens.accessToken),
        refreshTokenEncrypted: tokens.refreshToken
          ? context.secrets.encrypt(tokens.refreshToken)
          : null,
        expiresAt: tokens.expiresAt ?? null,
        scopes: tokens.scopes,
        metadata: account.metadata as object,
        capabilities: capabilities as unknown as object,
        status: 'ACTIVE',
        connectedById: user.id,
      },
      select: { id: true },
    });

    // APPROVED by a person, so the autopilot gate does not apply.
    const content = await context.prisma.contentItem.create({
      data: {
        organizationId: organization.id,
        contentType: 'X_POST',
        platform: 'X',
        body,
        status: 'APPROVED',
        version: 1,
        createdById: user.id,
      },
      select: { id: true },
    });

    const jobData = {
      organizationId: organization.id,
      correlationId: `x-live-check-${suffix}`,
      contentItemId: content.id,
      socialConnectionId: connection.id,
      contentVersion: 1,
      actorUserId: user.id,
    };
    const publishLog = jobLogger({
      queue: QUEUE_NAMES.publishing,
      jobName: JOB_NAMES.publishContent,
      jobId: `x-live-check-${suffix}`,
      organizationId: organization.id,
    });

    const first = await processPublishContent(context, { data: jobData } as Job, publishLog);
    if (first.status !== 'PUBLISHED' || !first.publicationId) {
      fail(`Publishing returned ${first.status}: ${first.reason ?? 'no reason given'}`);
    }
    publicationId = first.publicationId;

    const publication = await context.prisma.publication.findUniqueOrThrow({
      where: { id: publicationId },
      select: { status: true, providerPostId: true, providerUrl: true },
    });
    pass(`publication ${publication.status}, post ${publication.providerPostId}`);
    pass(`live at ${publication.providerUrl}`);

    const onX = await adapter.getPost({ tokens, providerPostId: publication.providerPostId! });
    if (onX.id !== publication.providerPostId)
      fail('X did not return the post that was just created.');
    pass('X returns the post by id');

    step('5. Re-run the same job — must not post again');
    const second = await processPublishContent(context, { data: jobData } as Job, publishLog);
    if (second.status !== 'ALREADY_PUBLISHED') {
      fail(
        `Second run returned ${second.status}; expected ALREADY_PUBLISHED. CHECK THE ACCOUNT FOR A DUPLICATE.`,
      );
    }
    const publicationCount = await context.prisma.publication.count({
      where: { contentItemId: content.id },
    });
    if (publicationCount !== 1) fail(`Expected 1 publication row, found ${publicationCount}.`);
    pass('ALREADY_PUBLISHED, still exactly one publication');

    step('6. Read metrics through the worker');
    const metricsResult = await processCollectMetrics(
      context,
      {
        data: {
          organizationId: organization.id,
          correlationId: jobData.correlationId,
          publicationId,
        },
      } as Job,
      jobLogger({
        queue: QUEUE_NAMES.analytics,
        jobName: JOB_NAMES.collectMetrics,
        jobId: `x-live-check-metrics-${suffix}`,
        organizationId: organization.id,
      }),
    );
    if (!metricsResult.collected)
      fail(`No metrics collected: ${metricsResult.reason ?? 'no reason given'}`);
    const snapshot = await context.prisma.postMetricSnapshot.findFirstOrThrow({
      where: { publicationId },
      orderBy: { capturedAt: 'desc' },
    });
    pass(
      `snapshot stored — impressions ${snapshot.impressions ?? 'not reported'}, ` +
        `likes ${snapshot.likes ?? 'not reported'}, replies ${snapshot.comments ?? 'not reported'}`,
    );

    say('\nAll checks passed. The X integration works against a live account.');

    if (!options.keep) {
      const remove = await prompt.question(`\n  Delete the test post from X? [y/N] `);
      if (remove.trim().toLowerCase() === 'y') {
        // The adapter has no delete, by design: the app never removes posts. This
        // is test cleanup only, so it calls the documented endpoint directly.
        await providerRequest<unknown>({
          provider: 'X',
          url: `https://api.x.com/2/tweets/${encodeURIComponent(publication.providerPostId!)}`,
          method: 'DELETE',
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        });
        pass('test post deleted from X');
      } else {
        say(`  Left in place: ${publication.providerUrl}`);
      }
    }
  } finally {
    if (publicationId && !options.keep) {
      // The publisher schedules a delayed metrics job; it would fail once the
      // throwaway organization is gone.
      await context.queues[QUEUE_NAMES.analytics]
        .remove(`metrics:${publicationId}:initial`)
        .catch(() => undefined);
    }

    if (options.keep && created.organizationId) {
      say(
        `\n  --keep: organization ${created.organizationId} and its records were kept. ` +
          'A running worker will collect metrics again in 15 minutes.',
      );
    } else if (created.organizationId) {
      // Cascades to the connection, content, publication and snapshots. Audit
      // rows survive with organizationId set to null, which is intended.
      await context.prisma.organization.delete({ where: { id: created.organizationId } });
      if (created.userId) await context.prisma.user.delete({ where: { id: created.userId } });
      say('\n  Test records removed from the database.');
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let context: WorkerContext;
  try {
    context = createContext();
  } catch (error) {
    // Usually a ConfigurationError, whose message already lists every problem.
    console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}`);
    prompt.close();
    process.exitCode = 1;
    return;
  }

  try {
    await run(context, options);
  } catch (error) {
    if (error instanceof CheckFailure) {
      console.error(`\n  ✗ ${error.message}`);
    } else {
      console.error('\n  ✗ Unexpected error:', error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  } finally {
    prompt.close();
    await destroyContext(context);
  }
}

void main();
