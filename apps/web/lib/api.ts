/**
 * Typed API client.
 *
 * Every authenticated request carries the Privy access token as a bearer
 * credential and the selected organization as a header. Neither is ever read
 * from local state on the server side - the API re-derives identity from the
 * token and re-checks membership, so this header is a selector, not a claim.
 *
 * The token getter is injected rather than imported, because it comes from a
 * React hook. `configureApi` is called once by the auth provider.
 */

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    issues?: Array<{ path: string; message: string }>;
    requiredVariables?: string[];
    provider?: string;
    capability?: string;
    requirement?: string;
  };
}

/**
 * A failed API call, carrying the server's stable error code and requestId.
 * The UI branches on `code`, never on message text.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly issues: Array<{ path: string; message: string }>;
  readonly requirement?: string;
  readonly requiredVariables?: string[];

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error.code;
    this.requestId = body.error.requestId;
    this.issues = body.error.issues ?? [];
    if (body.error.requirement) this.requirement = body.error.requirement;
    if (body.error.requiredVariables) this.requiredVariables = body.error.requiredVariables;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  /** The deployment is missing configuration, or the provider cannot do this. */
  get isCapabilityIssue(): boolean {
    return this.code === 'UNSUPPORTED_CAPABILITY' || this.code === 'NOT_CONFIGURED';
  }
}

type TokenGetter = () => Promise<string | null>;

let getToken: TokenGetter = async () => null;
let organizationId: string | null = null;

export function configureApi(options: {
  getAccessToken: TokenGetter;
  organizationId?: string | null;
}): void {
  getToken = options.getAccessToken;
  if (options.organizationId !== undefined) organizationId = options.organizationId;
}

export function setActiveOrganization(id: string | null): void {
  organizationId = id;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Skips the Authorization header. Only for genuinely public endpoints. */
  anonymous?: boolean;
  signal?: AbortSignal;
  /** Extra headers; used by /me to pass the Privy identity token. */
  headers?: Record<string, string>;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, anonymous = false, signal, headers = {} } = options;

  const requestHeaders: Record<string, string> = {
    accept: 'application/json',
    ...headers,
  };

  if (body !== undefined) requestHeaders['content-type'] = 'application/json';

  if (!anonymous) {
    const token = await getToken();
    if (token) requestHeaders.authorization = `Bearer ${token}`;
  }
  if (organizationId) requestHeaders['x-organization-id'] = organizationId;

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
    credentials: 'omit',
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text.length > 0 ? safeParse(text) : null;

  if (!response.ok) {
    if (isApiErrorBody(payload)) throw new ApiError(response.status, payload);
    // A non-JSON failure means something in front of the API answered - a proxy,
    // a gateway, or a network error. Surface it as an API error all the same so
    // callers have one failure type to handle.
    throw new ApiError(response.status, {
      error: {
        code: response.status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED',
        message:
          response.status === 0
            ? 'Could not reach the API.'
            : `The API returned ${response.status}.`,
        requestId: response.headers.get('x-request-id') ?? 'unknown',
      },
    });
  }

  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.code === 'string'
  );
}

/** Builds a query string, omitting empty values so URLs stay clean. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}
