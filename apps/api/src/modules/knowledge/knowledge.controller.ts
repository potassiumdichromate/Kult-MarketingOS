import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthContext } from '@kult/auth';
import { RISK_LEVELS, ValidationError } from '@kult/shared';
import { Auth, RequirePermissions } from '../../auth/auth.guard.js';
import { AuditService } from '../../common/audit.service.js';
import { zodBody, zodQuery } from '../../common/zod.pipe.js';
import { KnowledgeService } from './knowledge.service.js';

/** Uploads are capped well below any provider limit; documents are text. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const profileSchema = z.object({
  description: z.string().trim().min(10).max(10_000),
  positioning: z.string().trim().max(5_000).nullable().optional(),
  mission: z.string().trim().max(5_000).nullable().optional(),
  voiceSummary: z.string().trim().max(5_000).nullable().optional(),
  toneAttributes: z.array(z.string().trim().max(60)).max(20).optional(),
  writingRules: z.array(z.string().trim().max(500)).max(50).optional(),
  bannedPhrases: z.array(z.string().trim().max(200)).max(100).optional(),
});

const entitySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('PRODUCT'),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(5_000),
    url: z.url().optional(),
  }),
  z.object({
    type: z.literal('FEATURE'),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(5_000),
    productId: z.string().optional(),
  }),
  z.object({
    type: z.literal('AUDIENCE'),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(5_000),
    painPoints: z.array(z.string().trim().max(300)).max(25).optional(),
    channels: z.array(z.string().trim().max(80)).max(25).optional(),
  }),
  z.object({
    type: z.literal('COMPETITOR'),
    name: z.string().trim().min(1).max(160),
    websiteUrl: z.url().optional(),
    notes: z.string().trim().max(5_000).optional(),
  }),
  z.object({
    type: z.literal('APPROVED_CLAIM'),
    claim: z.string().trim().min(3).max(2_000),
    evidenceUrl: z.url().optional(),
    expiresAt: z.coerce.date().optional(),
  }),
  z.object({
    type: z.literal('FORBIDDEN_CLAIM'),
    claim: z.string().trim().min(3).max(2_000),
    reason: z.string().trim().min(3).max(1_000),
  }),
  z.object({
    type: z.literal('GUIDELINE'),
    category: z.string().trim().min(1).max(120),
    rule: z.string().trim().min(3).max(2_000),
    severity: z.enum(RISK_LEVELS).optional(),
  }),
]);

const ingestUrlSchema = z.object({
  url: z.url(),
  title: z.string().trim().max(300).optional(),
});

const ingestTextSchema = z.object({
  title: z.string().trim().min(1).max(300),
  text: z.string().trim().min(20).max(500_000),
});

const searchQuerySchema = z.object({
  query: z.string().trim().min(2).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const entityTypeSchema = z.enum([
  'PRODUCT',
  'FEATURE',
  'AUDIENCE',
  'COMPETITOR',
  'APPROVED_CLAIM',
  'FORBIDDEN_CLAIM',
  'GUIDELINE',
]);

@ApiTags('knowledge')
@ApiBearerAuth('privy')
@Controller('knowledge')
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('knowledge:read')
  @ApiOperation({ summary: 'Complete brand knowledge base' })
  async overview(@Auth() auth: AuthContext) {
    return this.knowledge.overview(auth);
  }

  @Get('search')
  @RequirePermissions('knowledge:read')
  @ApiOperation({ summary: 'Semantic search over indexed brand knowledge' })
  async search(
    @Auth() auth: AuthContext,
    @Query(zodQuery(searchQuerySchema)) query: z.infer<typeof searchQuerySchema>,
  ) {
    return this.knowledge.search(auth, query.query, query.limit);
  }

  @Put('profile')
  @RequirePermissions('knowledge:write')
  @ApiOperation({ summary: 'Create or update the brand profile' })
  async upsertProfile(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Body(zodBody(profileSchema)) body: z.infer<typeof profileSchema>,
  ) {
    const profile = await this.knowledge.upsertProfile(auth, body);
    await this.audit.fromRequest(request, auth, {
      action: 'knowledge.created',
      resourceType: 'BrandProfile',
      resourceId: profile.id,
    });
    return profile;
  }

  @Post()
  @RequirePermissions('knowledge:write')
  @ApiOperation({
    summary: 'Add a knowledge entity',
    description:
      'Products, features, audiences, competitors, approved claims, forbidden claims, and ' +
      'guidelines. Everything except forbidden claims is embedded for retrieval.',
  })
  async createEntity(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Body(zodBody(entitySchema)) body: z.infer<typeof entitySchema>,
  ) {
    const row = await this.knowledge.createEntity(auth, body);
    await this.audit.fromRequest(request, auth, {
      action: 'knowledge.created',
      resourceType: body.type,
      resourceId: (row as { id: string }).id,
    });
    return row;
  }

  @Post('url')
  @RequirePermissions('knowledge:write')
  @ApiOperation({
    summary: 'Ingest a public URL',
    description:
      'The URL is fetched through the SSRF-guarded client, so private, loopback, and cloud ' +
      'metadata addresses are rejected.',
  })
  async ingestUrl(
    @Auth() auth: AuthContext,
    @Body(zodBody(ingestUrlSchema)) body: z.infer<typeof ingestUrlSchema>,
  ) {
    return this.knowledge.ingestUrl(auth, body.url, body.title);
  }

  @Post('text')
  @RequirePermissions('knowledge:write')
  @ApiOperation({ summary: 'Add free text to the knowledge base' })
  async ingestText(
    @Auth() auth: AuthContext,
    @Body(zodBody(ingestTextSchema)) body: z.infer<typeof ingestTextSchema>,
  ) {
    return this.knowledge.ingestText(auth, body.title, body.text);
  }

  @Post('upload')
  @RequirePermissions('knowledge:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a text document',
    description:
      'Requires object storage. Accepts text formats whose content can genuinely be extracted; ' +
      'binary formats are refused rather than stored and never indexed.',
  })
  async upload(
    @Auth() auth: AuthContext,
    @UploadedFile()
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number } | undefined,
  ) {
    if (!file) {
      throw new ValidationError('No file was uploaded.', [
        { path: 'file', message: 'Attach a file under the "file" field.' },
      ]);
    }
    return this.knowledge.ingestUpload(auth, file);
  }

  @Delete('documents/:id')
  @RequirePermissions('knowledge:delete')
  @ApiOperation({ summary: 'Delete a source document and its indexed chunks' })
  async deleteDocument(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    await this.knowledge.deleteDocument(auth, id);
    await this.audit.fromRequest(request, auth, {
      action: 'knowledge.deleted',
      resourceType: 'SourceDocument',
      resourceId: id,
    });
    return { deleted: true };
  }

  @Delete(':type/:id')
  @RequirePermissions('knowledge:delete')
  @ApiOperation({ summary: 'Delete a knowledge entity' })
  async deleteEntity(
    @Auth() auth: AuthContext,
    @Req() request: Request,
    @Param('type') type: string,
    @Param('id') id: string,
  ) {
    const entityType = entityTypeSchema.parse(type.toUpperCase());
    await this.knowledge.deleteEntity(auth, entityType, id);
    await this.audit.fromRequest(request, auth, {
      action: 'knowledge.deleted',
      resourceType: entityType,
      resourceId: id,
    });
    return { deleted: true };
  }
}
