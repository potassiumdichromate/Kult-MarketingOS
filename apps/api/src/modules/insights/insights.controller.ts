import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthContext } from '@kult/auth';
import { NotFoundError } from '@kult/shared';
import { Auth, RequirePermissions } from '../../auth/auth.guard.js';
import { AuditService } from '../../common/audit.service.js';
import { zodBody, zodQuery } from '../../common/zod.pipe.js';
import { InsightsService } from './insights.service.js';

const periodSchema = z.object({
  periodDays: z.coerce.number().int().min(1).max(365).default(30),
});

const limitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const executionsQuerySchema = z.object({
  agentName: z.string().trim().max(80).optional(),
  workflowExecutionId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const insightsQuerySchema = z.object({
  status: z.enum(['PROPOSED', 'ACCEPTED', 'REJECTED']).optional(),
});

const decisionSchema = z.object({ decision: z.enum(['ACCEPTED', 'REJECTED']) });

const notificationsQuerySchema = z.object({
  unreadOnly: z
    .union([z.boolean(), z.string()])
    .transform((value) => (typeof value === 'boolean' ? value : value === 'true'))
    .default(false),
});

const markReadSchema = z.object({ ids: z.array(z.string()).min(1).max(200) });

@ApiTags('analytics')
@ApiBearerAuth('privy')
@Controller()
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly audit: AuditService,
  ) {}

  @Get('dashboard')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'Everything the dashboard renders, in one request' })
  async dashboard(@Auth() auth: AuthContext) {
    return this.insights.dashboard(auth);
  }

  @Get('analytics/overview')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Aggregate performance for a period',
    description:
      'Metrics a provider does not expose are reported as null and explained in metricGaps. ' +
      'Nothing is zero-filled.',
  })
  async overview(
    @Auth() auth: AuthContext,
    @Query(zodQuery(periodSchema)) query: z.infer<typeof periodSchema>,
  ) {
    return this.insights.overview(auth, query.periodDays);
  }

  @Get('analytics/posts')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Per-post performance' })
  async posts(
    @Auth() auth: AuthContext,
    @Query(zodQuery(limitSchema)) query: z.infer<typeof limitSchema>,
  ) {
    return this.insights.postAnalytics(auth, query.limit);
  }

  @Get('analytics/campaigns')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Campaign metric snapshots' })
  async campaigns(@Auth() auth: AuthContext) {
    return this.insights.campaignAnalytics(auth);
  }

  @Get('analytics/platforms')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Platform metric snapshots' })
  async platforms(@Auth() auth: AuthContext) {
    return this.insights.platformAnalytics(auth);
  }

  @Post('analytics/review')
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary: 'Run a performance review',
    description: 'Analyses the period and proposes strategy insights for a human to accept or reject.',
  })
  async review(
    @Auth() auth: AuthContext,
    @Body(zodBody(periodSchema)) body: z.infer<typeof periodSchema>,
  ) {
    return this.insights.runPerformanceReview(auth, body.periodDays);
  }

  @Get('insights')
  @RequirePermissions('analytics:read')
  @ApiOperation({ summary: 'Strategy insights awaiting or past decision' })
  async listInsights(
    @Auth() auth: AuthContext,
    @Query(zodQuery(insightsQuerySchema)) query: z.infer<typeof insightsQuerySchema>,
  ) {
    return this.insights.listInsights(auth, query.status);
  }

  @Post('insights/:id/decide')
  @RequirePermissions('campaigns:write')
  @ApiOperation({
    summary: 'Accept or reject a strategy insight',
    description:
      'Accepting promotes the insight into strategy memory. This is always a human decision; the ' +
      'system never applies an insight on its own.',
  })
  async decide(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('id') id: string,
    @Body(zodBody(decisionSchema)) body: z.infer<typeof decisionSchema>,
  ) {
    const result = await this.insights.decideInsight(auth, id, body.decision);
    await this.audit.fromRequest(request, auth, {
      action: body.decision === 'ACCEPTED' ? 'insight.accepted' : 'insight.rejected',
      resourceType: 'StrategyInsight',
      resourceId: id,
    });
    return result;
  }

  @Get('agents')
  @RequirePermissions('agents:read')
  @ApiOperation({ summary: 'Registered agents and their configuration' })
  async agents() {
    return this.insights.listAgents();
  }

  @Get('agents/executions')
  @RequirePermissions('agents:read')
  @ApiOperation({ summary: 'Agent activity feed' })
  async executions(
    @Auth() auth: AuthContext,
    @Query(zodQuery(executionsQuerySchema)) query: z.infer<typeof executionsQuerySchema>,
  ) {
    return this.insights.listExecutions(auth, query);
  }

  @Get('agents/executions/:id')
  @RequirePermissions('agents:read')
  @ApiOperation({ summary: 'One execution with its tool calls' })
  async execution(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.insights.getExecution(auth, id);
  }

  @Get('agents/:id')
  @RequirePermissions('agents:read')
  @ApiOperation({ summary: 'Agent definition' })
  async agent(@Auth() auth: AuthContext, @Param('id') id: string) {
    const agent = await this.insights.getAgent(auth, id);
    if (!agent) throw new NotFoundError('Agent');
    return agent;
  }

  @Get('notifications')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'In-app notifications' })
  async notifications(
    @Auth() auth: AuthContext,
    @Query(zodQuery(notificationsQuerySchema)) query: z.infer<typeof notificationsQuerySchema>,
  ) {
    return this.insights.listNotifications(auth, query.unreadOnly);
  }

  @Post('notifications/read')
  @RequirePermissions('organization:read')
  @ApiOperation({ summary: 'Mark notifications read' })
  async markRead(
    @Auth() auth: AuthContext,
    @Body(zodBody(markReadSchema)) body: z.infer<typeof markReadSchema>,
  ) {
    const count = await this.insights.markNotificationsRead(auth, body.ids);
    return { marked: count };
  }
}
