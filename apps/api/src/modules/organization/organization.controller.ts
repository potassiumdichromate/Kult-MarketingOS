import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { PrivyAuthenticator, bearerToken, type AuthContext } from '@kult/auth';
import type { AppConfig } from '@kult/config';
import { ORGANIZATION_ROLES, MARKETING_GOALS, ValidationError } from '@kult/shared';
import { Auth, Public, RequirePermissions } from '../../auth/auth.guard.js';
import { AuditService, clientIp } from '../../common/audit.service.js';
import { APP_CONFIG } from '../../common/tokens.js';
import { zodBody } from '../../common/zod.pipe.js';
import { OrganizationService, isValidTimezone } from './organization.service.js';

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  websiteUrl: z.url().optional(),
  timezone: z
    .string()
    .trim()
    .refine(isValidTimezone, 'Must be a valid IANA timezone, for example Europe/London.')
    .optional(),
});

const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  websiteUrl: z.url().nullable().optional(),
  timezone: z
    .string()
    .trim()
    .refine(isValidTimezone, 'Must be a valid IANA timezone.')
    .optional(),
  primaryGoals: z.array(z.enum(MARKETING_GOALS)).optional(),
});

const addMemberSchema = z
  .object({
    privyUserId: z.string().trim().min(1).optional(),
    email: z.email().optional(),
    role: z.enum(ORGANIZATION_ROLES),
  })
  .refine((value) => value.privyUserId || value.email, {
    message: 'Provide either privyUserId or email.',
    path: ['privyUserId'],
  });

const updateMemberSchema = z.object({ role: z.enum(ORGANIZATION_ROLES) });

@ApiTags('organization')
@ApiBearerAuth('privy')
@Controller()
export class OrganizationController {
  private readonly privy: PrivyAuthenticator;

  constructor(
    private readonly organizations: OrganizationService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.privy = new PrivyAuthenticator(config);
  }

  /**
   * Identity endpoint and provisioning hook.
   *
   * Public at the guard level because it is the one route a brand-new Privy user
   * can reach before a local User row exists. It still verifies the Privy token
   * itself before doing anything.
   */
  @Public()
  @Get('me')
  @ApiOperation({
    summary: 'Current user, memberships, and onboarding state',
    description:
      'Provisions the local user record on first call. Requires a valid Privy access token; an ' +
      'optional x-privy-id-token header enriches the profile with linked-account details.',
  })
  async me(@Req() request: Request) {
    const token = bearerToken(request.header('authorization'));
    if (!token) {
      throw new ValidationError('Missing credentials.', [
        { path: 'authorization', message: 'An Authorization: Bearer header is required.' },
      ]);
    }

    const identity = await this.privy.verifyAccessToken(token);
    const identityToken = request.header('x-privy-id-token');

    const result = await this.organizations.provisionAndLoad({
      privyUserId: identity.privyUserId,
      ...(identityToken ? { identityToken } : {}),
    });

    await this.audit.record({
      action: 'auth.login',
      actorUserId: result.user.id,
      organizationId: result.organizations[0]?.id ?? null,
      ip: clientIp(request),
      userAgent: request.header('user-agent') ?? null,
      metadata: { organizationCount: result.organizations.length },
    });

    return {
      user: result.user,
      organizations: result.organizations,
      needsOrganization: result.organizations.length === 0,
    };
  }

  /**
   * Creates an organization for a user who has none.
   *
   * Public at the guard level for the same reason as /me: a user without a
   * membership cannot satisfy AuthGuard, yet must be able to create their first
   * organization. The Privy token is verified here explicitly.
   */
  @Public()
  @Post('organizations')
  @ApiOperation({ summary: 'Create an organization and become its owner' })
  async create(@Req() request: Request, @Body(zodBody(createOrganizationSchema)) body: z.infer<typeof createOrganizationSchema>) {
    const token = bearerToken(request.header('authorization'));
    if (!token) {
      throw new ValidationError('Missing credentials.', [
        { path: 'authorization', message: 'An Authorization: Bearer header is required.' },
      ]);
    }
    const identity = await this.privy.verifyAccessToken(token);
    const { user } = await this.organizations.provisionAndLoad({
      privyUserId: identity.privyUserId,
    });

    const organization = await this.organizations.createOrganization({
      userId: user.id,
      name: body.name,
      ...(body.websiteUrl ? { websiteUrl: body.websiteUrl } : {}),
      ...(body.timezone ? { timezone: body.timezone } : {}),
    });

    await this.audit.record({
      action: 'organization.created',
      organizationId: organization.id,
      actorUserId: user.id,
      resourceType: 'Organization',
      resourceId: organization.id,
      ip: clientIp(request),
      userAgent: request.header('user-agent') ?? null,
      metadata: { name: organization.name },
    });

    return organization;
  }

  @Get('organization')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'Current organization settings and your permissions' })
  async get(@Auth() auth: AuthContext) {
    return this.organizations.getOrganization(auth);
  }

  @Patch('organization')
  @RequirePermissions('organization:update')
  @ApiOperation({ summary: 'Update organization settings' })
  async update(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Body(zodBody(updateOrganizationSchema)) body: z.infer<typeof updateOrganizationSchema>,
  ) {
    const result = await this.organizations.updateOrganization(auth, body);
    await this.audit.fromRequest(request, auth, {
      action: 'organization.updated',
      resourceType: 'Organization',
      resourceId: auth.organizationId,
      metadata: { fields: Object.keys(body) },
    });
    return result;
  }

  @Get('organization/members')
  @RequirePermissions('members:read')
  @ApiOperation({ summary: 'List organization members' })
  async members(@Auth() auth: AuthContext) {
    return this.organizations.listMembers(auth);
  }

  @Post('organization/members')
  @RequirePermissions('members:invite')
  @ApiOperation({
    summary: 'Add an existing Kult user to this organization',
    description:
      'The person must have signed in with Privy at least once. This application never creates ' +
      'accounts or passwords.',
  })
  async addMember(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Body(zodBody(addMemberSchema)) body: z.infer<typeof addMemberSchema>,
  ) {
    const member = await this.organizations.addMember(auth, body);
    await this.audit.fromRequest(request, auth, {
      action: 'organization.member_invited',
      resourceType: 'OrganizationMember',
      resourceId: member.id,
      metadata: { role: member.role, userId: member.user.id },
    });
    return member;
  }

  @Patch('organization/members/:id')
  @RequirePermissions('members:update_role')
  @ApiOperation({ summary: "Change a member's role" })
  async updateMember(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('id') memberId: string,
    @Body(zodBody(updateMemberSchema)) body: z.infer<typeof updateMemberSchema>,
  ) {
    const member = await this.organizations.updateMemberRole(auth, memberId, body.role);
    await this.audit.fromRequest(request, auth, {
      action: 'organization.member_role_changed',
      resourceType: 'OrganizationMember',
      resourceId: memberId,
      metadata: { newRole: body.role },
    });
    return member;
  }

  @Delete('organization/members/:id')
  @RequirePermissions('members:remove')
  @ApiOperation({ summary: 'Remove a member' })
  async removeMember(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('id') memberId: string,
  ) {
    await this.organizations.removeMember(auth, memberId);
    await this.audit.fromRequest(request, auth, {
      action: 'organization.member_removed',
      resourceType: 'OrganizationMember',
      resourceId: memberId,
    });
    return { removed: true };
  }
}
