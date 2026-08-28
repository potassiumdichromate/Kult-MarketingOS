import { ProviderError, RateLimitError } from '@kult/shared';

/**
 * Shared HTTP plumbing for first-party provider APIs.
 *
 * These hosts are fixed in code, so they bypass the SSRF guard (which exists for
 * input-supplied URLs). What they do need is uniform error classification: a 429
 * or 5xx is retryable, a 401/403 is not, and provider bodies must be sanitised
 * before they are stored or logged.
 */

export interface ProviderRequest {
  provider: string;
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | URLSearchParams | FormData;
  timeoutMs?: number;
  /** Treat these statuses as success and return the parsed body. */
  expectStatuses?: number[];
}

export interface ProviderResponse<T> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

/** Header names worth persisting for rate-limit observability. Never secrets. */
const INTERESTING_HEADERS = [
  'x-rate-limit-limit',
  'x-rate-limit-remaining',
  'x-rate-limit-reset',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'retry-after',
  'x-restli-id',
  'x-li-uuid',
  'x-request-id',
  'x-app-usage',
  'x-business-use-case-usage',
];

export async function providerRequest<T>(request: ProviderRequest): Promise<ProviderResponse<T>> {
  const {
    provider,
    url,
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 30_000,
    expectStatuses,
  } = request;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ProviderError(provider, `The request to ${provider} timed out.`, {
        retryable: true,
      });
    }
    // Socket/DNS failures are transient by nature.
    throw new ProviderError(provider, `Could not reach ${provider}.`, {
      retryable: true,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    clearTimeout(timer);
  }

  const collected: Record<string, string> = {};
  for (const name of INTERESTING_HEADERS) {
    const value = response.headers.get(name);
    if (value) collected[name] = value;
  }

  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('json') && text.length > 0 ? safeJsonParse<T>(text) : (text as T);

  const ok = expectStatuses
    ? expectStatuses.includes(response.status)
    : response.status >= 200 && response.status < 300;

  if (!ok) {
    throw classifyError(provider, response.status, data, text, collected);
  }

  return { status: response.status, data, headers: collected };
}

function safeJsonParse<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Maps a provider failure onto a typed error with the right retry semantics.
 *
 * The rule from the specification: 429 and 5xx and network failures retry;
 * 4xx authentication and permission failures never do.
 */
export function classifyError(
  provider: string,
  status: number,
  data: unknown,
  rawText: string,
  headers: Record<string, string>,
): ProviderError | RateLimitError {
  const message = sanitizeProviderMessage(extractMessage(data) ?? rawText);
  const code = extractCode(data);

  if (status === 429) {
    const retryAfter = Number(headers['retry-after'] ?? headers['x-rate-limit-reset'] ?? '');
    return new RateLimitError(
      `${provider} rate limit reached. ${message}`.trim(),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      { provider, status, headers },
    );
  }

  const retryable = status >= 500 || status === 408;

  return new ProviderError(provider, `${provider} request failed: ${message}`, {
    providerStatus: status,
    ...(code ? { providerCode: code } : {}),
    retryable,
    details: { headers },
  });
}

function extractMessage(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;

  // X: { title, detail, errors: [...] } | Meta: { error: { message } } | LinkedIn: { message }
  const candidates = [
    record.detail,
    record.message,
    record.error_description,
    (record.error as Record<string, unknown> | undefined)?.message,
    record.title,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function extractCode(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const candidates = [
    record.code,
    record.serviceErrorCode,
    (record.error as Record<string, unknown> | undefined)?.code,
    (record.error as Record<string, unknown> | undefined)?.type,
    record.error,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate);
  }
  return undefined;
}

/**
 * Strips anything token-shaped from a provider message before it is stored on a
 * Publication row or written to a log. Provider errors sometimes echo the
 * request, including the Authorization header.
 */
export function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/(access_token|refresh_token|client_secret|code_verifier)=([^&\s"']+)/gi, '$1=[redacted]')
    .replace(/"(access_token|refresh_token|client_secret)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .slice(0, 1_000);
}

/** Basic authorization header for confidential OAuth clients. */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}
