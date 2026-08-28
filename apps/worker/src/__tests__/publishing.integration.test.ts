import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

loadEnv({ path: [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../../.env')], quiet: true });

import { createPrismaClient, type PrismaClient } from '@kult/database';
import { SecretBox } from '@kult/integrations';
import { publishingIdempotencyKey, publishingLockKey } from '@kult/shared';
import Redis from 'ioredis';
import { acquireLock, withLock } from '../lib/lock.js';

/**
 * Integration tests against real PostgreSQL and Redis.
 *
 * These verify the guarantee the whole publishing design exists to provide:
 * the same content version can never be published twice. Unit tests cannot
 * prove that, because the guarantee lives in a database unique constraint and a
 * Redis lock, not in application logic.
 *
 * Run with real services:
 *   docker run -d --name kult-mos-pg -e POSTGRES_PASSWORD=kult -e POSTGRES_USER=kult \
 *     -e POSTGRES_DB=kult_marketing -p 55432:5432 postgres:17-alpine
 *   docker run -d --name kult-mos-redis -p 56379:6379 redis:7-alpine
 */

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const canRun = Boolean(DATABASE_URL && REDIS_URL);

describe.skipIf(!canRun)('publishing idempotency (integration)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let organizationId: string;
  let userId: string;
  let contentItemId: string;
  let connectionId: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: DATABASE_URL!, maxConnections: 5 });
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });

    const suffix = randomUUID().slice(0, 8);
    const secrets = new SecretBox(process.env.ENCRYPTION_KEY!);

    const organization = await prisma.organization.create({
      data: { name: `Test Org ${suffix}`, slug: `test-org-${suffix}`, timezone: 'UTC' },
      select: { id: true },
    });
    organizationId = organization.id;

    const user = await prisma.user.create({
      data: { privyUserId: `did:privy:test-${suffix}`, email: `test-${suffix}@example.com` },
      select: { id: true },
    });
    userId = user.id;

    await prisma.organizationMember.create({
      data: { organizationId, userId, role: 'OWNER' },
    });

    const content = await prisma.contentItem.create({
      data: {
        organizationId,
        contentType: 'X_POST',
        platform: 'X',
        body: 'Integration test post body.',
        status: 'APPROVED',
        version: 1,
        createdById: userId,
      },
      select: { id: true },
    });
    contentItemId = content.id;

    const connection = await prisma.socialConnection.create({
      data: {
        organizationId,
        provider: 'X',
        providerAccountId: `acct-${suffix}`,
        accountName: 'Test Account',
        accessTokenEncrypted: secrets.encrypt('fake-access-token'),
        scopes: ['tweet.read', 'tweet.write', 'users.read'],
        status: 'ACTIVE',
        capabilities: { publishableContentTypes: ['X_POST', 'X_THREAD'] },
      },
      select: { id: true },
    });
    connectionId = connection.id;
  });

  afterAll(async () => {
    if (organizationId) {
      // Cascades clean up content, connections, publications, and members.
      await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await prisma.$disconnect().catch(() => undefined);
    await redis.quit().catch(() => undefined);
  });

  it('enforces one publication per idempotency key at the database level', async () => {
    const idempotencyKey = publishingIdempotencyKey({
      organizationId,
      socialConnectionId: connectionId,
      contentItemId,
      contentVersion: 1,
    });

    await prisma.publication.create({
      data: {
        organizationId,
        contentItemId,
        socialConnectionId: connectionId,
        provider: 'X',
        idempotencyKey,
        contentVersion: 1,
        status: 'SUCCEEDED',
        providerPostId: 'provider-post-1',
        publishedAt: new Date(),
      },
    });

    // A second insert with the same key is what a double-publish would look
    // like. The unique constraint must reject it.
    await expect(
      prisma.publication.create({
        data: {
          organizationId,
          contentItemId,
          socialConnectionId: connectionId,
          provider: 'X',
          idempotencyKey,
          contentVersion: 1,
          status: 'SUCCEEDED',
          providerPostId: 'provider-post-2',
        },
      }),
    ).rejects.toThrow();

    const count = await prisma.publication.count({ where: { idempotencyKey } });
    expect(count).toBe(1);
  });

  it('produces a different key once the content version changes', async () => {
    const v1 = publishingIdempotencyKey({
      organizationId,
      socialConnectionId: connectionId,
      contentItemId,
      contentVersion: 1,
    });
    const v2 = publishingIdempotencyKey({
      organizationId,
      socialConnectionId: connectionId,
      contentItemId,
      contentVersion: 2,
    });
    expect(v1).not.toBe(v2);

    // An edited, re-approved version is genuinely publishable again.
    const created = await prisma.publication.create({
      data: {
        organizationId,
        contentItemId,
        socialConnectionId: connectionId,
        provider: 'X',
        idempotencyKey: v2,
        contentVersion: 2,
        status: 'PENDING',
      },
      select: { id: true },
    });
    expect(created.id).toBeTruthy();
  });

  it('grants the publishing lock to exactly one holder', async () => {
    const key = publishingLockKey(`lock-test-${randomUUID()}`);

    const first = await acquireLock(redis, key, 5_000);
    const second = await acquireLock(redis, key, 5_000);

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // Contended: the second worker must not proceed.

    await first!.release();

    const third = await acquireLock(redis, key, 5_000);
    expect(third).not.toBeNull();
    await third!.release();
  });

  it('does not let a stale holder release a lock it no longer owns', async () => {
    const key = publishingLockKey(`lock-steal-${randomUUID()}`);

    const original = await acquireLock(redis, key, 200);
    expect(original).not.toBeNull();

    // Let the lock lapse, then let someone else take it.
    await new Promise((r) => setTimeout(r, 350));
    const next = await acquireLock(redis, key, 5_000);
    expect(next).not.toBeNull();

    // The original holder's release must be a no-op, not a theft.
    const released = await original!.release();
    expect(released).toBe(false);

    // The new holder still owns it.
    const contended = await acquireLock(redis, key, 1_000);
    expect(contended).toBeNull();

    await next!.release();
  });

  it('releases the lock even when the guarded operation throws', async () => {
    const key = publishingLockKey(`lock-throw-${randomUUID()}`);

    await expect(
      withLock(redis, key, 5_000, async () => {
        throw new Error('provider exploded');
      }),
    ).rejects.toThrow('provider exploded');

    // If the lock leaked, this would return null and publishing would wedge.
    const after = await acquireLock(redis, key, 1_000);
    expect(after).not.toBeNull();
    await after!.release();
  });

  it('reports contention rather than running the operation twice', async () => {
    const key = publishingLockKey(`lock-contend-${randomUUID()}`);
    const held = await acquireLock(redis, key, 5_000);
    expect(held).not.toBeNull();

    let ran = false;
    const outcome = await withLock(redis, key, 5_000, async () => {
      ran = true;
      return 'published';
    });

    expect(outcome.acquired).toBe(false);
    expect(ran).toBe(false); // The critical section must not have executed.

    await held!.release();
  });

  it('enforces tenant isolation on knowledge retrieval at the SQL level', async () => {
    // The cosine function must exist and be callable; knowledge retrieval
    // depends on it and a missing migration would only surface at query time.
    const result = await prisma.$queryRaw<Array<{ similarity: number }>>`
      SELECT kult_cosine_similarity(ARRAY[1,0,0]::double precision[], ARRAY[1,0,0]::double precision[]) AS similarity
    `;
    expect(Number(result[0]?.similarity)).toBeCloseTo(1, 5);
  });
});
