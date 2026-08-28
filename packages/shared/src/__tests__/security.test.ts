import { describe, expect, it } from 'vitest';
import {
  canAssignRole,
  hasPermission,
  outranks,
  permissionsForRole,
  ROLE_PERMISSIONS,
} from '../rbac.js';
import {
  canonicalizeUrl,
  publishingIdempotencyKey,
  redactSecrets,
  researchItemHash,
} from '../identity.js';
import { canTransition, evaluateAutopilotEligibility } from '../domain.js';
import { countCharacters, getCapability, validateContent } from '../platforms.js';

describe('RBAC', () => {
  it('gives VIEWER read access but no write access', () => {
    expect(hasPermission('VIEWER', 'content:read')).toBe(true);
    expect(hasPermission('VIEWER', 'content:write')).toBe(false);
    expect(hasPermission('VIEWER', 'content:publish')).toBe(false);
  });

  it('withholds approval from EDITOR and grants it to ADMIN', () => {
    // Editors create content; approving their own work must require a higher role.
    expect(hasPermission('EDITOR', 'content:write')).toBe(true);
    expect(hasPermission('EDITOR', 'content:approve')).toBe(false);
    expect(hasPermission('ADMIN', 'content:approve')).toBe(true);
  });

  it('restricts ANALYST to research and analytics', () => {
    expect(hasPermission('ANALYST', 'analytics:read')).toBe(true);
    expect(hasPermission('ANALYST', 'research:run')).toBe(true);
    expect(hasPermission('ANALYST', 'content:write')).toBe(false);
    expect(hasPermission('ANALYST', 'integrations:connect')).toBe(false);
  });

  it('reserves ownership transfer for OWNER alone', () => {
    expect(hasPermission('OWNER', 'organization:transfer_ownership')).toBe(true);
    expect(hasPermission('ADMIN', 'organization:transfer_ownership')).toBe(false);
  });

  it('nests role permissions so each role is a superset of the one below', () => {
    const order = ['VIEWER', 'ANALYST', 'EDITOR', 'ADMIN', 'OWNER'] as const;
    for (let index = 1; index < order.length; index += 1) {
      const lower = permissionsForRole(order[index - 1]!);
      const higher = ROLE_PERMISSIONS[order[index]!];
      for (const permission of lower) {
        expect(higher.has(permission)).toBe(true);
      }
    }
  });

  it('never lets a role assign OWNER or its own rank', () => {
    expect(canAssignRole('OWNER', 'OWNER')).toBe(false);
    expect(canAssignRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canAssignRole('ADMIN', 'EDITOR')).toBe(true);
    expect(canAssignRole('EDITOR', 'ADMIN')).toBe(false);
    expect(outranks('OWNER', 'ADMIN')).toBe(true);
  });
});

describe('publishing idempotency', () => {
  const base = {
    organizationId: 'org_1',
    socialConnectionId: 'conn_1',
    contentItemId: 'content_1',
    contentVersion: 1,
  };

  it('is stable across calls, which is what makes a worker retry safe', () => {
    expect(publishingIdempotencyKey(base)).toBe(publishingIdempotencyKey(base));
  });

  it('changes when the content version changes', () => {
    expect(publishingIdempotencyKey({ ...base, contentVersion: 2 })).not.toBe(
      publishingIdempotencyKey(base),
    );
  });

  it('separates organizations, connections, and content items', () => {
    const key = publishingIdempotencyKey(base);
    expect(publishingIdempotencyKey({ ...base, organizationId: 'org_2' })).not.toBe(key);
    expect(publishingIdempotencyKey({ ...base, socialConnectionId: 'conn_2' })).not.toBe(key);
    expect(publishingIdempotencyKey({ ...base, contentItemId: 'content_2' })).not.toBe(key);
  });

  it('cannot be confused by field values that concatenate identically', () => {
    // Without a separator, ("a","bc") and ("ab","c") would collide.
    const first = publishingIdempotencyKey({ ...base, organizationId: 'a', socialConnectionId: 'bc' });
    const second = publishingIdempotencyKey({ ...base, organizationId: 'ab', socialConnectionId: 'c' });
    expect(first).not.toBe(second);
  });
});

describe('URL canonicalisation and research deduplication', () => {
  it('strips tracking parameters and normalises the host', () => {
    expect(canonicalizeUrl('https://WWW.Example.com/post/?utm_source=x&b=2&a=1#frag')).toBe(
      'https://example.com/post?a=1&b=2',
    );
  });

  it('treats the same article from two feeds as one item', () => {
    const first = researchItemHash({
      url: 'https://example.com/a?utm_campaign=news',
      title: 'A',
    });
    const second = researchItemHash({ url: 'https://www.example.com/a/', title: 'A different title' });
    expect(first).toBe(second);
  });

  it('falls back to content hashing when there is no URL', () => {
    const first = researchItemHash({ title: 'Same   Title', body: 'Body' });
    const second = researchItemHash({ title: 'same title', body: 'body' });
    expect(first).toBe(second);
  });

  it('does not treat a malformed URL as a fatal error', () => {
    expect(() => researchItemHash({ url: 'not a url', title: 'T' })).not.toThrow();
  });
});

describe('secret redaction', () => {
  it('redacts token-shaped keys at any depth', () => {
    const redacted = redactSecrets({
      user: 'kult',
      accessToken: 'secret-value',
      nested: { refresh_token: 'another', client_secret: 'third', safe: 'keep' },
      list: [{ authorization: 'Bearer abc' }],
    });

    expect(JSON.stringify(redacted)).not.toContain('secret-value');
    expect(JSON.stringify(redacted)).not.toContain('another');
    expect(JSON.stringify(redacted)).not.toContain('Bearer abc');
    expect((redacted.nested as Record<string, unknown>).safe).toBe('keep');
  });
});

