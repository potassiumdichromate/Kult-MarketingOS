'use client';

import { KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { useOrganization } from '@/lib/queries';
import { useSession } from '@/components/providers';
import { permissionsForRole } from '@kult/shared';
import { SettingsTabs } from '../page';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  PageHeader,
  Skeleton,
} from '@/components/ui';

/**
 * Security.
 *
 * Describes the guarantees the system actually provides, rather than offering
 * toggles for them. Authentication is Privy's, token encryption is unconditional,
 * and tenant isolation is enforced server-side — none of those are configurable,
 * and pretending otherwise would be misleading.
 */
export default function SecuritySettingsPage() {
  const organization = useOrganization();
  const { me, role } = useSession();

  if (organization.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (organization.error) {
    return <ErrorState error={organization.error} onRetry={() => void organization.refetch()} />;
  }

  const data = organization.data;
  if (!data) return null;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Settings" />
      <SettingsTabs />

      <div className="max-w-2xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Your access</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Signed in as</span>
              <span className="text-sm">{me?.user.email ?? me?.user.displayName ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Role</span>
              <Badge tone={role === 'OWNER' ? 'primary' : 'neutral'}>{role ?? data.yourRole}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Permissions</span>
              <span className="tabular text-sm">
                {permissionsForRole(role ?? data.yourRole).length}
              </span>
            </div>
            <details className="rounded-lg border border-border/50 p-3">
              <summary className="cursor-pointer text-sm">What your role can do</summary>
              <div className="mt-2 flex flex-wrap gap-1">
                {permissionsForRole(role ?? data.yourRole).map((permission) => (
                  <Badge key={permission}>{permission}</Badge>
                ))}
              </div>
            </details>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How this workspace is protected</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-4">
              {[
                {
                  icon: Lock,
                  title: 'Authentication is handled by Privy',
                  body:
                    'This application has no passwords of its own and never creates accounts. Every request carries a Privy access token, which the API verifies server-side before doing anything.',
                },
                {
                  icon: KeyRound,
                  title: 'Social tokens are encrypted at rest',
                  body:
                    'OAuth access and refresh tokens are sealed with AES-256-GCM before storage. They are never returned by the API, never logged, and never shown in this interface.',
                },
                {
                  icon: ShieldCheck,
                  title: 'Tenant isolation is enforced server-side',
                  body:
                    'Your organization is derived from your membership record, not from anything the browser sends. A record belonging to another organization is reported as not found rather than forbidden, so its existence is not disclosed.',
                },
                {
                  icon: ShieldCheck,
                  title: 'Every action is audited',
                  body:
                    'Logins, role changes, integration connections, approvals, publications and automation changes are all recorded with the actor, the resource, the IP and the time. Secrets are redacted before an audit entry is written.',
                },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.title} className="flex gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-raised">
                      <Icon className="h-4 w-4 text-accent" aria-hidden />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{item.body}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle>Encryption key</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Social tokens are encrypted with a key held only in the deployment environment. If
              that key is lost, every stored token becomes permanently unrecoverable and every
              social account must be reconnected. It should be backed up in a secret manager,
              separately from database backups.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
