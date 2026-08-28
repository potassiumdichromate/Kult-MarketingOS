'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AUTOMATION_MODES, CONTENT_TYPES } from '@kult/shared';
import { useOrganization, useUpdateOrganization } from '@/lib/queries';
import { formatContentType } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  cn,
} from '@/components/ui';

export const SETTINGS_TABS = [
  { href: '/app/settings', label: 'General' },
  { href: '/app/settings/team', label: 'Team' },
  { href: '/app/settings/brand', label: 'Brand' },
  { href: '/app/settings/security', label: 'Security' },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav className="mb-6 flex gap-1 border-b border-border/60">
      {SETTINGS_TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * General settings, including automation mode.
 *
 * Autopilot is deliberately awkward to enable: it needs an explicit content-type
 * allowlist as well as the mode, because publishing without a human is the one
 * irreversible thing this product does.
 */
export default function SettingsPage() {
  const organization = useOrganization();
  const update = useUpdateOrganization();

  const [name, setName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [timezone, setTimezone] = useState('');

  useEffect(() => {
    if (!organization.data) return;
    setName(organization.data.name);
    setWebsiteUrl(organization.data.websiteUrl ?? '');
    setTimezone(organization.data.timezone);
  }, [organization.data]);

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

  const canEdit = data.yourPermissions.includes('organization:update');

  return (
    <div className="animate-fade-in">
      <PageHeader title="Settings" />
      <SettingsTabs />

      <div className="max-w-2xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Organization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!canEdit}
              />
            </Field>
            <Field label="Website">
              <Input
                value={websiteUrl}
                onChange={(event) => setWebsiteUrl(event.target.value)}
                disabled={!canEdit}
                type="url"
              />
            </Field>
            <Field
              label="Timezone"
              hint="Scheduling, calendar rendering and posting-window analysis all use this."
            >
              <Input
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                disabled={!canEdit}
              />
            </Field>
            {canEdit ? (
              <Button
                variant="primary"
                loading={update.isPending}
                onClick={() =>
                  update.mutate({
                    name: name.trim(),
                    websiteUrl: websiteUrl.trim() || null,
                    timezone: timezone.trim(),
                  })
                }
              >
                Save
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Your role ({data.yourRole}) cannot change organization settings.
              </p>
            )}
          </CardContent>
        </Card>

        <AutomationCard
          mode={data.automationMode}
          allowed={data.autopilotContentTypes}
          canEdit={data.yourPermissions.includes('automation:configure')}
        />
      </div>
    </div>
  );
}

function AutomationCard({
  mode,
  allowed,
  canEdit,
}: {
  mode: string;
  allowed: string[];
  canEdit: boolean;
}) {
  const update = useUpdateOrganization();
  const [selectedMode, setSelectedMode] = useState(mode);

  useEffect(() => setSelectedMode(mode), [mode]);

  return (
    <Card className={mode === 'AUTOPILOT' ? 'border-warning/50' : undefined}>
      <CardHeader>
        <CardTitle>Automation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Approval mode">
          <Select
            value={selectedMode}
            onChange={(event) => setSelectedMode(event.target.value)}
            disabled={!canEdit}
          >
            {AUTOMATION_MODES.map((value) => (
              <option key={value} value={value}>
                {value === 'COPILOT'
                  ? 'Copilot — AI drafts, a human approves'
                  : value === 'MANUAL'
                    ? 'Manual — AI assists, never schedules or publishes'
                    : 'Autopilot — low-risk content publishes itself'}
              </option>
            ))}
          </Select>
        </Field>

        {selectedMode === 'AUTOPILOT' ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <div>
                <p className="text-sm font-medium text-warning">
                  Autopilot publishes without human review
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Even then, it only publishes content that is LOW risk, carries no flagged topics,
                  has every factual claim matched to an approved claim, uses an allowed content
                  type, and is within the daily publishing limit. Anything else still waits for a
                  person.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-sm font-medium">Autopilot content types</p>
          {allowed.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              None allowed. Autopilot cannot publish anything until a content type is added here —
              this is the safe default.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {allowed.map((type) => (
                <Badge key={type} tone="warning">
                  {formatContentType(type)}
                </Badge>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Content types are configured by an owner or admin. Available types:{' '}
            {CONTENT_TYPES.slice(0, 3).map(formatContentType).join(', ')} and others.
          </p>
        </div>

        {canEdit && selectedMode !== mode ? (
          <Button
            variant="primary"
            loading={update.isPending}
            onClick={() => update.mutate({ automationMode: selectedMode })}
          >
            Change mode
          </Button>
        ) : null}

        {!canEdit ? (
          <p className="text-xs text-muted-foreground">
            Changing automation mode requires the automation:configure permission.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
