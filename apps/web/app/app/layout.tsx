'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { useSession } from '@/components/providers';

/**
 * Authenticated layout.
 *
 * The redirects here are convenience, not security: the API rejects every
 * unauthenticated or non-member request on its own.
 */
export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { ready, authenticated, me, isLoading } = useSession();

  useEffect(() => {
    if (!ready || isLoading) return;
    if (!authenticated) router.replace('/login');
    else if (me?.needsOrganization) router.replace('/onboarding');
  }, [ready, authenticated, me, isLoading, router]);

  if (!ready || isLoading || !authenticated || me?.needsOrganization) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}
