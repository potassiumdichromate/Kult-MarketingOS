import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthContext } from '@kult/auth';
import { CONTENT_STATUSES, CONTENT_TYPES, paginationQuerySchema } from '@kult/shared';
import { Auth, RequirePermissions } from '../../auth/auth.guard.js';
import { AuditService } from '../../common/audit.service.js';
import { zodBody, zodQuery } from '../../common/zod.pipe.js';
import { ContentService } from './content.service.js';

const listQuerySchema = paginationQuerySchema.extend({
  status: z.enum(CONTENT_STATUSES).optional(),
  contentType: z.enum(CONTENT_TYPES).optional(),
  campaignId: z.string().optional(),
  scheduledFrom: z.coerce.date().optional(),
  scheduledTo: z.coerce.date().optional(),
});

const createSchema = z.object({
  contentType: z.enum(CONTENT_TYPES),
  title: z.string().trim().max(300).optional(),
  body: z.string().max(50_000),
  threadParts: z.array(z.string().max(50_000)).max(50).optional(),
  hashtags: z.array(z.string().trim().max(100)).max(60).optional(),
  mentions: z.array(z.string().trim().max(100)).max(60).optional(),
  cta: z.string().trim().max(500).optional(),
  campaignId: z.string().optional(),
  opportunityId: z.string().optional(),
});

const updateSchema = z.object({
  title: z.string().trim().max(300).nullable().optional(),
  body: z.string().max(50_000).optional(),
  threadParts: z.array(z.string().max(50_000)).max(50).optional(),
  hashtags: z.array(z.string().trim().max(100)).max(60).optional(),
  mentions: z.array(z.string().trim().max(100)).max(60).optional(),
  cta: z.string().trim().max(500).nullable().optional(),
  changeSummary: z.string().trim().max(500).optional(),
});

const generateSchema = z.object({
  brief: z.string().trim().max(5_000).optional(),
  regenerate: z.boolean().optional(),
});

const assistSchema = z.object({
  operation: z.enum([
    'REWRITE',
    'SHORTEN',
    'EXPAND',
    'CHANGE_TONE',
    'GENERATE_CTA',
    'GENERATE_HOOKS',
    'BRAND_CHECK',
    'FACT_CHECK',
  ]),
  tone: z.string().trim().max(120).optional(),
  count: z.number().int().min(1).max(10).optional(),
});

const approveSchema = z.object({ comment: z.string().trim().max(2_000).optional() });
const rejectSchema = z.object({ comment: z.string().trim().min(1).max(2_000) });
const scheduleSchema = z.object({
  scheduledAt: z.coerce.date().describe('ISO 8601 timestamp, stored and compared in UTC.'),
});

