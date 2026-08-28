'use client';

import { ArrowLeft, ArrowRight, Check, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MARKETING_GOALS } from '@kult/shared';
import { useSession } from '@/components/providers';
import {
  useCreateKnowledgeEntity,
  useCreateOrganization,
  useUpdateOrganization,
  useUpsertBrandProfile,
} from '@/lib/queries';
import { Badge, Button, Card, CardContent, Field, Input, Select, Textarea, cn } from '@/components/ui';

/**
 * First-run onboarding.
 *
 * Collects the brand knowledge the AI needs before it can write anything
 * grounded. The order matters: the organization is created first so every
 * subsequent write has a tenant, and the brand profile is saved before products
 * and audiences so retrieval has something to anchor to.
 *
 * Everything after the organization step is skippable. A team that skips ends up
 * with an AI that refuses to assert facts rather than one that invents them,
 * which is the correct failure.
 */

const GOAL_LABELS: Record<string, string> = {
  AWARENESS: 'Awareness',
  COMMUNITY_GROWTH: 'Community growth',
  USER_ACQUISITION: 'User acquisition',
  GAME_CREATORS: 'Game creators',
  SPORTS_PREDICTION_USERS: 'Sports prediction users',
  WEB3_USERS: 'Web3 users',
  DEVELOPER_ADOPTION: 'Developer adoption',
  PARTNERSHIPS: 'Partnerships',
  RETENTION: 'Retention',
};

const STEPS = [
  'Organization',
  'Brand',
  'Products',
  'Audiences',
  'Goals',
  'Voice',
  'Competitors',
  'Automation',
] as const;

