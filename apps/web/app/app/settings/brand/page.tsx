'use client';

import { useEffect, useState } from 'react';
import { useKnowledge, useUpsertBrandProfile, useOrganization } from '@/lib/queries';
import { SettingsTabs } from '../page';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Skeleton,
  Textarea,
} from '@/components/ui';

/**
 * Brand voice and writing rules.
 *
 * Saving re-indexes the profile immediately, so the next generation retrieves
 * the updated voice rather than the previous one.
 */
export default function BrandSettingsPage() {
  const knowledge = useKnowledge();
  const organization = useOrganization();
  const upsert = useUpsertBrandProfile();

  const [form, setForm] = useState({
    description: '',
    positioning: '',
    mission: '',
    voiceSummary: '',
    toneAttributes: '',
    writingRules: '',
    bannedPhrases: '',
  });

  useEffect(() => {
    const profile = knowledge.data?.profile;
    if (!profile) return;
    setForm({
      description: profile.description,
      positioning: profile.positioning ?? '',
      mission: profile.mission ?? '',
      voiceSummary: profile.voiceSummary ?? '',
      toneAttributes: profile.toneAttributes.join(', '),
      writingRules: profile.writingRules.join('\n'),
      bannedPhrases: profile.bannedPhrases.join(', '),
    });
  }, [knowledge.data?.profile]);

  const canEdit = organization.data?.yourPermissions.includes('knowledge:write') ?? false;

  if (knowledge.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (knowledge.error) {
    return <ErrorState error={knowledge.error} onRetry={() => void knowledge.refetch()} />;
  }

  const set = (key: keyof typeof form, value: string): void =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <div className="animate-fade-in">
      <PageHeader title="Settings" />
      <SettingsTabs />

      <div className="max-w-2xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Brand profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="What the brand does" required>
              <Textarea
                value={form.description}
                onChange={(event) => set('description', event.target.value)}
                disabled={!canEdit}
                className="min-h-24"
              />
            </Field>
            <Field label="Positioning">
              <Textarea
                value={form.positioning}
                onChange={(event) => set('positioning', event.target.value)}
                disabled={!canEdit}
              />
            </Field>
            <Field label="Mission">
              <Textarea
                value={form.mission}
                onChange={(event) => set('mission', event.target.value)}
                disabled={!canEdit}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Voice</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Voice summary" hint="How the writing should sound.">
              <Textarea
                value={form.voiceSummary}
                onChange={(event) => set('voiceSummary', event.target.value)}
                disabled={!canEdit}
              />
            </Field>
            <Field label="Tone attributes" hint="Comma separated.">
              <Input
                value={form.toneAttributes}
                onChange={(event) => set('toneAttributes', event.target.value)}
                disabled={!canEdit}
                placeholder="direct, concrete, playful"
              />
            </Field>
            <Field label="Writing rules" hint="One per line. Applied to every generation.">
              <Textarea
                value={form.writingRules}
                onChange={(event) => set('writingRules', event.target.value)}
                disabled={!canEdit}
                className="min-h-28"
                placeholder={'Never open with a rhetorical question.\nNo more than one emoji per post.'}
              />
            </Field>
            <Field
              label="Banned phrases"
              hint="Comma separated. Content using these is blocked before it can be approved."
            >
              <Input
                value={form.bannedPhrases}
                onChange={(event) => set('bannedPhrases', event.target.value)}
                disabled={!canEdit}
                placeholder="revolutionary, game-changing"
              />
            </Field>

            {canEdit ? (
              <Button
                variant="primary"
                loading={upsert.isPending}
                disabled={form.description.trim().length < 10}
                onClick={() =>
                  upsert.mutate({
                    description: form.description.trim(),
                    positioning: form.positioning.trim() || null,
                    mission: form.mission.trim() || null,
                    voiceSummary: form.voiceSummary.trim() || null,
                    toneAttributes: form.toneAttributes.split(',').map((v) => v.trim()).filter(Boolean),
                    writingRules: form.writingRules.split('\n').map((v) => v.trim()).filter(Boolean),
                    bannedPhrases: form.bannedPhrases.split(',').map((v) => v.trim()).filter(Boolean),
                  })
                }
              >
                Save and re-index
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Your role cannot edit brand knowledge.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
