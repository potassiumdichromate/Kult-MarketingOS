/**
 * Platform capability and constraint registry.
 *
 * Values are tagged with their provenance:
 *  - `documented`  : stated in the provider's current official API documentation.
 *  - `app-policy`  : a conservative limit this application enforces itself, either
 *                    because the provider does not publish a machine-readable limit
 *                    or because we choose to be stricter than the provider.
 *
 * Nothing in this file may assert a capability the provider does not actually
 * offer. Where an operation is impossible, `supported: false` carries the exact
 * requirement text surfaced to operators in the UI.
 *
 * Sources (verified 2026-08):
 *  - X            https://docs.x.com/x-api/posts/creation-of-a-post
 *  - Instagram    https://developers.facebook.com/docs/instagram-platform/content-publishing
 *  - LinkedIn     https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api
 */

export const SOCIAL_PROVIDERS = ['X', 'INSTAGRAM', 'LINKEDIN'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export const CONTENT_TYPES = [
  'X_POST',
  'X_THREAD',
  'INSTAGRAM_CAPTION',
  'INSTAGRAM_REEL',
  'INSTAGRAM_CAROUSEL',
  'LINKEDIN_POST',
  'LINKEDIN_ARTICLE',
  'REDDIT_POST',
  'DISCORD_POST',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export type Provenance = 'documented' | 'app-policy';

export interface Limit<T> {
  value: T;
  provenance: Provenance;
  note?: string;
}

export interface ContentTypeCapability {
  contentType: ContentType;
  provider: SocialProvider | null;
  /** Whether this application can publish this content type through the provider API. */
  publishable: boolean;
  /** Populated when `publishable` is false: exactly what is missing and why. */
  requirement?: string;
  /** Max characters for the primary body/caption field. */
  maxCharacters: Limit<number>;
  /** Max media attachments per post/container, if media is supported at all. */
  maxMediaItems: Limit<number>;
  /** Max hashtags this app will emit. */
  maxHashtags: Limit<number>;
  /** Requires an uploaded/hosted media asset before publishing can be attempted. */
  requiresMedia: boolean;
}

const X_TEXT_LIMIT: Limit<number> = {
  value: 280,
  provenance: 'app-policy',
  note:
    'X allows longer posts on some paid account tiers. 280 is enforced as the safe floor for all ' +
    'account types; the actual ceiling is not exposed per-account by the API.',
};

const CAPABILITIES: Record<ContentType, ContentTypeCapability> = {
  X_POST: {
    contentType: 'X_POST',
    provider: 'X',
    publishable: true,
    maxCharacters: X_TEXT_LIMIT,
    maxMediaItems: {
      value: 4,
      provenance: 'documented',
      note: 'POST /2/tweets media.media_ids accepts 1-4 items.',
    },
    maxHashtags: { value: 5, provenance: 'app-policy' },
    requiresMedia: false,
  },
  X_THREAD: {
    contentType: 'X_THREAD',
    provider: 'X',
    publishable: true,
    maxCharacters: X_TEXT_LIMIT,
    maxMediaItems: { value: 4, provenance: 'documented', note: 'Per individual post in the thread.' },
    maxHashtags: { value: 5, provenance: 'app-policy' },
    requiresMedia: false,
  },
  INSTAGRAM_CAPTION: {
    contentType: 'INSTAGRAM_CAPTION',
    provider: 'INSTAGRAM',
    publishable: true,
    maxCharacters: {
      value: 2_200,
      provenance: 'app-policy',
      note: 'Enforced client-side; the Content Publishing API does not publish a caption limit.',
    },
    maxMediaItems: { value: 1, provenance: 'documented', note: 'Single image or video container.' },
    maxHashtags: { value: 30, provenance: 'app-policy' },
    requiresMedia: true,
  },
  INSTAGRAM_REEL: {
    contentType: 'INSTAGRAM_REEL',
    provider: 'INSTAGRAM',
    publishable: true,
    maxCharacters: { value: 2_200, provenance: 'app-policy' },
    maxMediaItems: { value: 1, provenance: 'documented' },
    maxHashtags: { value: 30, provenance: 'app-policy' },
    requiresMedia: true,
  },
  INSTAGRAM_CAROUSEL: {
    contentType: 'INSTAGRAM_CAROUSEL',
    provider: 'INSTAGRAM',
    publishable: true,
    maxCharacters: { value: 2_200, provenance: 'app-policy' },
    maxMediaItems: {
      value: 10,
      provenance: 'documented',
      note: 'Carousels are limited to 10 images, videos, or a mix of the two.',
    },
    maxHashtags: { value: 30, provenance: 'app-policy' },
    requiresMedia: true,
  },
  LINKEDIN_POST: {
    contentType: 'LINKEDIN_POST',
    provider: 'LINKEDIN',
    publishable: true,
    maxCharacters: {
      value: 3_000,
      provenance: 'app-policy',
      note: 'LinkedIn returns FIELD_LENGTH_TOO_LONG rather than publishing a numeric limit.',
    },
    maxMediaItems: { value: 20, provenance: 'app-policy', note: 'MultiImage post via the Images API.' },
    maxHashtags: { value: 5, provenance: 'app-policy' },
    requiresMedia: false,
  },
  LINKEDIN_ARTICLE: {
    contentType: 'LINKEDIN_ARTICLE',
    provider: 'LINKEDIN',
    publishable: true,
    maxCharacters: { value: 3_000, provenance: 'app-policy', note: 'Applies to the post commentary.' },
    maxMediaItems: { value: 1, provenance: 'documented', note: 'A single article thumbnail image URN.' },
    maxHashtags: { value: 5, provenance: 'app-policy' },
    requiresMedia: false,
  },
  REDDIT_POST: {
    contentType: 'REDDIT_POST',
    provider: null,
    publishable: false,
    requirement:
      'Reddit is available as a research source only. No Reddit publishing integration is configured ' +
      'in this deployment, so Reddit content can be drafted and exported but not published from here.',
    maxCharacters: { value: 40_000, provenance: 'app-policy' },
    maxMediaItems: { value: 0, provenance: 'app-policy' },
    maxHashtags: { value: 0, provenance: 'app-policy' },
    requiresMedia: false,
  },
  DISCORD_POST: {
    contentType: 'DISCORD_POST',
    provider: null,
    publishable: false,
    requirement:
      'Discord publishing requires a bot token and channel configuration that this deployment does ' +
      'not define. Discord content can be drafted and exported but not published from here.',
    maxCharacters: { value: 2_000, provenance: 'app-policy' },
    maxMediaItems: { value: 0, provenance: 'app-policy' },
    maxHashtags: { value: 0, provenance: 'app-policy' },
    requiresMedia: false,
  },
};

export function getCapability(contentType: ContentType): ContentTypeCapability {
  const capability = CAPABILITIES[contentType];
  if (!capability) throw new Error(`Unknown content type: ${contentType}`);
  return capability;
}

export function contentTypesForProvider(provider: SocialProvider): ContentType[] {
  return CONTENT_TYPES.filter((type) => CAPABILITIES[type].provider === provider);
}

export function allCapabilities(): ContentTypeCapability[] {
  return CONTENT_TYPES.map((type) => CAPABILITIES[type]);
}

/** Documented hard ceilings the publishing worker must respect. */
export const PROVIDER_PUBLISHING_LIMITS = {
  INSTAGRAM: {
    postsPer24h: {
      value: 100,
      provenance: 'documented' as Provenance,
      note: 'Instagram accounts are limited to 100 API-published posts within a 24-hour moving period. A carousel counts as one post.',
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ContentViolation {
  field: 'body' | 'hashtags' | 'media' | 'contentType' | 'thread';
  code:
    | 'TOO_LONG'
    | 'TOO_MANY'
    | 'REQUIRED'
    | 'EMPTY'
    | 'NOT_PUBLISHABLE';
  message: string;
}

export interface ContentToValidate {
  contentType: ContentType;
  body: string;
  hashtags?: string[];
  mediaCount?: number;
  /** For X_THREAD: the individual post bodies, in order. */
  threadParts?: string[];
}

/**
 * Structural validation against platform constraints.
 *
 * `forPublishing` additionally enforces rules that only matter at publish time,
 * such as required media and provider publishability. Drafts are allowed to be
 * incomplete; publications are not.
 */
export function validateContent(
  input: ContentToValidate,
  { forPublishing = false }: { forPublishing?: boolean } = {},
): ContentViolation[] {
  const capability = getCapability(input.contentType);
  const violations: ContentViolation[] = [];

  if (forPublishing && !capability.publishable) {
    violations.push({
      field: 'contentType',
      code: 'NOT_PUBLISHABLE',
      message: capability.requirement ?? `${input.contentType} cannot be published from this deployment.`,
    });
  }

  if (input.contentType === 'X_THREAD') {
    const parts = input.threadParts ?? [];
    if (parts.length === 0) {
      violations.push({
        field: 'thread',
        code: 'EMPTY',
        message: 'A thread must contain at least one post.',
      });
    }
    parts.forEach((part, index) => {
      if (part.trim().length === 0) {
        violations.push({
          field: 'thread',
          code: 'EMPTY',
          message: `Thread post ${index + 1} is empty.`,
        });
      }
      if (countCharacters(part) > capability.maxCharacters.value) {
        violations.push({
          field: 'thread',
          code: 'TOO_LONG',
          message:
            `Thread post ${index + 1} is ${countCharacters(part)} characters; ` +
            `the limit is ${capability.maxCharacters.value}.`,
        });
      }
    });
  } else {
    if (input.body.trim().length === 0) {
      violations.push({ field: 'body', code: 'EMPTY', message: 'Content body is empty.' });
    }
    const length = countCharacters(input.body);
    if (length > capability.maxCharacters.value) {
      violations.push({
        field: 'body',
        code: 'TOO_LONG',
        message: `Content is ${length} characters; the limit for ${input.contentType} is ${capability.maxCharacters.value}.`,
      });
    }
  }

  const hashtags = input.hashtags ?? [];
  if (hashtags.length > capability.maxHashtags.value) {
    violations.push({
      field: 'hashtags',
      code: 'TOO_MANY',
      message: `${hashtags.length} hashtags supplied; the limit for ${input.contentType} is ${capability.maxHashtags.value}.`,
    });
  }

  const mediaCount = input.mediaCount ?? 0;
  if (mediaCount > capability.maxMediaItems.value) {
    violations.push({
      field: 'media',
      code: 'TOO_MANY',
      message: `${mediaCount} media items supplied; the limit for ${input.contentType} is ${capability.maxMediaItems.value}.`,
    });
  }
  if (forPublishing && capability.requiresMedia && mediaCount === 0) {
    violations.push({
      field: 'media',
      code: 'REQUIRED',
      message: `${input.contentType} requires at least one media asset before it can be published.`,
    });
  }

  return violations;
}

/**
 * Counts characters the way social platforms do: by Unicode code point, so that
 * emoji and astral-plane characters are not double counted the way `.length` does.
 */
export function countCharacters(text: string): number {
  return [...text].length;
}
