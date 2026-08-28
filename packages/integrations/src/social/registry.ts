import type { AppConfig } from '@kult/config';
import { NotConfiguredError, type SocialProvider as ProviderName } from '@kult/shared';
import type { StorageAdapter } from '../storage.js';
import { InstagramProvider } from './instagram.js';
import { LinkedInProvider } from './linkedin.js';
import type { SocialProviderAdapter } from './provider.js';
import { XProvider } from './x.js';

/**
 * Resolves provider adapters from configuration.
 *
 * Every provider is always constructed, so the integrations UI can list all
 * three and show, per provider, whether this deployment has credentials for it.
 * Attempting to use an unconfigured provider raises NotConfiguredError naming
 * the exact environment variables required.
 */
export class SocialProviderRegistry {
  private readonly providers: Map<ProviderName, SocialProviderAdapter>;

  constructor(config: AppConfig, storage: StorageAdapter) {
    this.providers = new Map<ProviderName, SocialProviderAdapter>([
      ['X', new XProvider(config.social.x)],
      [
        'INSTAGRAM',
        new InstagramProvider(config.social.meta, (key) => storage.publicUrl(key)),
      ],
      ['LINKEDIN', new LinkedInProvider(config.social.linkedin)],
    ]);
  }

  get(provider: ProviderName): SocialProviderAdapter {
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw new NotConfiguredError(`The ${provider} integration`, []);
    }
    return adapter;
  }

  /** Throws unless the provider has full credentials configured. */
  getConfigured(provider: ProviderName): SocialProviderAdapter {
    const adapter = this.get(provider);
    if (!adapter.configured) {
      throw new NotConfiguredError(`The ${provider} integration`, requiredVariables(provider));
    }
    return adapter;
  }

  all(): SocialProviderAdapter[] {
    return [...this.providers.values()];
  }
}

export function requiredVariables(provider: ProviderName): string[] {
  switch (provider) {
    case 'X':
      return ['X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_REDIRECT_URI'];
    case 'INSTAGRAM':
      return ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI'];
    case 'LINKEDIN':
      return ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_REDIRECT_URI'];
  }
}
