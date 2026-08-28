import { Inject, Injectable } from '@nestjs/common';
import { PrivyAuthenticator, type AuthContext } from '@kult/auth';
import type { AppConfig } from '@kult/config';
import type { PrismaClient } from '@kult/database';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
  canAssignRole,
  outranks,
  permissionsForRole,
  type OrganizationRole,
} from '@kult/shared';
import { APP_CONFIG, PRISMA } from '../../common/tokens.js';

/**
 * User provisioning, organization management, and membership.
 *
 * Provisioning is deliberately lazy: a Privy identity becomes a local User row
 * the first time it calls GET /me. That keeps the sign-up path to a single Privy
 * login with no separate registration step, while still giving every downstream
 * record a stable local user id to attribute work to.
 */
@Injectable()
export class OrganizationService {
  private readonly privy: PrivyAuthenticator;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.privy = new PrivyAuthenticator(config);
  }

  /**
   * Resolves - and if necessary creates - the local user for a verified Privy
   * identity, then returns their memberships.
   */
  async provisionAndLoad(input: {
    privyUserId: string;
    identityToken?: string;
  }): Promise<{
    user: {
      id: string;
      email: string | null;
      displayName: string | null;
      avatarUrl: string | null;
      walletAddress: string | null;
    };
    organizations: Array<{ id: string; name: string; slug: string; role: OrganizationRole }>;
  }> {
    const profile = input.identityToken
      ? await this.privy.getProfile(input.identityToken)
      : undefined;

    const user = await this.prisma.user.upsert({
      where: { privyUserId: input.privyUserId },
      create: {
        privyUserId: input.privyUserId,
        email: profile?.email ?? null,
        walletAddress: profile?.walletAddress ?? null,
        displayName: profile?.displayName ?? null,
        lastLoginAt: new Date(),
      },
      // Profile enrichment is best-effort; never overwrite a known value with null.
      update: {
        lastLoginAt: new Date(),
        ...(profile?.email ? { email: profile.email } : {}),
        ...(profile?.walletAddress ? { walletAddress: profile.walletAddress } : {}),
        ...(profile?.displayName ? { displayName: profile.displayName } : {}),
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        walletAddress: true,
        memberships: {
          select: {
            role: true,
            organization: { select: { id: true, name: true, slug: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        walletAddress: user.walletAddress,
      },
      organizations: user.memberships.map((membership) => ({
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
        role: membership.role as OrganizationRole,
      })),
    };
  }

  /** Creates an organization and makes the creator its OWNER, atomically. */
  async createOrganization(input: {
    userId: string;
    name: string;
    websiteUrl?: string;
    timezone?: string;
  }): Promise<{ id: string; name: string; slug: string }> {
    const slug = await this.uniqueSlug(input.name);

    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: input.name,
          slug,
          websiteUrl: input.websiteUrl ?? null,
          timezone: input.timezone ?? 'UTC',
          members: { create: { userId: input.userId, role: 'OWNER' } },
        },
        select: { id: true, name: true, slug: true },
      });
      return organization;
    });
  }

  async getOrganization(auth: AuthContext) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        websiteUrl: true,
        timezone: true,
        automationMode: true,
        autopilotContentTypes: true,
        autopilotEnabledAt: true,
        primaryGoals: true,
        onboardingStep: true,
        onboardingCompletedAt: true,
        createdAt: true,
        _count: { select: { members: true } },
      },
    });
    if (!organization) throw new NotFoundError('Organization');

    return {
      ...organization,
      memberCount: organization._count.members,
      _count: undefined,
      yourRole: auth.role,
      yourPermissions: permissionsForRole(auth.role),
    };
  }

  async updateOrganization(
    auth: AuthContext,
    input: {
      name?: string;
      websiteUrl?: string | null;
      timezone?: string;
      primaryGoals?: string[];
    },
  ) {
    if (input.timezone && !isValidTimezone(input.timezone)) {
      throw new ValidationError('Unknown timezone.', [
        { path: 'timezone', message: `"${input.timezone}" is not a recognised IANA timezone.` },
      ]);
    }

    return this.prisma.organization.update({
      where: { id: auth.organizationId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.primaryGoals !== undefined
          ? { primaryGoals: input.primaryGoals as never }
          : {}),
      },
      select: { id: true, name: true, slug: true, timezone: true, primaryGoals: true },
    });
  }

  async listMembers(auth: AuthContext) {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId: auth.organizationId },
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, email: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return members;
  }

  /**
   * Adds an existing Kult user to the organization.
   *
   * There is deliberately no email-invitation flow: this application does not
   * create accounts. A person signs in with Privy first, and is then added by
   * their Privy DID or the email Privy reported.
   */
  async addMember(
    auth: AuthContext,
    input: { privyUserId?: string; email?: string; role: OrganizationRole },
  ) {
    if (!canAssignRole(auth.role, input.role)) {
      throw new AuthorizationError(
        `Your role (${auth.role}) cannot assign the ${input.role} role.`,
      );
    }
    if (!input.privyUserId && !input.email) {
      throw new ValidationError('Identify the user to add.', [
        { path: 'privyUserId', message: 'Provide either privyUserId or email.' },
      ]);
    }

    const user = await this.prisma.user.findFirst({
      where: input.privyUserId ? { privyUserId: input.privyUserId } : { email: input.email },
      select: { id: true, email: true, displayName: true },
    });

    if (!user) {
      throw new NotFoundError(
        'That person has not signed in to Kult Marketing OS yet. Ask them to sign in once with ' +
          'Privy, then add them',
      );
    }

    const existing = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: auth.organizationId, userId: user.id } },
      select: { id: true },
    });
    if (existing) throw new ConflictError('That person is already a member of this organization.');

    return this.prisma.organizationMember.create({
      data: {
        organizationId: auth.organizationId,
        userId: user.id,
        role: input.role,
        invitedById: auth.userId,
      },
      select: {
        id: true,
        role: true,
        user: { select: { id: true, email: true, displayName: true } },
      },
    });
  }

  async updateMemberRole(auth: AuthContext, memberId: string, role: OrganizationRole) {
    const member = await this.requireMember(auth, memberId);

    if (member.userId === auth.userId) {
      throw new AuthorizationError('You cannot change your own role.');
    }
    if (!outranks(auth.role, member.role as OrganizationRole)) {
      throw new AuthorizationError(
        `You cannot modify a member whose role (${member.role}) is not below yours.`,
      );
    }
    if (!canAssignRole(auth.role, role)) {
      throw new AuthorizationError(`Your role (${auth.role}) cannot assign the ${role} role.`);
    }

    return this.prisma.organizationMember.update({
      where: { id: memberId },
      data: { role },
      select: { id: true, role: true, user: { select: { id: true, email: true } } },
    });
  }

  async removeMember(auth: AuthContext, memberId: string): Promise<void> {
    const member = await this.requireMember(auth, memberId);

    if (member.userId === auth.userId) {
      throw new AuthorizationError(
        'You cannot remove yourself. Ask another owner or admin to do it.',
      );
    }
    if (!outranks(auth.role, member.role as OrganizationRole)) {
      throw new AuthorizationError(
        `You cannot remove a member whose role (${member.role}) is not below yours.`,
      );
    }
    if (member.role === 'OWNER') {
      const owners = await this.prisma.organizationMember.count({
        where: { organizationId: auth.organizationId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new ConflictError('An organization must always have at least one owner.');
      }
    }

    await this.prisma.organizationMember.delete({ where: { id: memberId } });
  }

  /** Loads a member, enforcing that they belong to the caller's organization. */
  private async requireMember(auth: AuthContext, memberId: string) {
    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      select: { id: true, role: true, userId: true, organizationId: true },
    });
    // A member of another organization is reported as absent, not as forbidden,
    // so membership elsewhere is not disclosed.
    if (!member || member.organizationId !== auth.organizationId) {
      throw new NotFoundError('Member');
    }
    return member;
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'organization';

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await this.prisma.organization.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