@ApiTags('content')
@ApiBearerAuth('privy')
@Controller('content')
export class ContentController {
  constructor(
    private readonly content: ContentService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('content:read')
  @ApiOperation({ summary: 'List content with cursor pagination' })
  async list(@Auth() auth: AuthContext, @Query(zodQuery(listQuerySchema)) query: z.infer<typeof listQuerySchema>) {
    return this.content.list(auth, query);
  }

  @Post()
  @RequirePermissions('content:write')
  @ApiOperation({ summary: 'Create a content item' })
  async create(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Body(zodBody(createSchema)) body: z.infer<typeof createSchema>,
  ) {
    const item = await this.content.create(auth, body);
    await this.audit.fromRequest(request, auth, {
      action: 'content.created',
      resourceType: 'ContentItem',
      resourceId: item.id,
      metadata: { contentType: item.contentType },
    });
    return item;
  }

  @Get(':id')
  @RequirePermissions('content:read')
  @ApiOperation({ summary: 'Get one content item with versions, approvals, and publications' })
  async get(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.content.get(auth, id);
  }

  @Patch(':id')
  @RequirePermissions('content:write')
  @ApiOperation({
    summary: 'Update a content item',
    description:
      'A substantive edit creates a new version and returns approved or scheduled content to DRAFT, ' +
      'because the approval applied to the previous text.',
  })
  async update(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('id') id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    const item = await this.content.update(auth, id, body);
    await this.audit.fromRequest(request, auth, {
      action: 'content.updated',
      resourceType: 'ContentItem',
      resourceId: id,
      metadata: { version: item.version, fields: Object.keys(body) },
    });
    return item;
  }

  @Get(':id/versions')
  @RequirePermissions('content:read')
  @ApiOperation({ summary: 'Version history' })
  async versions(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.content.versions(auth, id);
  }

  @Post(':id/generate')
  @RequirePermissions('ai:generate')
  @ApiOperation({ summary: 'Generate copy with the ContentCreationAgent' })
  async generate(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('id') id: string,
    @Body(zodBody(generateSchema)) body: z.infer<typeof generateSchema>,
  ) {
    const result = await this.content.generate(auth, id, body);
    await this.audit.fromRequest(request, auth, {
      action: 'content.generated',
      resourceType: 'ContentItem',
      resourceId: id,
      metadata: { executionId: result.generation.executionId },
    });
    return result;
  }

  @Post(':id/assist')
  @RequirePermissions('ai:generate')
  @ApiOperation({
    summary: 'Studio assistance: rewrite, shorten, expand, tone, CTA, hooks, brand check, fact check',
  })
  async assist(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Body(zodBody(assistSchema)) body: z.infer<typeof assistSchema>,
  ) {
    return this.content.assist(auth, id, body.operation, {
      ...(body.tone ? { tone: body.tone } : {}),
      ...(body.count ? { count: body.count } : {}),
    });
  }

  @Post(':id/submit')
  @RequirePermissions('content:write')
  @ApiOperation({ summary: 'Submit for approval' })
  async submit(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.content.submitForApproval(auth, id);
  }

  @Post(':id/approve')
  @RequirePermissions('content:approve')
  @ApiOperation({ summary: 'Approve content for publication' })
  async approve(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('id') id: string,
    @Body(zodBody(approveSchema)) body: z.infer<typeof approveSchema>,
  ) {
    const item = await this.content.approve(auth, id, body.comment);
    await this.audit.fromRequest(request, auth, {
      action: 'content.approved',
      resourceType: 'ContentItem',
      resourceId: id,
      metadata: { version: item.version },
    });
    return item;
  }

  @Post(':id/reject')
  @RequirePermissions('content:approve')
  @ApiOperation({ summary: 'Reject content with a required comment' })
  async reject(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('id') id: string,
    @Body(zodBody(rejectSchema)) body: z.infer<typeof rejectSchema>,
  ) {
    const item = await this.content.reject(auth, id, body.comment);
    await this.audit.fromRequest(request, auth, {
      action: 'content.rejected',
      resourceType: 'ContentItem',
      resourceId: id,
    });
    return item;
  }

  @Post(':id/schedule')
  @RequirePermissions('content:schedule')
  @ApiOperation({ summary: 'Schedule approved content for future publication' })
  async schedule(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('id') id: string,
    @Body(zodBody(scheduleSchema)) body: z.infer<typeof scheduleSchema>,
  ) {
    const item = await this.content.schedule(auth, id, body.scheduledAt);
    await this.audit.fromRequest(request, auth, {
      action: 'content.scheduled',
      resourceType: 'ContentItem',
      resourceId: id,
      metadata: { scheduledAt: body.scheduledAt.toISOString(), version: item.version },
    });
    return item;
  }

  @Post(':id/publish')
  @RequirePermissions('content:publish')
  @ApiOperation({
    summary: 'Queue immediate publication',
    description:
      'Returns as soon as the job is queued. The worker performs the publish under a distributed ' +
      'lock with an idempotency key, so a duplicate request cannot post twice.',
  })
  async publish(@Auth() auth: AuthContext, @Req() request: Request, @Param('id') id: string) {
    const result = await this.content.publishNow(auth, id);
    await this.audit.fromRequest(request, auth, {
      action: 'content.publish_requested',
      resourceType: 'ContentItem',
      resourceId: id,
      metadata: { contentVersion: result.contentVersion },
    });
    return result;
  }

  @Post(':id/cancel')
  @RequirePermissions('content:write')
  @ApiOperation({ summary: 'Cancel scheduled or draft content' })
  async cancel(@Auth() auth: AuthContext, @Req() request: Request, @Param('id') id: string) {
    const item = await this.content.cancel(auth, id);
    await this.audit.fromRequest(request, auth, {
      action: 'content.cancelled',
      resourceType: 'ContentItem',
      resourceId: id,
    });
    return item;
  }

  @Delete(':id')
  @RequirePermissions('content:delete')
  @ApiOperation({ summary: 'Delete content that has never been published' })
  async remove(@Auth() auth: AuthContext, @Req() request: Request, @Param('id') id: string) {
    await this.content.delete(auth, id);
    await this.audit.fromRequest(request, auth, {
      action: 'content.deleted',
      resourceType: 'ContentItem',
      resourceId: id,
    });
    return { deleted: true };
  }
}
