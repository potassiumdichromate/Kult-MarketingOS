import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHash,
} from 'node:crypto';

/**
 * Authenticated encryption for secrets at rest (OAuth access/refresh tokens,
 * PKCE code verifiers).
 *
 * AES-256-GCM. The sealed format is:
 *
 *   v1.<base64url iv>.<base64url authTag>.<base64url ciphertext>
 *
 * The version prefix makes key rotation and algorithm migration possible without
 * ambiguity. GCM's auth tag means a tampered ciphertext fails to decrypt rather
 * than silently yielding garbage.
 */

const VERSION = 'v1';
const IV_BYTES = 12; // 96-bit nonce, the value GCM is specified for.
const KEY_BYTES = 32;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Accepts the key as 64-char hex or as base64; both must decode to 32 bytes. */
export function parseEncryptionKey(key: string): Buffer {
  const buffer = /^[0-9a-fA-F]{64}$/.test(key)
    ? Buffer.from(key, 'hex')
    : Buffer.from(key, 'base64');
  if (buffer.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; got ${buffer.length}. ` +
        'Generate one with: openssl rand -hex 32',
    );
  }
  return buffer;
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(encryptionKey: string) {
    this.key = parseEncryptionKey(encryptionKey);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(sealed: string): string {
    const parts = sealed.split('.');
    if (parts.length !== 4) {
      throw new DecryptionError('Malformed sealed value.');
    }
    const [version, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string];
    if (version !== VERSION) {
      throw new DecryptionError(`Unsupported sealed value version "${version}".`);
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(ivPart, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Never echo the underlying OpenSSL message; it varies and leaks nothing useful.
      throw new DecryptionError(
        'Unable to decrypt the stored secret. The value was tampered with, or ENCRYPTION_KEY ' +
          'differs from the key it was sealed with.',
      );
    }
  }

  /** Encrypts only when a value is present, so optional secrets stay optional. */
  encryptOptional(plaintext: string | null | undefined): string | null {
    return plaintext ? this.encrypt(plaintext) : null;
  }

  decryptOptional(sealed: string | null | undefined): string | null {
    return sealed ? this.decrypt(sealed) : null;
  }
}

/** Constant-time comparison for signatures and API keys. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Hash used to store API keys. The plaintext is shown once and never persisted. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/**
 * RFC 7636 PKCE pair. The verifier is 43-128 characters of the unreserved set;
 * 32 random bytes base64url-encoded yields 43.
 */
export function createPkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/** Opaque, high-entropy OAuth `state`. Bound to a row and single-use. */
export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}
