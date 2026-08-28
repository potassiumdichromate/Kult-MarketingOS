import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ProviderError, ValidationError } from '@kult/shared';

/**
 * SSRF-hardened outbound HTTP for user- and model-supplied URLs.
 *
 * Any URL that originates outside the application - an RSS feed a user pasted,
 * a competitor page, a citation a model returned - is fetched through here.
 * Calls to first-party provider APIs use plain fetch, because their hosts are
 * fixed in code rather than supplied by input.
 *
 * Protections:
 *  - scheme allowlist (http/https only; blocks file:, gopher:, data:)
 *  - default port only, or an explicit safe-port allowlist
 *  - DNS resolution *before* connecting, with every resolved address checked
 *    against private, loopback, link-local, CGNAT, and cloud-metadata ranges
 *  - redirects followed manually so each hop is re-validated (DNS rebinding
 *    across a redirect cannot bypass the first check)
 *  - response size and total time caps
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export interface SafeFetchOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Hard ceiling on the response body. Default 5 MiB. */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Content types that may be returned. Anything else is rejected unread. */
  allowedContentTypes?: string[];
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

/** True when an IP literal falls inside a range that must never be reachable. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIPv4(address);
  if (version === 6) return isBlockedIPv6(address);
  return true; // Not a valid IP: treat as unsafe.
}

function isBlockedIPv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [a = 0, b = 0] = octets;

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIPv6(address: string): boolean {
  const normalised = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalised === '::' || normalised === '::1') return true; // unspecified, loopback

  // IPv4-mapped (::ffff:a.b.c.d) must be judged by its IPv4 value.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);

  if (normalised.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(normalised)) return true; // unique local fc00::/7
  if (normalised.startsWith('ff')) return true; // multicast
  if (normalised.startsWith('64:ff9b')) return true; // NAT64
  return false;
}

/**
 * Validates a URL's shape and resolves its host, rejecting any address in a
 * blocked range. Returns the parsed URL so callers can reuse it.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('The URL is malformed.', [{ path: 'url', message: 'Not a valid URL.' }]);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new ValidationError('Only http and https URLs may be fetched.', [
      { path: 'url', message: `Protocol "${url.protocol}" is not allowed.` },
    ]);
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new ValidationError('That port is not permitted for outbound fetches.', [
      { path: 'url', message: `Port "${url.port}" is not allowed.` },
    ]);
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.internal')) {
    throw new ValidationError('That host is not permitted.', [
      { path: 'url', message: `Host "${hostname}" is blocked.` },
    ]);
  }

  // An IP literal is checked directly; a name is resolved and every answer checked.
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new ValidationError('That address range is not permitted.', [
        { path: 'url', message: `Address "${hostname}" is in a blocked range.` },
      ]);
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new ValidationError('The host could not be resolved.', [
      { path: 'url', message: `DNS lookup failed for "${hostname}".` },
    ]);
  }

  if (addresses.length === 0) {
    throw new ValidationError('The host could not be resolved.', [
      { path: 'url', message: `No addresses for "${hostname}".` },
    ]);
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new ValidationError('That host resolves to a blocked address range.', [
        { path: 'url', message: `"${hostname}" resolves to ${address}, which is not permitted.` },
      ]);
    }
  }

  return url;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const {
    method = 'GET',
    headers = {},
    body,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = 15_000,
    maxRedirects = 3,
    allowedContentTypes,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = rawUrl;
    let response: Response | undefined;

    // Redirects are handled here so each hop is re-validated against the SSRF rules.
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const url = await assertPublicUrl(currentUrl);

      response = await fetch(url, {
        method,
        headers: {
          'user-agent': 'KultMarketingOS/1.0 (+https://app.kult.games)',
          accept: '*/*',
          ...headers,
        },
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal: controller.signal,
      });

      const isRedirect = response.status >= 300 && response.status < 400;
      if (!isRedirect) break;

      const location = response.headers.get('location');
      if (!location) break;
      if (hop === maxRedirects) {
        throw new ProviderError('http', 'Too many redirects while fetching the URL.', {
          providerStatus: response.status,
          retryable: false,
        });
      }
      currentUrl = new URL(location, currentUrl).toString();
    }

    if (!response) {
      throw new ProviderError('http', 'The request produced no response.', { retryable: true });
    }

    const contentType = response.headers.get('content-type');
    if (allowedContentTypes && contentType) {
      const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!allowedContentTypes.includes(base)) {
        throw new ValidationError(`Unsupported content type "${base}".`, [
          { path: 'url', message: `Expected one of: ${allowedContentTypes.join(', ')}.` },
        ]);
      }
    }

    // Reject oversized bodies on the declared length before reading anything.
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > maxBytes) {
      throw new ValidationError('The response is larger than the permitted size.', [
        { path: 'url', message: `${declaredLength} bytes exceeds the ${maxBytes} byte limit.` },
      ]);
    }

    const { text, truncated } = await readCapped(response, maxBytes);

    return {
      url: currentUrl,
      status: response.status,
      contentType,
      body: text,
      truncated,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ProviderError('http', `The request timed out after ${timeoutMs}ms.`, {
        retryable: true,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Streams the body, stopping once maxBytes have been read. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}
