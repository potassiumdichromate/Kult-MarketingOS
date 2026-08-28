'use client';

import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { ORGANIZATION_ROLES, permissionsForRole } from '@kult/shared';
import { useAddMember, useMembers, useOrganization, useRemoveMember, useUpdateMemberRole } from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import { SettingsTabs } from '../page';
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
  Modal,
  PageHeader,
  Select,
  Skeleton,
} from '@/components/ui';

/**
 * Team management.
 *
 * There is deliberately no email invitation: this application never creates
 * accounts. A person signs in with Privy once, then an owner or admin adds them
 * by the email Privy reported.
 */
export default function TeamSettingsPage() {
  const organization = useOrganization();
  const members = useMembers();
  const addMember = useAddMember();
  const updateRole = useUpdateMemberRole();
  const removeMember = useRemoveMember();

  const [addOpen, setAddOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('VIEWER');

  const canManage = organization.data?.yourPermissions.includes('members:invite') ?? false;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Settings"
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <UserPlus className="h-4 w-4" aria-hidden />
              Add member
            </Button>
          ) : undefined
        }
      />
      <SettingsTabs />

      <div className="max-w-3xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
          </CardHeader>
          <CardContent>
            {members.isLoading ? (
              <Skeleton className="h-40" />
            ) : members.error ? (
              <ErrorState error={members.error} onRetry={() => void members.refetch()} />
            ) : (
              <ul className="divide-y divide-border/50">
                {(members.data ?? []).map((member) => (
                  <li
                    key={member.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {member.user.displayName ?? member.user.email ?? 'Unknown user'}
                      </p>
                      <p className="tabular text-xs text-muted-foreground">
                        {member.user.email ?? '—'} · joined {relativeTime(member.createdAt)}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {canManage && member.role !== 'OWNER' ? (
                        <Select
                          value={member.role}
                          onChange={(event) =>
                            updateRole.mutate({ id: member.id, role: event.target.value })
                          }
                          className="h-8 w-32 text-xs"
                          aria-label={`Role for ${member.user.email ?? member.id}`}
                        >
                          {ORGANIZATION_ROLES.filter((value) => value !== 'OWNER').map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Badge tone={member.role === 'OWNER' ? 'primary' : 'neutral'}>
                          {member.role}
                        </Badge>
                      )}

                      {canManage && member.role !== 'OWNER' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => removeMember.mutate(member.id)}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* What each role can do, so the choice above is informed. */}
        <Card>
          <CardHeader>
            <CardTitle>Roles</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {ORGANIZATION_ROLES.map((value) => (
                <li key={value}>
                  <div className="flex items-center gap-2">
                    <Badge tone={value === 'OWNER' ? 'primary' : 'neutral'}>{value}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {permissionsForRole(value).length} permissions
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{ROLE_SUMMARY[value]}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Modal
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add a member"
        description="They must have signed in to Kult Marketing OS with Privy at least once."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={addMember.isPending}
              disabled={!email.trim()}
              onClick={() =>
                addMember.mutate(
                  { email: email.trim(), role },
                  {
                    onSuccess: () => {
                      setAddOpen(false);
                      setEmail('');
                    },
                  },
                )
              }
            >
              Add
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Email" required hint="The email address on their Privy account.">
            <Input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              placeholder="teammate@kult.games"
            />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(event) => setRole(event.target.value)}>
              {ORGANIZATION_ROLES.filter((value) => value !== 'OWNER').map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </div>
  );
}

const ROLE_SUMMARY: Record<string, string> = {
  OWNER: 'Everything, including transferring ownership and deleting the organization.',
  ADMIN: 'Everything except ownership transfer. Approves content and manages integrations.',
  EDITOR: 'Creates, schedules and publishes content and campaigns. Cannot approve their own work.',
  ANALYST: 'Runs research and reads analytics and AI recommendations. Cannot write content.',
  VIEWER: 'Read-only across the workspace.',
};
