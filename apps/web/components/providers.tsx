'use client';

import { PrivyProvider, useIdentityToken, usePrivy } from '@privy-io/react-auth';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Toaster } from 'sonner';
import { ApiError, apiRequest, configureApi, setActiveOrganization } from '@/lib/api';
import type { MeResponse, OrganizationRole, Permission } from '@/lib/types';

/**
 * Application providers.
 *
 * Auth flows in one direction only: Privy authenticates the person and issues an
 * access token; the API verifies that token and tells us who they are and what
 * they may do. The frontend never decides identity or permissions - it only
 * renders what the server already decided. `useCan` exists to hide controls the
 * user cannot use, not to protect anything.
 */

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? '';

interface SessionValue {
  ready: boolean;
  authenticated: boolean;
  me: MeResponse | null;
  organizationId: string | null;
  role: OrganizationRole | null;
  permissions: Permission[];
  setOrganizationId: (id: string) => void;
  refetchMe: () => void;
  logout: () => void;
  isLoading: boolean;
  error: ApiError | null;
}

const SessionContext = createContext<SessionValue | null>(null);

const ORGANIZATION_STORAGE_KEY = 'kult.activeOrganizationId';

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // Re-requesting a 401 or 403 will not change the answer.
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
            return false;
          }
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const { identityToken } = useIdentityToken();
  const [organizationId, setOrganizationIdState] = useState<string | null>(null);

  // Wire the API client to Privy's token before any query runs.
  useEffect(() => {
    configureApi({ getAccessToken, organizationId });
  }, [getAccessToken, organizationId]);

  // Restore the previously selected organization for multi-org users.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(ORGANIZATION_STORAGE_KEY);
    if (stored) {
      setOrganizationIdState(stored);
      setActiveOrganization(stored);
    }
  }, []);

  const meQuery = useQuery({
    queryKey: ['me'],
    enabled: ready && authenticated,
    queryFn: () =>
      apiRequest<MeResponse>('/api/v1/me', {
        // The identity token is optional; it lets the API enrich the profile
        // with linked-account details without an extra rate-limited call.
        ...(identityToken ? { headers: { 'x-privy-id-token': identityToken } } : {}),
      }),
  });

  const me = meQuery.data ?? null;

  // Default to the first membership when nothing is selected or the stored
  // selection is no longer valid (removed from that organization).
  useEffect(() => {
    if (!me) return;
    const valid = me.organizations.some((org) => org.id === organizationId);
    if (!valid) {
      const next = me.organizations[0]?.id ?? null;
      setOrganizationIdState(next);
      setActiveOrganization(next);
      if (typeof window !== 'undefined') {
        if (next) window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, next);
        else window.localStorage.removeItem(ORGANIZATION_STORAGE_KEY);
      }
    }
  }, [me, organizationId]);

  const setOrganizationId = (id: string): void => {
    setOrganizationIdState(id);
    setActiveOrganization(id);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ORGANIZATION_STORAGE_KEY, id);
    }
  };

  const activeMembership = me?.organizations.find((org) => org.id === organizationId) ?? null;

  const value = useMemo<SessionValue>(
    () => ({
      ready,
      authenticated,
      me,
      organizationId,
      role: activeMembership?.role ?? null,
      // Permissions come from GET /organization, which knows the role. Until it
      // loads, an empty list means controls stay hidden rather than flashing.
      permissions: [],
      setOrganizationId,
      refetchMe: () => void meQuery.refetch(),
      logout: () => {
        if (typeof window !== 'undefined') {
          window.localStorage.removeItem(ORGANIZATION_STORAGE_KEY);
        }
        void logout();
      },
      isLoading: !ready || (authenticated && meQuery.isLoading),
      error: meQuery.error instanceof ApiError ? meQuery.error : null,
    }),
    [ready, authenticated, me, organizationId, activeMembership, meQuery, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <Providers>.');
  return context;
}

export function Providers({ children }: { children: ReactNode }): ReactNode {
  const [queryClient] = useState(makeQueryClient);
  const [mounted, setMounted] = useState(false);

  // Privy validates its app ID as soon as the provider is constructed, which
  // fails during static prerendering where no browser environment exists. The
  // whole application sits behind authentication and is client-rendered anyway,
  // so the provider tree is mounted only after hydration.
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    );
  }

  if (!PRIVY_APP_ID) {
    // A missing app id would otherwise surface as an opaque Privy failure.
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-destructive/40 bg-surface p-6">
          <h1 className="font-display text-lg font-semibold text-destructive">
            Authentication is not configured
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            <code className="tabular text-accent">NEXT_PUBLIC_PRIVY_APP_ID</code> is not set, so the
            application cannot sign anyone in. Set it in the web deployment&apos;s environment and
            rebuild.
          </p>
        </div>
      </div>
    );
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: 'dark',
          accentColor: '#9a35ff',
          logo: undefined,
          walletChainType: 'ethereum-only',
        },
        // Login methods are configured in the Privy dashboard. Listing them here
        // would override that and could offer a method the app has not enabled.
        embeddedWallets: { ethereum: { createOnLogin: 'off' } },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <SessionProvider>{children}</SessionProvider>
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: 'hsl(220 45% 10%)',
              border: '1px solid hsl(210 25% 20%)',
              color: 'hsl(210 20% 93%)',
            },
          }}
        />
      </QueryClientProvider>
    </PrivyProvider>
  );
}

/**
 * Redirects unauthenticated visitors to the login page.
 * Purely cosmetic: the API rejects unauthenticated requests regardless.
 */
export function useRequireAuth(): { ready: boolean; authenticated: boolean } {
  const { ready, authenticated } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (ready && !authenticated && pathname !== '/login') {
      router.replace('/login');
    }
  }, [ready, authenticated, pathname, router]);

  return { ready, authenticated };
}
