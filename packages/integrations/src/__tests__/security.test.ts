import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  SecretBox,
  createOAuthState,
  createPkcePair,
  hashApiKey,
  parseEncryptionKey,
  safeEqual,
} from '../crypto.js';
import { assertPublicUrl, isBlockedAddress } from '../safe-fetch.js';
import { sanitizeProviderMessage, classifyError } from '../social/http.js';
import { ValidationError, ProviderError, RateLimitError } from '@kult/shared';

const KEY = randomBytes(32).toString('hex');

describe('token encryption', () => {
  const box = new SecretBox(KEY);

  it('round-trips a value', () => {
    const sealed = box.encrypt('access-token-value');
    expect(sealed).not.toContain('access-token-value');
    expect(box.decrypt(sealed)).toBe('access-token-value');
  });

  it('produces a different ciphertext each time, so equal tokens are not linkable', () => {
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const sealed = box.encrypt('sensitive');
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    parts[3] = flipped.toString('base64url');

    expect(() => box.decrypt(parts.join('.'))).toThrow(DecryptionError);
  });

  it('rejects a tampered auth tag', () => {
    const sealed = box.encrypt('sensitive');
    const parts = sealed.split('.');
    parts[2] = randomBytes(16).toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow(DecryptionError);
  });

  it('cannot decrypt with a different key', () => {
    const sealed = box.encrypt('sensitive');
    const other = new SecretBox(randomBytes(32).toString('hex'));
    expect(() => other.decrypt(sealed)).toThrow(DecryptionError);
  });

  it('never leaks the plaintext in the failure message', () => {
    const sealed = new SecretBox(randomBytes(32).toString('hex')).encrypt('super-secret-token');
    try {
      box.decrypt(sealed);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-token');
    }
  });

  it('rejects a malformed sealed value', () => {
    expect(() => box.decrypt('not-sealed')).toThrow(DecryptionError);
    expect(() => box.decrypt('v2.a.b.c')).toThrow(DecryptionError);
  });

  it('accepts hex or base64 keys and rejects wrong-length keys', () => {
    expect(parseEncryptionKey(randomBytes(32).toString('hex'))).toHaveLength(32);
    expect(parseEncryptionKey(randomBytes(32).toString('base64'))).toHaveLength(32);
    expect(() => parseEncryptionKey('tooshort')).toThrow();
    expect(() => parseEncryptionKey(randomBytes(16).toString('hex'))).toThrow();
  });

  it('leaves optional values alone', () => {
    expect(box.encryptOptional(null)).toBeNull();
    expect(box.decryptOptional(undefined)).toBeNull();
  });
});

describe('PKCE and state', () => {
  it('produces a verifier in the RFC 7636 length range and a distinct S256 challenge', () => {
    const pair = createPkcePair();
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(pair.codeChallengeMethod).toBe('S256');
    expect(pair.codeChallenge).not.toBe(pair.codeVerifier);
    // base64url only: no +, /, or = padding.
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats a verifier or a state value', () => {
    const verifiers = new Set(Array.from({ length: 200 }, () => createPkcePair().codeVerifier));
    expect(verifiers.size).toBe(200);
    const states = new Set(Array.from({ length: 200 }, () => createOAuthState()));
    expect(states.size).toBe(200);
  });
});

describe('constant-time comparison and API key hashing', () => {
  it('compares correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('hashes API keys deterministically without storing the plaintext', () => {
    const hash = hashApiKey('kult_live_secret');
    expect(hash).toBe(hashApiKey('kult_live_secret'));
    expect(hash).not.toContain('secret');
    expect(hash).toHaveLength(64);
  });
});

describe('SSRF protection', () => {
  it('blocks loopback, private, link-local, CGNAT and metadata addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('blocks IPv6 loopback, link-local, unique-local, and mapped IPv4 ranges', () => {
    for (const address of ['::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', '::ffff:127.0.0.1', 'ff02::1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('treats anything that is not an IP as unsafe', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });

  it('rejects non-http schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(ValidationError);
    await expect(assertPublicUrl('gopher://example.com')).rejects.toBeInstanceOf(ValidationError);
    await expect(assertPublicUrl('data:text/html,hi')).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects localhost by name, including dotted and trailing-dot forms', async () => {
    await expect(assertPublicUrl('http://localhost:3000')).rejects.toBeInstanceOf(ValidationError);
    await expect(assertPublicUrl('http://api.localhost/x')).rejects.toBeInstanceOf(ValidationError);
    await expect(assertPublicUrl('http://svc.internal/x')).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects the cloud metadata endpoint by literal address and by name', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(assertPublicUrl('http://metadata.google.internal/')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects a non-standard port', async () => {
    await expect(assertPublicUrl('http://example.com:22/')).rejects.toBeInstanceOf(ValidationError);
    await expect(assertPublicUrl('http://example.com:6379/')).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a malformed URL', async () => {
    await expect(assertPublicUrl('http://')).rejects.toBeInstanceOf(ValidationError);
    await expect(assertPublicUrl('nonsense')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('provider error handling', () => {
  it('strips bearer tokens and secrets from provider messages', () => {
    const message = sanitizeProviderMessage(
      'Request failed with Authorization: Bearer AAAA1111bbbb.cccc-dddd and access_token=zzz9',
    );
    expect(message).not.toContain('AAAA1111bbbb');
    expect(message).not.toContain('zzz9');
    expect(message).toContain('[redacted]');
  });

  it('strips JSON-embedded secrets', () => {
    const message = sanitizeProviderMessage('{"refresh_token":"rt_abc123","ok":false}');
    expect(message).not.toContain('rt_abc123');
  });

  it('classifies 429 as a rate limit and honours retry-after', () => {
    const error = classifyError('X', 429, { detail: 'Too Many Requests' }, '', {
      'retry-after': '30',
    });
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterSeconds).toBe(30);
  });

  it('marks 5xx retryable and 4xx auth errors not retryable', () => {
    const server = classifyError('X', 503, { detail: 'unavailable' }, '', {});
    expect((server as ProviderError).retryable).toBe(true);

    for (const status of [400, 401, 403, 404, 422]) {
      const error = classifyError('X', status, { detail: 'nope' }, '', {});
      expect((error as ProviderError).retryable, `status ${status}`).toBe(false);
    }
  });

  it('never lets a token in the provider body reach the stored message', () => {
    const error = classifyError(
      'LinkedIn',
      401,
      { message: 'Invalid token Bearer AQV5P-1VTVVebnLl_SCiyMX' },
      '',
      {},
    );
    expect(error.message).not.toContain('AQV5P-1VTVVebnLl_SCiyMX');
  });
});
