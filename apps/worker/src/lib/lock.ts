import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Redis distributed lock.
 *
 * Guards the publishing critical section so two workers cannot post the same
 * content concurrently. The lock is one half of the double-publish defence; the
 * other half is the Publication idempotency key, which protects across restarts
 * and lock expiry.
 *
 * Correctness details that matter:
 *  - Acquisition is `SET key token NX PX ttl`, which is atomic.
 *  - The value is a random token, and release runs a Lua script that only
 *    deletes the key when the token still matches. Without that check, a worker
 *    whose lock had already expired could delete a lock now held by someone else.
 *  - `extend` exists because a slow provider call (Instagram container
 *    processing can take a minute) must not let the lock lapse mid-publish.
 */

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface Lock {
  key: string;
  token: string;
  release(): Promise<boolean>;
  extend(ttlMs: number): Promise<boolean>;
}

export async function acquireLock(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<Lock | null> {
  const token = randomUUID();
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') return null;

  return {
    key,
    token,
    async release(): Promise<boolean> {
      const result = await redis.eval(RELEASE_SCRIPT, 1, key, token);
      return result === 1;
    },
    async extend(nextTtlMs: number): Promise<boolean> {
      const result = await redis.eval(EXTEND_SCRIPT, 1, key, token, String(nextTtlMs));
      return result === 1;
    },
  };
}

/**
 * Runs `operation` while holding the lock, releasing it even if the operation
 * throws. Returns `notAcquired` when another worker already holds the lock -
 * the caller decides whether that is a no-op or a retry.
 */
export async function withLock<T>(
  redis: Redis,
  key: string,
  ttlMs: number,
  operation: (lock: Lock) => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const lock = await acquireLock(redis, key, ttlMs);
  if (!lock) return { acquired: false };

  try {
    const result = await operation(lock);
    return { acquired: true, result };
  } finally {
    await lock.release().catch(() => undefined);
  }
}