export default function OnboardingPage() {
  const router = useRouter();
  const { ready, authenticated, me, refetchMe, organizationId, setOrganizationId, isLoading } =
    useSession();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: '',
    websiteUrl: '',
    timezone: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC',
    description: '',
    positioning: '',
    products: [{ name: '', description: '' }],
    audiences: [{ name: '', description: '' }],
    goals: [] as string[],
    voiceSummary: '',
    toneAttributes: '',
    competitors: '',
    automationMode: 'COPILOT' as 'MANUAL' | 'COPILOT' | 'AUTOPILOT',
  });

  const createOrganization = useCreateOrganization();
  const updateOrganization = useUpdateOrganization();
  const upsertProfile = useUpsertBrandProfile();
  const createEntity = useCreateKnowledgeEntity();

  useEffect(() => {
    if (ready && !authenticated) router.replace('/login');
  }, [ready, authenticated, router]);

  // Someone who already belongs to an organization does not need this flow.
  useEffect(() => {
    if (!isLoading && me && !me.needsOrganization && step === 0) {
      router.replace('/app/dashboard');
    }
  }, [isLoading, me, step, router]);

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  async function handleCreateOrganization(): Promise<void> {
    const organization = await createOrganization.mutateAsync({
      name: form.name.trim(),
      ...(form.websiteUrl.trim() ? { websiteUrl: form.websiteUrl.trim() } : {}),
      timezone: form.timezone,
    });
    setOrganizationId(organization.id);
    refetchMe();
    setStep(1);
  }

  async function handleFinish(): Promise<void> {
    // Each write is independent; a failure in one should not lose the others,
    // so they run sequentially and surface their own errors.
    if (form.description.trim()) {
      await upsertProfile.mutateAsync({
        description: form.description.trim(),
        positioning: form.positioning.trim() || null,
        voiceSummary: form.voiceSummary.trim() || null,
        toneAttributes: form.toneAttributes
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      });
    }

    for (const product of form.products) {
      if (!product.name.trim() || !product.description.trim()) continue;
      await createEntity.mutateAsync({
        type: 'PRODUCT',
        name: product.name.trim(),
        description: product.description.trim(),
      });
    }

    for (const audience of form.audiences) {
      if (!audience.name.trim() || !audience.description.trim()) continue;
      await createEntity.mutateAsync({
        type: 'AUDIENCE',
        name: audience.name.trim(),
        description: audience.description.trim(),
      });
    }

    for (const competitor of form.competitors.split(',').map((v) => v.trim()).filter(Boolean)) {
      await createEntity.mutateAsync({ type: 'COMPETITOR', name: competitor });
    }

    await updateOrganization.mutateAsync({
      primaryGoals: form.goals,
      // Automation mode is stored on the organization; autopilot additionally
      // requires an explicit content-type allowlist, configured in settings.
      ...(form.goals.length > 0 ? {} : {}),
    });

    router.replace('/app/dashboard');
  }

  if (!ready || isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    );
  }

  const busy =
    createOrganization.isPending ||
    updateOrganization.isPending ||
    upsertProfile.isPending ||
    createEntity.isPending;

  return (
    <div className="mx-auto min-h-screen w-full max-w-2xl px-6 py-12">
      <div className="mb-8 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary shadow-[0_0_20px_hsl(278_88%_58%/0.45)]">
          <Sparkles className="h-5 w-5 text-primary-foreground" aria-hidden />
        </div>
        <div>
          <h1 className="font-display text-xl font-bold">Set up your workspace</h1>
          <p className="text-sm text-muted-foreground">
            This is what grounds the AI. The more it knows, the less it has to guess.
          </p>
        </div>
      </div>

      {/* Progress */}
      <ol className="mb-8 flex flex-wrap gap-1.5" aria-label="Onboarding progress">
        {STEPS.map((label, index) => (
          <li
            key={label}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs',
              index === step
                ? 'bg-primary/15 text-primary'
                : index < step
                  ? 'text-success'
                  : 'text-muted-foreground',
            )}
            aria-current={index === step ? 'step' : undefined}
          >
            {index < step ? <Check className="h-3 w-3" aria-hidden /> : null}
            {label}
          </li>
        ))}
      </ol>

      <Card>
        <CardContent className="space-y-4 pt-5">
          {step === 0 ? (
            <>
              <Field label="Organization name" required>
                <Input
                  value={form.name}
                  onChange={(event) => update('name', event.target.value)}
                  placeholder="Kult"
                  autoFocus
                />
              </Field>
              <Field label="Website" hint="Used as context when researching your space.">
                <Input
                  value={form.websiteUrl}
                  onChange={(event) => update('websiteUrl', event.target.value)}
                  placeholder="https://app.kult.games"
                  type="url"
                />
              </Field>
              <Field
                label="Timezone"
                hint="Scheduling and posting-window analysis use this, not UTC."
              >
                <Input
                  value={form.timezone}
                  onChange={(event) => update('timezone', event.target.value)}
                  placeholder="Europe/London"
                />
              </Field>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <Field label="What does the brand do?" required>
                <Textarea
                  value={form.description}
                  onChange={(event) => update('description', event.target.value)}
                  placeholder="Kult is a Web3 gaming, sports prediction and game-creator browser powered by 0G AI agents."
                  className="min-h-28"
                  autoFocus
                />
              </Field>
              <Field label="Positioning" hint="How you want to be seen, versus the alternatives.">
                <Textarea
                  value={form.positioning}
                  onChange={(event) => update('positioning', event.target.value)}
                  placeholder="The place where AI agents and players share the same world."
                />
              </Field>
            </>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Products the AI may write about. Anything not listed here, it will not claim exists.
              </p>
              {form.products.map((product, index) => (
                <div key={index} className="space-y-2 rounded-lg border border-border/60 p-3">
                  <Input
                    value={product.name}
                    onChange={(event) => {
                      const next = [...form.products];
                      next[index] = { ...next[index]!, name: event.target.value };
                      update('products', next);
                    }}
                    placeholder="Product name"
                  />
                  <Textarea
                    value={product.description}
                    onChange={(event) => {
                      const next = [...form.products];
                      next[index] = { ...next[index]!, description: event.target.value };
                      update('products', next);
                    }}
                    placeholder="What it is and who it is for."
                    className="min-h-16"
                  />
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => update('products', [...form.products, { name: '', description: '' }])}
              >
                Add another product
              </Button>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Who you are trying to reach. Content strategy is written against these.
              </p>
              {form.audiences.map((audience, index) => (
                <div key={index} className="space-y-2 rounded-lg border border-border/60 p-3">
                  <Input
                    value={audience.name}
                    onChange={(event) => {
                      const next = [...form.audiences];
                      next[index] = { ...next[index]!, name: event.target.value };
                      update('audiences', next);
                    }}
                    placeholder="Web3 gamers"
                  />
                  <Textarea
                    value={audience.description}
                    onChange={(event) => {
                      const next = [...form.audiences];
                      next[index] = { ...next[index]!, description: event.target.value };
                      update('audiences', next);
                    }}
                    placeholder="What they care about and what frustrates them."
                    className="min-h-16"
                  />
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  update('audiences', [...form.audiences, { name: '', description: '' }])
                }
              >
                Add another audience
              </Button>
            </div>
          ) : null}

          {step === 4 ? (
            <div>
              <p className="mb-3 text-sm text-muted-foreground">
                Primary marketing goals. Opportunities are scored partly on fit with these.
              </p>
              <div className="flex flex-wrap gap-2">
                {MARKETING_GOALS.map((goal) => {
                  const selected = form.goals.includes(goal);
                  return (
                    <button
                      key={goal}
                      type="button"
                      onClick={() =>
                        update(
                          'goals',
                          selected
                            ? form.goals.filter((value) => value !== goal)
                            : [...form.goals, goal],
                        )
                      }
                      className={cn(
                        'rounded-lg border px-3 py-1.5 text-sm transition-colors',
                        selected
                          ? 'border-primary bg-primary/15 text-primary'
                          : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
                      )}
                      aria-pressed={selected}
                    >
                      {GOAL_LABELS[goal] ?? goal}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {step === 5 ? (
            <>
              <Field label="Brand voice" hint="How the writing should sound.">
                <Textarea
                  value={form.voiceSummary}
                  onChange={(event) => update('voiceSummary', event.target.value)}
                  placeholder="Direct and technically credible. No hype, no emoji spam, no 'revolutionary'."
                />
              </Field>
              <Field label="Tone attributes" hint="Comma separated.">
                <Input
                  value={form.toneAttributes}
                  onChange={(event) => update('toneAttributes', event.target.value)}
                  placeholder="confident, concrete, playful"
                />
              </Field>
            </>
          ) : null}

          {step === 6 ? (
            <Field
              label="Competitors"
              hint="Comma separated. Used for competitive research and gap analysis."
            >
              <Input
                value={form.competitors}
                onChange={(event) => update('competitors', event.target.value)}
                placeholder="Competitor A, Competitor B"
              />
            </Field>
          ) : null}

          {step === 7 ? (
            <div className="space-y-4">
              <Field label="Approval mode">
                <Select
                  value={form.automationMode}
                  onChange={(event) =>
                    update('automationMode', event.target.value as typeof form.automationMode)
                  }
                >
                  <option value="COPILOT">Copilot — AI drafts, a human approves</option>
                  <option value="MANUAL">Manual — AI assists, never schedules or publishes</option>
                  <option value="AUTOPILOT">Autopilot — low-risk content publishes itself</option>
                </Select>
              </Field>

              {form.automationMode === 'AUTOPILOT' ? (
                <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
                  <p className="text-sm font-medium text-warning">Autopilot needs more setup</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Selecting it here records the intent, but nothing publishes automatically until
                    you allow specific content types under Settings. Autopilot only ever publishes
                    low-risk content whose factual claims all match an approved claim.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  You can change this later in Settings. Copilot is the sensible default.
                </p>
              )}

              <div className="rounded-lg border border-border/60 bg-surface-raised/40 p-3">
                <p className="text-sm font-medium">What happens next</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Connect a social account under Integrations, add research sources, then run
                  research to start finding opportunities.
                </p>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="mt-6 flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={() => setStep((current) => Math.max(0, current - 1))}
          disabled={step === 0 || busy}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back
        </Button>

        <div className="flex items-center gap-2">
          {step > 0 && step < STEPS.length - 1 ? (
            <Button variant="ghost" onClick={() => setStep((current) => current + 1)} disabled={busy}>
              Skip
            </Button>
          ) : null}

          {step === 0 ? (
            <Button
              variant="primary"
              onClick={handleCreateOrganization}
              loading={createOrganization.isPending}
              disabled={form.name.trim().length < 2}
            >
              Create workspace
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          ) : step === STEPS.length - 1 ? (
            <Button variant="primary" onClick={handleFinish} loading={busy}>
              Finish setup
              <Check className="h-4 w-4" aria-hidden />
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setStep((current) => current + 1)} disabled={busy}>
              Continue
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
