'use client';

import { useLogin } from '@privy-io/react-auth';
import { BarChart3, Bot, Sparkles, TrendingUp } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/components/providers';
import { Button } from '@/components/ui';

/**
 * Sign-in.
 *
 * Authentication is entirely Privy's: there is no password, no registration
 * form, and no separate account for this application. Whatever login methods the
 * Privy dashboard enables are what the modal offers.
 */
export default function LoginPage() {
  const router = useRouter();
  const { ready, authenticated, me, isLoading } = useSession();
  const { login } = useLogin();

  // Once authenticated, decide where they belong.
  useEffect(() => {
    if (!ready || !authenticated || isLoading) return;
    if (me?.needsOrganization) router.replace('/onboarding');
    else if (me) router.replace('/app/dashboard');
  }, [ready, authenticated, me, isLoading, router]);

  return (
    <div className="flex min-h-screen">
      {/* Sign-in panel */}
      <div className="flex w-full flex-col justify-center px-6 py-12 lg:w-[46%] lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary shadow-[0_0_24px_hsl(278_88%_58%/0.5)]">
              <Sparkles className="h-5 w-5 text-primary-foreground" aria-hidden />
            </div>
            <div>
              <h1 className="font-display text-xl font-bold tracking-tight">Kult Marketing OS</h1>
              <p className="text-sm text-muted-foreground">
                AI-powered marketing intelligence and automation for Kult.
              </p>
            </div>
          </div>

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={() => login()}
            disabled={!ready}
            loading={!ready || (authenticated && isLoading)}
          >
            {authenticated ? 'Signing you in' : 'Continue with Kult'}
          </Button>

          <p className="mt-4 text-xs text-muted-foreground">
            Sign in with the method your team has enabled. This is an internal tool for the Kult
            marketing team; access is granted per organization.
          </p>

          <div className="mt-10 border-t border-border/60 pt-6">
            <p className="text-xs text-muted-foreground">
              Trouble signing in? Your account needs to be added to an organization by an owner or
              admin before you can use the workspace.
            </p>
          </div>
        </div>
      </div>

      {/* Product framing. Hidden on small screens where it would just push the
          sign-in button below the fold. */}
      <div className="relative hidden flex-1 items-center justify-center overflow-hidden border-l border-border/60 lg:flex">
        <div
          className="absolute inset-0 opacity-60"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 60% 30%, hsl(278 88% 40% / 0.28), transparent), radial-gradient(ellipse 50% 40% at 30% 80%, hsl(198 92% 45% / 0.18), transparent)',
          }}
          aria-hidden
        />
        <div className="relative z-10 max-w-md px-12">
          <h2 className="font-display text-3xl font-bold leading-tight">
            Find what to say. <span className="text-gradient">Say it well.</span> Learn what worked.
          </h2>
          <p className="mt-4 text-sm text-muted-foreground">
            Research across the web, Reddit, YouTube and X. Scored trends with real sources behind
            them. Platform-native content grounded in what Kult has actually approved.
          </p>

          <ul className="mt-8 space-y-4">
            {[
              {
                icon: TrendingUp,
                title: 'Trends with evidence',
                body: 'Every score is arithmetic over measured signals, and every trend links to the sources behind it.',
              },
              {
                icon: Bot,
                title: 'Agents you can audit',
                body: 'Each AI decision records its model, tokens, tool calls and latency.',
              },
              {
                icon: BarChart3,
                title: 'Honest measurement',
                body: 'Metrics a platform does not report are shown as unavailable, never as zero.',
              },
            ].map((feature) => {
              const Icon = feature.icon;
              return (
                <li key={feature.title} className="flex gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
                    <Icon className="h-4 w-4 text-accent" aria-hidden />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{feature.title}</p>
                    <p className="text-xs text-muted-foreground">{feature.body}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