describe('content status transitions', () => {
  it('permits the normal approval path', () => {
    expect(canTransition('DRAFT', 'PENDING_APPROVAL')).toBe(true);
    expect(canTransition('PENDING_APPROVAL', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'SCHEDULED')).toBe(true);
    expect(canTransition('SCHEDULED', 'PUBLISHING')).toBe(true);
    expect(canTransition('PUBLISHING', 'PUBLISHED')).toBe(true);
  });

  it('refuses to publish content that skipped approval', () => {
    expect(canTransition('DRAFT', 'PUBLISHING')).toBe(false);
    expect(canTransition('DRAFT', 'PUBLISHED')).toBe(false);
    expect(canTransition('REJECTED', 'SCHEDULED')).toBe(false);
  });

  it('treats PUBLISHED as terminal', () => {
    expect(canTransition('PUBLISHED', 'DRAFT')).toBe(false);
    expect(canTransition('PUBLISHED', 'CANCELLED')).toBe(false);
  });
});

describe('autopilot eligibility', () => {
  const eligible = {
    automationMode: 'AUTOPILOT' as const,
    riskLevel: 'LOW' as const,
    flaggedTopics: [],
    allowedContentTypes: ['X_POST'],
    contentType: 'X_POST',
    hasUnverifiedClaims: false,
    connectionStatus: 'ACTIVE' as const,
    publishedInLast24h: 0,
    dailyLimit: 6,
  };

  it('permits only a fully clean case', () => {
    expect(evaluateAutopilotEligibility(eligible).eligible).toBe(true);
  });

  it('blocks when the organization is not in autopilot mode', () => {
    const result = evaluateAutopilotEligibility({ ...eligible, automationMode: 'COPILOT' });
    expect(result.eligible).toBe(false);
  });

  it('blocks anything above LOW risk', () => {
    expect(evaluateAutopilotEligibility({ ...eligible, riskLevel: 'MEDIUM' }).eligible).toBe(false);
  });

  it('blocks unverified claims and flagged topics', () => {
    expect(evaluateAutopilotEligibility({ ...eligible, hasUnverifiedClaims: true }).eligible).toBe(
      false,
    );
    expect(
      evaluateAutopilotEligibility({ ...eligible, flaggedTopics: ['TOKEN_CLAIM'] }).eligible,
    ).toBe(false);
  });

  it('blocks a content type outside the allowlist', () => {
    expect(
      evaluateAutopilotEligibility({ ...eligible, contentType: 'X_THREAD' }).eligible,
    ).toBe(false);
  });

  it('enforces the daily publishing limit', () => {
    const result = evaluateAutopilotEligibility({ ...eligible, publishedInLast24h: 6 });
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(' ')).toContain('daily publishing limit');
  });

  it('reports every blocker rather than just the first', () => {
    const result = evaluateAutopilotEligibility({
      ...eligible,
      automationMode: 'MANUAL',
      riskLevel: 'HIGH',
      hasUnverifiedClaims: true,
    });
    expect(result.blockers.length).toBeGreaterThanOrEqual(3);
  });
});

describe('platform validation', () => {
  it('counts emoji by code point, not UTF-16 unit', () => {
    // "👍" is two UTF-16 units but one character to a social platform.
    expect(countCharacters('👍')).toBe(1);
    expect('👍'.length).toBe(2);
  });

  it('rejects an over-length X post', () => {
    const violations = validateContent({ contentType: 'X_POST', body: 'a'.repeat(281) });
    expect(violations.some((violation) => violation.code === 'TOO_LONG')).toBe(true);
  });

  it('validates each thread part independently', () => {
    const violations = validateContent({
      contentType: 'X_THREAD',
      body: 'ok',
      threadParts: ['fine', 'b'.repeat(281)],
    });
    expect(violations.filter((violation) => violation.code === 'TOO_LONG')).toHaveLength(1);
    expect(violations[0]?.message).toContain('post 2');
  });

  it('requires media for Instagram only at publish time', () => {
    const draft = validateContent({ contentType: 'INSTAGRAM_CAPTION', body: 'caption' });
    expect(draft.some((violation) => violation.code === 'REQUIRED')).toBe(false);

    const publishing = validateContent(
      { contentType: 'INSTAGRAM_CAPTION', body: 'caption' },
      { forPublishing: true },
    );
    expect(publishing.some((violation) => violation.code === 'REQUIRED')).toBe(true);
  });

  it('reports Reddit and Discord as unpublishable with a reason', () => {
    const violations = validateContent(
      { contentType: 'REDDIT_POST', body: 'hello' },
      { forPublishing: true },
    );
    const notPublishable = violations.find((violation) => violation.code === 'NOT_PUBLISHABLE');
    expect(notPublishable).toBeDefined();
    expect(notPublishable?.message.length).toBeGreaterThan(20);
  });

  it('caps an Instagram carousel at the documented ten items', () => {
    expect(getCapability('INSTAGRAM_CAROUSEL').maxMediaItems.value).toBe(10);
    const violations = validateContent({
      contentType: 'INSTAGRAM_CAROUSEL',
      body: 'caption',
      mediaCount: 11,
    });
    expect(violations.some((violation) => violation.field === 'media')).toBe(true);
  });
});
