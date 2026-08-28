/**
 * Centralised authorization matrix.
 *
 * This module is pure and shared by the API guards, the worker (for actions
 * attributed to a user), and the copilot tool layer. Frontend route protection
 * is cosmetic only - every decision here is re-evaluated server side.
 */

export const ORGANIZATION_ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'ANALYST', 'VIEWER'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const PERMISSIONS = [
  // Organization
  'organization:read',
  'organization:update',
  'organization:transfer_ownership',
  'organization:delete',
  'members:read',
  'members:invite',
  'members:update_role',
  'members:remove',

  // Brand knowledge
  'knowledge:read',
  'knowledge:write',
  'knowledge:delete',

  // Research
  'research:read',
  'research:run',

  // Opportunities / niches / trends
  'opportunities:read',
  'opportunities:write',

  // Content
  'content:read',
  'content:write',
  'content:delete',
  'content:approve',
  'content:schedule',
  'content:publish',

  // Campaigns
  'campaigns:read',
  'campaigns:write',
  'campaigns:activate',

  // AI
  'ai:generate',
  'ai:copilot',

  // Analytics
  'analytics:read',

  // Integrations
  'integrations:read',
  'integrations:connect',
  'integrations:disconnect',

  // Agents & automation
  'agents:read',
  'automation:configure',

  // Security / settings
  'settings:read',
  'settings:security',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'organization:read',
  'members:read',
  'knowledge:read',
  'research:read',
  'opportunities:read',
  'content:read',
  'campaigns:read',
  'analytics:read',
  'integrations:read',
  'agents:read',
  'settings:read',
];

const ANALYST: Permission[] = [
  ...VIEWER,
  'research:run',
  'analytics:read',
  'ai:generate',
  'ai:copilot',
];

const EDITOR: Permission[] = [
  ...ANALYST,
  'knowledge:write',
  'opportunities:write',
  'content:write',
  'content:delete',
  'content:schedule',
  'content:publish',
  'campaigns:write',
  'campaigns:activate',
];

const ADMIN: Permission[] = [
  ...EDITOR,
  'organization:update',
  'members:invite',
  'members:update_role',
  'members:remove',
  'knowledge:delete',
  'content:approve',
  'integrations:connect',
  'integrations:disconnect',
  'automation:configure',
  'settings:security',
  'audit:read',
];

const OWNER: Permission[] = [...ADMIN, 'organization:transfer_ownership', 'organization:delete'];

/** Role -> permission set. Frozen so it cannot be mutated at runtime. */
export const ROLE_PERMISSIONS: Readonly<Record<OrganizationRole, ReadonlySet<Permission>>> =
  Object.freeze({
    OWNER: new Set(OWNER),
    ADMIN: new Set(ADMIN),
    EDITOR: new Set(EDITOR),
    ANALYST: new Set(ANALYST),
    VIEWER: new Set(VIEWER),
  });

export function hasPermission(role: OrganizationRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function hasEveryPermission(role: OrganizationRole, permissions: Permission[]): boolean {
  return permissions.every((permission) => hasPermission(role, permission));
}

export function permissionsForRole(role: OrganizationRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]].sort();
}

/** Ordering used for "can this actor manage that actor" checks. Higher outranks lower. */
const ROLE_RANK: Record<OrganizationRole, number> = {
  OWNER: 50,
  ADMIN: 40,
  EDITOR: 30,
  ANALYST: 20,
  VIEWER: 10,
};

export function outranks(actor: OrganizationRole, subject: OrganizationRole): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[subject];
}

/**
 * A member may only assign roles strictly below their own, and may never grant
 * OWNER (ownership moves exclusively through an explicit transfer flow).
 */
export function canAssignRole(actor: OrganizationRole, target: OrganizationRole): boolean {
  if (target === 'OWNER') return false;
  return outranks(actor, target);
}
