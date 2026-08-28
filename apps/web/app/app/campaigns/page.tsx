'use client';

import { Megaphone, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CAMPAIGN_TEMPLATES, SOCIAL_PROVIDERS } from '@kult/shared';
import { useCampaigns, useCreateCampaign } from '@/lib/queries';
import { formatEnum } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  cn,
  statusTone,
} from '@/components/ui';

export default function CampaignsPage() {
  const router = useRouter();
  const campaigns = useCampaigns({ limit: 50 });
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Campaigns"
        description="A goal becomes a strategy, content pillars, a platform split and a dated calendar of drafts."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            New campaign
          </Button>
        }
      />

      {campaigns.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-40" />
          ))}
        </div>
      ) : campaigns.error ? (
        <ErrorState error={campaigns.error} onRetry={() => void campaigns.refetch()} />
      ) : (campaigns.data ?? []).length === 0 ? (
        <EmptyState
          icon={<Megaphone className="h-8 w-8" />}
          title="No campaigns"
          description="Describe a goal and the campaign agent produces the strategy and a calendar of drafts you can edit before anything is scheduled."
          action={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              Create a campaign
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(campaigns.data ?? []).map((campaign) => (
            <Link key={campaign.id} href={`/app/campaigns/${campaign.id}`} className="group">
              <Card className="h-full transition-colors group-hover:border-primary/40">
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-display text-base font-semibold">{campaign.name}</h2>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {campaign.objective}
                      </p>
                    </div>
                    <Badge tone={statusTone(campaign.status)}>{campaign.status}</Badge>
                  </div>

                  <div className="tabular mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      {new Date(campaign.startDate).toLocaleDateString()} –{' '}
                      {new Date(campaign.endDate).toLocaleDateString()}
                    </span>
                    <span>·</span>
                    <span>{campaign._count.contentItems} pieces</span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {campaign.platforms.map((platform) => (
                      <Badge key={platform} tone="accent">
                        {platform}
                      </Badge>
                    ))}
                    {campaign.template ? <Badge>{formatEnum(campaign.template)}</Badge> : null}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <CreateCampaignModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => router.push(`/app/campaigns/${id}`)}
      />
    </div>
  );
}

function CreateCampaignModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const createCampaign = useCreateCampaign();

  const today = new Date().toISOString().slice(0, 10);
  const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

  const [form, setForm] = useState({
    name: '',
    objective: '',
    template: '',
    startDate: today,
    endDate: inTwoWeeks,
    platforms: ['X'] as string[],
  });

  function togglePlatform(platform: string): void {
    setForm((current) => ({
      ...current,
      platforms: current.platforms.includes(platform)
        ? current.platforms.filter((value) => value !== platform)
        : [...current.platforms, platform],
    }));
  }

  function handleSubmit(): void {
    createCampaign.mutate(
      {
        name: form.name.trim(),
        objective: form.objective.trim(),
        ...(form.template ? { template: form.template } : {}),
        startDate: new Date(form.startDate).toISOString(),
        endDate: new Date(form.endDate).toISOString(),
        platforms: form.platforms,
      },
      {
        onSuccess: (campaign) => {
          onOpenChange(false);
          onCreated(campaign.id);
        },
      },
    );
  }

  const valid =
    form.name.trim().length >= 2 &&
    form.objective.trim().length >= 3 &&
    form.platforms.length > 0 &&
    new Date(form.endDate) > new Date(form.startDate);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New campaign"
      description="Create it first, then generate the strategy and calendar."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={createCampaign.isPending}
            disabled={!valid}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Game creator launch"
          />
        </Field>
        <Field label="Goal" required hint="What this campaign is trying to achieve.">
          <Textarea
            value={form.objective}
            onChange={(event) => setForm({ ...form, objective: event.target.value })}
            placeholder="Get 500 creators to build their first game with the Kult creator tools."
          />
        </Field>
        <Field label="Template" hint="Optional. Shapes the structure of the plan.">
          <Select
            value={form.template}
            onChange={(event) => setForm({ ...form, template: event.target.value })}
          >
            <option value="">No template</option>
            {CAMPAIGN_TEMPLATES.map((template) => (
              <option key={template} value={template}>
                {formatEnum(template)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <Input
              type="date"
              value={form.startDate}
              onChange={(event) => setForm({ ...form, startDate: event.target.value })}
            />
          </Field>
          <Field label="End">
            <Input
              type="date"
              value={form.endDate}
              onChange={(event) => setForm({ ...form, endDate: event.target.value })}
            />
          </Field>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Platforms</p>
          <div className="flex flex-wrap gap-2">
            {SOCIAL_PROVIDERS.map((platform) => {
              const selected = form.platforms.includes(platform);
              return (
                <button
                  key={platform}
                  type="button"
                  onClick={() => togglePlatform(platform)}
                  aria-pressed={selected}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-sm transition-colors',
                    selected
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {platform}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
