'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/components/providers';

/**
 * Entry point. Sends the visitor to the dashboard, to onboarding, or to login
 * depending on how far along they are.
 */
export default function IndexPage() {
  const router = useRouter();
  const { ready, authenticated, me, isLoading } = useSession();

  useEffect(() => {
    if (!ready || isLoading) return;
    if (!authenticated) {
      router.replace('/login');
      return;
    }
    if (me?.needsOrganization) {
      router.replace('/onboarding');
      return;
    }
    router.replace('/app/dashboard');
  }, [ready, authenticated, me, isLoading, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
    </div>
  );
}
