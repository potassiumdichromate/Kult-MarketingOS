import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthContext } from '@kult/auth';
import {
  OPPORTUNITY_STATUSES,
  RESEARCH_SOURCE_TYPES,
  paginationQuerySchema,
} from '@kult/shared';
import { Auth, RequirePermissions } from '../../auth/auth.guard.js';
import { AuditService } from '../../common/audit.service.js';
import { zodBody, zodQuery } from '../../common/zod.pipe.js';
import { ResearchService } from './research.service.js';

const itemsQuerySchema = paginationQuerySchema.extend({
  sourceId: z.string().optional(),
  search: z.string().trim().max(200).optional(),
});

const createSourceSchema = z.object({
  type: z.enum(RESEARCH_SOURCE_TYPES),
  name: z.string().trim().min(1).max(120),
  config: z.record(z.string(), z.unknown()).default({}),
});

const updateSourceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const runSchema = z.object({ sourceIds: z.array(z.string()).max(50).optional() });

const trendsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  minScore: z.coerce.number().min(0).max(100).optional(),
  status: z.enum(['EMERGING', 'ACTIVE', 'DECLINING', 'EXPIRED']).optional(),
});

const nichesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const opportunitiesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(OPPORTUNITY_STATUSES).optional(),
});

const opportunityStatusSchema = z.object({ status: z.enum(OPPORTUNITY_STATUSES) });

@ApiTags('research')
@ApiBearerAuth('privy')
@Controller()
export class ResearchController {
  constructor(
    private readonly research: ResearchService,
    private readonly audit: AuditService,
  ) {}

  // -- Sources --------------------------------------------------------------

  @Get('research/sources')
  @RequirePermissions('research:read')
  @ApiOperation({
    summary: 'List research sources and the availability of every source type',
    description:
      'Source types this deployment cannot collect - for example Google Trends, which has no ' +
      'official public API - are listed with the reason rather than hidden.',
  })
  async listSources(@Auth() auth: AuthContext) {
    return this.research.listSources(auth);
  }

  @Post('research/sources')
  @RequirePermissions('research:run')
  @ApiOperation({ summary: 'Add a research source' })
  async createSource(
    @Auth() auth: AuthContext,
    @Body(zodBody(createSourceSchema)) body: z.infer<typeof createSourceSchema>,
  ) {
    return this.research.createSource(auth, body);
  }

  @Patch('research/sources/:id')
  @RequirePermissions('research:run')
  @ApiOperation({ summary: 'Update a research source' })
  async updateSource(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Body(zodBody(updateSourceSchema)) body: z.infer<typeof updateSourceSchema>,
  ) {
    return this.research.updateSource(auth, id, body);
  }

  @Delete('research/sources/:id')
  @RequirePermissions('research:run')
  @ApiOperation({ summary: 'Delete a research source' })
  async deleteSource(@Auth() auth: AuthContext, @Param('id') id: string) {
    await this.research.deleteSource(auth, id);
    return { deleted: true };
  }

  // -- Items and runs -------------------------------------------------------

  @Get('research')
  @RequirePermissions('research:read')
  @ApiOperation({ summary: 'List collected research items' })
  async listItems(
    @Auth() auth: AuthContext,
    @Query(zodQuery(itemsQuerySchema)) query: z.infer<typeof itemsQuerySchema>,
  ) {
    return this.research.listItems(auth, query);
  }

  @Post('research/run')
  @RequirePermissions('research:run')
  @ApiOperation({
    summary: 'Start a research run',
    description:
      'Creates a workflow execution, enqueues the work, and returns immediately. Poll ' +
      'GET /research/runs/:id for progress.',
  })
  async run(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Body(zodBody(runSchema)) body: z.infer<typeof runSchema>,
  ) {
    const result = await this.research.runResearch(auth, body);
    await this.audit.fromRequest(request, auth, {
      action: 'research.run_requested',
      resourceType: 'WorkflowExecution',
      resourceId: result.workflowExecutionId,
      metadata: { sourceCount: result.sourceCount },
    });
    return result;
  }

  @Get('research/runs/:id')
  @RequirePermissions('research:read')
  @ApiOperation({ summary: 'Research run progress with per-step state' })
  async runStatus(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.research.getWorkflowExecution(auth, id);
  }

  // -- Trends ---------------------------------------------------------------

  @Get('trends')
  @RequirePermissions('research:read')
  @ApiOperation({ summary: 'List scored trends' })
  async trends(
    @Auth() auth: AuthContext,
    @Query(zodQuery(trendsQuerySchema)) query: z.infer<typeof trendsQuerySchema>,
  ) {
    return this.research.listTrends(auth, query);
  }

  @Get('trends/:id')
  @RequirePermissions('research:read')
  @ApiOperation({
    summary: 'One trend with its source evidence',
    description:
      'Evidence is the set of real research items linked to the trend. The AI rationale is ' +
      'returned separately and is never evidence.',
  })
  async trend(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.research.getTrend(auth, id);
  }

  // -- Niches ---------------------------------------------------------------

  @Get('niches')
  @RequirePermissions('research:read')
  @ApiOperation({ summary: 'List discovered niches' })
  async niches(
    @Auth() auth: AuthContext,
    @Query(zodQuery(nichesQuerySchema)) query: z.infer<typeof nichesQuerySchema>,
  ) {
    return this.research.listNiches(auth, query);
  }

  @Post('niches/discover')
  @RequirePermissions('research:run')
  @ApiOperation({ summary: 'Discover niches from current trends' })
  async discoverNiches(@Auth() auth: AuthContext) {
    return this.research.discoverNiches(auth);
  }

  // -- Opportunities --------------------------------------------------------

  @Get('opportunities')
  @RequirePermissions('opportunities:read')
  @ApiOperation({ summary: 'List opportunities, highest score first' })
  async opportunities(
    @Auth() auth: AuthContext,
    @Query(zodQuery(opportunitiesQuerySchema)) query: z.infer<typeof opportunitiesQuerySchema>,
  ) {
    return this.research.listOpportunities(auth, query);
  }

  @Get('opportunities/:id')
  @RequirePermissions('opportunities:read')
  @ApiOperation({ summary: 'One opportunity with its source trends and niches' })
  async opportunity(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.research.getOpportunity(auth, id);
  }

  @Post('opportunities')
  @RequirePermissions('opportunities:write')
  @ApiOperation({ summary: 'Generate opportunities from current trends and niches' })
  async generateOpportunities(@Auth() auth: AuthContext) {
    return this.research.generateOpportunities(auth);
  }

  @Patch('opportunities/:id')
  @RequirePermissions('opportunities:write')
  @ApiOperation({ summary: 'Update an opportunity status' })
  async updateOpportunity(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Body(zodBody(opportunityStatusSchema)) body: z.infer<typeof opportunityStatusSchema>,
  ) {
    return this.research.updateOpportunityStatus(auth, id, body.status);
  }
}
