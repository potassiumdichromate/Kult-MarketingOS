import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';

/**
 * The minimum a process needs to boot. Everything else in the schema is
 * optional or defaulted.
 */
function baseEnv(): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'staging',
    NODE_ENV: 'production',
    WEB_URL: 'http://localhost:3000',
    API_URL: 'http://localhost:4000',
    DATABASE_URL: 'postgresql://kult:kult@postgres:5432/kult_marketing',
    REDIS_URL: 'redis://redis:6379',
    PRIVY_APP_ID: 'app-id',
    PRIVY_APP_SECRET: 'app-secret',
    ENCRYPTION_KEY: 'a'.repeat(64),
    OPENAI_API_KEY: 'sk-test',
    OPENAI_DEFAULT_MODEL: 'gpt-5',
    OPENAI_FAST_MODEL: 'gpt-5-mini',
    OPENAI_REASONING_MODEL: 'gpt-5',
    OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
  };
}

describe('loadConfig', () => {
  it('loads when only the required variables are present', () => {
    expect(() => loadConfig(baseEnv())).not.toThrow();
  });

  /**
   * Regression: Compose renders an absent `${VAR:-}` as an empty string rather
   * than omitting it. Optional URL variables then reached their format check as
   * `''` and threw, crash-looping the API and worker at startup over variables
   * the deployment never set. Empty must mean absent.
   */
  it('treats empty optional variables as absent rather than invalid', () => {
    const env = {
      ...baseEnv(),
      OPENAI_BASE_URL: '',
      STORAGE_ENDPOINT: '',
      STORAGE_PUBLIC_BASE_URL: '',
      X_REDIRECT_URI: '',
      META_REDIRECT_URI: '',
      LINKEDIN_REDIRECT_URI: '',
      SENTRY_DSN: '',
    };

    const config = loadConfig(env);

    expect(config.storage).toBeUndefined();
    expect(config.observability.sentryDsn).toBeUndefined();
  });

  it('still rejects an optional variable that is set to a malformed value', () => {
    expect(() => loadConfig({ ...baseEnv(), OPENAI_BASE_URL: 'not-a-url' })).toThrow(
      /OPENAI_BASE_URL/,
    );
  });

  it('rejects a whitespace-only value the same as an empty one', () => {
    expect(() => loadConfig({ ...baseEnv(), X_REDIRECT_URI: '   ' })).not.toThrow();
  });

  it('reports every problem at once rather than stopping at the first', () => {
    let message = '';
    try {
      loadConfig({ ...baseEnv(), ENCRYPTION_KEY: 'too-short', OPENAI_API_KEY: '' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/ENCRYPTION_KEY/);
    expect(message).toMatch(/OPENAI_API_KEY/);
  });
});
