'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Link2,
  Plug,
  RefreshCw,
  ShieldAlert,
  Unplug,
} from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { toast } from 'sonner';
import {
  useConnectProvider,
  useDisconnectProvider,
  useIntegrations,
  useValidateConnection,
} from '@/lib/queries';
import { formatContentType, relativeTime } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  PageHeader,
  Skeleton,
  statusTone,
} from '@/components/ui';

export default function IntegrationsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <Integrations />
    </Suspense>
  );
}

/**
 * Integrations.
 *
 * This screen is where the product's honesty about provider limits becomes
 * visible. Each connection reports exactly what it can and cannot do, and every
 * "cannot" comes with the specific reason and the fix — a missing scope, an
 * account type, a LinkedIn product approval, an unset environment variable.
 */
function Integrations() {
  const searchParams = useSearchParams();
  const integrations = useIntegrations();
  const connect = useConnectProvider();
  const validate = useValidateConnection();
  const disconnect = useDisconnectProvider();

  // The OAuth callback redirects back here with an outcome.
  useEffect(() => {
    const status = searchParams.get('status');
    const provider = searchParams.get('provider');
    if (status === 'connected' && provider) {
      toast.success(`${provider} connected.`);
    } else if (status === 'error') {
      const reason = searchParams.get('reason');
      toast.error(`Could not connect ${provider ?? 'the account'}.`, {
        description:
          reason === 'declined'
            ? 'Authorization was declined.'
            : reason === 'missing_parameters'
              ? 'The provider did not return the expected parameters.'
              : 'The authorization could not be completed. Try again.',
      });
    }
  }, [searchParams]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Integrations"
        description="Connected accounts, the capabilities each one actually has, and what is missing."
      />

      {integrations.isLoading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-48" />
          ))}
        </div>
      ) : integrations.error ? (
        <ErrorState error={integrations.error} onRetry={() => void integrations.refetch()} />
      ) : (
        <div className="space-y-4">
          {(integrations.data?.providers ?? []).map((provider) => (
            <Card key={provider.provider}>
              <CardHeader className="flex-row items-start justify-between">
                <div>
                  <CardTitle>{provider.provider}</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Requests: {provider.requestedScopes.join(', ')}
                  </p>
                </div>
                {provider.configured ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      connect.mutate({
                        provider: provider.provider,
                        redirectPath: '/app/integrations',
                      })
                    }
                    loading={connect.isPending}
                  >
                    <Link2 className="h-3.5 w-3.5" aria-hidden />
                    {provider.connections.length > 0 ? 'Connect another' : 'Connect'}
                  </Button>
                ) : null}
              </CardHeader>

              <CardContent>
                {/* Deployment has no credentials for this provider. */}
                {!provider.configured ? (
                  <div className="rounded-lg border border-border/60 bg-surface-raised/40 p-3">
                    <div className="flex items-start gap-2">
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div>
                        <p className="text-sm">
                          {provider.configurationRequirement?.message ??
                            'This integration is not configured on this deployment.'}
                        </p>
                        {provider.configurationRequirement?.requiredVariables?.length ? (
                          <p className="tabular mt-1.5 text-xs text-accent">
                            {provider.configurationRequirement.requiredVariables.join(', ')}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : provider.connections.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No {provider.provider} account connected.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {provider.connections.map((connection) => {
                      const unavailable = Object.entries(connection.capabilities.unavailable ?? {});
                      const healthy = connection.status === 'ACTIVE' && !connection.tokenExpired;

                      return (
                        <li
                          key={connection.id}
                          className="rounded-lg border border-border/50 p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                {healthy ? (
                                  <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                                ) : (
                                  <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
                                )}
                                <p className="text-sm font-medium">{connection.accountName}</p>
                                {connection.accountUsername ? (
                                  <span className="text-xs text-muted-foreground">
                                    @{connection.accountUsername}
                                  </span>
                                ) : null}
                                <Badge tone={statusTone(connection.status)}>
                                  {connection.status}
                                </Badge>
                                {connection.tokenExpired ? (
                                  <Badge tone="danger">token expired</Badge>
                                ) : null}
                              </div>

                              <p className="tabular mt-1 text-xs text-muted-foreground">
                                {connection.lastValidatedAt
                                  ? `checked ${relativeTime(connection.lastValidatedAt)}`
                                  : 'never checked'}
                                {connection.expiresAt
                                  ? ` · expires ${relativeTime(connection.expiresAt)}`
                                  : ''}
                              </p>

                              {connection.lastErrorMessage ? (
                                <p className="mt-1.5 text-xs text-destructive">
                                  {connection.lastErrorMessage}
                                </p>
                              ) : null}
                            </div>

                            <div className="flex gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  validate.mutate({
                                    provider: provider.provider,
                                    connectionId: connection.id,
                                  })
                                }
                                loading={validate.isPending}
                              >
                                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                                Check
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive"
                                onClick={() =>
                                  disconnect.mutate({
                                    provider: provider.provider,
                                    connectionId: connection.id,
                                  })
                                }
                                loading={disconnect.isPending}
                              >
                                <Unplug className="h-3.5 w-3.5" aria-hidden />
                                Disconnect
                              </Button>
                            </div>
                          </div>

                          {/* What this connection can publish */}
                          <div className="mt-3 border-t border-border/40 pt-3">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Can publish
                            </p>
                            {connection.capabilities.publishableContentTypes?.length ? (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {connection.capabilities.publishableContentTypes.map((type) => (
                                  <Badge key={type} tone="success">
                                    {formatContentType(type)}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <p className="mt-1 text-xs text-warning">
                                Nothing. See the limitations below.
                              </p>
                            )}
                          </div>

                          {/* What it cannot do, and precisely why */}
                          {unavailable.length > 0 ? (
                            <div className="mt-3">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Limitations
                              </p>
                              <ul className="mt-1.5 space-y-1.5">
                                {unavailable.map(([capability, reason]) => (
                                  <li
                                    key={capability}
                                    className="rounded-md border border-border/40 bg-surface-sunken/40 p-2"
                                  >
                                    <p className="text-xs font-medium">{capability}</p>
                                    <p className="mt-0.5 text-xs text-muted-foreground">{reason}</p>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          {connection.capabilities.missingScopes?.length ? (
                            <p className="tabular mt-2 text-xs text-warning">
                              Missing scopes: {connection.capabilities.missingScopes.join(', ')}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}

          <Card className="border-dashed">
            <CardContent className="pt-5">
              <div className="flex items-start gap-2">
                <Plug className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <p className="text-xs text-muted-foreground">
                  Tokens are encrypted at rest with AES-256-GCM and are never returned by the API or
                  shown in this interface. Disconnecting deletes the stored tokens immediately;
                  where the provider offers revocation, it is also revoked on their side.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
