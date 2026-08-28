import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthContext } from '@kult/auth';
import {
  AUTOMATION_MODES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TEMPLATES,
  SOCIAL_PROVIDERS,
} from '@kult/shared';
import { Auth, RequirePermissions } from '../../auth/auth.guard.js';
import { AuditService } from '../../common/audit.service.js';
import { zodBody, zodQuery } from '../../common/zod.pipe.js';
import { CampaignsService } from './campaigns.service.js';

const listQuerySchema = z.object({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(160),
  objective: z.string().trim().min(3).max(4_000),
  template: z.enum(CAMPAIGN_TEMPLATES).optional(),
  audienceId: z.string().optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  platforms: z.array(z.enum(SOCIAL_PROVIDERS)).min(1),
  budgetAmount: z.number().nonnegative().optional(),
  budgetCurrency: z.string().trim().length(3).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  objective: z.string().trim().min(3).max(4_000).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  platforms: z.array(z.enum(SOCIAL_PROVIDERS)).min(1).optional(),
  approvalMode: z.enum(AUTOMATION_MODES).optional(),
  strategy: z.record(z.string(), z.unknown()).optional(),
});

const generateSchema = z.object({
  postsPerWeek: z.number().int().min(1).max(30).optional(),
  opportunityIds: z.array(z.string()).max(25).optional(),
});

@ApiTags('campaigns')
@ApiBearerAuth('privy')
@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('campaigns:read')
  @ApiOperation({ summary: 'List campaigns' })
  async list(
    @Auth() auth: AuthContext,
    @Query(zodQuery(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ) {
    return this.campaigns.list(auth, query);
  }

  @Post()
  @RequirePermissions('campaigns:write')
  @ApiOperation({ summary: 'Create a campaign' })
  async create(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Body(zodBody(createSchema)) body: z.infer<typeof createSchema>,
  ) {
    const campaign = await this.campaigns.create(auth, body);
    await this.audit.fromRequest(request, auth, {
      action: 'campaign.created',
      resourceType: 'Campaign',
      resourceId: campaign.id,
      metadata: { name: campaign.name },
    });
    return campaign;
  }

  @Get(':id')
  @RequirePermissions('campaigns:read')
  @ApiOperation({ summary: 'Campaign with strategy, steps, and content' })
  async get(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.campaigns.get(auth, id);
  }

  @Patch(':id')
  @RequirePermissions('campaigns:write')
  @ApiOperation({ summary: 'Update a campaign' })
  async update(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return this.campaigns.update(auth, id, body);
  }

  @Post(':id/generate')
  @RequirePermissions('ai:generate')
  @ApiOperation({
    summary: 'Generate the campaign strategy and content calendar',
    description: 'Runs asynchronously. Poll the returned workflow execution for progress.',
  })
  async generate(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Body(zodBody(generateSchema)) body: z.infer<typeof generateSchema>,
  ) {
    return this.campaigns.generatePlan(auth, id, body);
  }

  @Post(':id/activate')
  @RequirePermissions('campaigns:activate')
  @ApiOperation({ summary: 'Activate a campaign' })
  async activate(@Auth() auth: AuthContext, @Req() request: Request, @Param('id') id: string) {
    const campaign = await this.campaigns.activate(auth, id);
    await this.audit.fromRequest(request, auth, {
      action: 'campaign.activated',
      resourceType: 'Campaign',
      resourceId: id,
    });
    return campaign;
  }

  @Post(':id/pause')
  @RequirePermissions('campaigns:activate')
  @ApiOperation({ summary: 'Pause an active campaign' })
  async pause(@Auth() auth: AuthContext, @Req() request: Request, @Param('id') id: string) {
    const campaign = await this.campaigns.pause(auth, id);
    await this.audit.fromRequest(request, auth, {
      action: 'campaign.paused',
      resourceType: 'Campaign',
      resourceId: id,
    });
    return campaign;
  }
}
