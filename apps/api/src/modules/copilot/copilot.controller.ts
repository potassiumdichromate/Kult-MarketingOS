import { Body, Controller, Get, Inject, Injectable, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import OpenAI from 'openai';
import { z } from 'zod';
import type { AuthContext } from '@kult/auth';
import { type PrismaClient, requireInOrg, scoped } from '@kult/database';
import { AIService, BrandContextLoader, MarketingCopilotAgent } from '@kult/ai';
import { NotFoundError } from '@kult/shared';
import { Auth, RequirePermissions } from '../../auth/auth.guard.js';
import { AI_SERVICE, BRAND_LOADER, OPENAI_CLIENT, PRISMA } from '../../common/tokens.js';
import { zodBody, zodQuery } from '../../common/zod.pipe.js';
import { CopilotToolsFactory } from './copilot.tools.js';

const createThreadSchema = z.object({
  title: z.string().trim().max(200).optional(),
});

const messageSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  /**
   * Action ids the user has explicitly confirmed. A side-effecting tool runs
   * only when its proposal id appears here, which is what stops a vague question
   * from publishing.
   */
  confirmedActionIds: z.array(z.string().max(200)).max(10).default([]),
});

const listThreadsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

@Injectable()
export class CopilotService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AI_SERVICE) private readonly ai: AIService,
    @Inject(BRAND_LOADER) private readonly brand: BrandContextLoader,
    @Inject(OPENAI_CLIENT) private readonly openai: OpenAI,
    private readonly toolsFactory: CopilotToolsFactory,
  ) {}

  async createThread(auth: AuthContext, title?: string) {
    return this.prisma.copilotThread.create({
      data: {
        organizationId: auth.organizationId,
        userId: auth.userId,
        title: title ?? 'New conversation',
      },
      select: { id: true, title: true, createdAt: true },
    });
  }

  async listThreads(auth: AuthContext, limit: number) {
    return this.prisma.copilotThread.findMany({
      // A thread is private to the person who started it.
      where: scoped(auth, { userId: auth.userId, archivedAt: null }),
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    });
  }

  async getThread(auth: AuthContext, id: string) {
    const thread = await this.prisma.copilotThread.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        userId: true,
        title: true,
        createdAt: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            role: true,
            content: true,
            toolCalls: true,
            createdAt: true,
          },
        },
      },
    });
    const found = requireInOrg(thread, auth, 'Conversation');
    if (found.userId !== auth.userId) throw new NotFoundError('Conversation');
    return found;
  }

  /** Runs one copilot turn and persists both sides of the exchange. */
  async sendMessage(auth: AuthContext, threadId: string, input: z.infer<typeof messageSchema>) {
    const thread = await this.getThread(auth, threadId);

    const history = thread.messages
      .filter((message) => message.role === 'USER' || message.role === 'ASSISTANT')
      .slice(-20)
      .map((message) => ({
        role: message.role as 'USER' | 'ASSISTANT',
        content: message.content,
      }));

    await this.prisma.copilotMessage.create({
      data: { threadId, role: 'USER', content: input.message },
    });

    const agent = new MarketingCopilotAgent(
      this.ai,
      this.toolsFactory.build(),
      this.brand,
      this.prisma,
      this.openai,
    );

    const result = await agent.run({
      auth,
      threadId,
      userMessage: input.message,
      history,
      confirmedActionIds: input.confirmedActionIds,
    });

    const assistantMessage = await this.prisma.copilotMessage.create({
      data: {
        threadId,
        role: 'ASSISTANT',
        content: result.text,
        toolCalls: result.toolCalls.map((call) => ({
          name: call.name,
          status: call.result.status,
          latencyMs: call.latencyMs,
        })) as unknown as object,
      },
      select: { id: true, content: true, createdAt: true },
    });

    // Name the thread from its opening question.
    if (thread.messages.length === 0) {
      await this.prisma.copilotThread.update({
        where: { id: threadId },
        data: { title: input.message.slice(0, 80) },
      });
    } else {
      await this.prisma.copilotThread.update({
        where: { id: threadId },
        data: { updatedAt: new Date() },
      });
    }

    return {
      message: assistantMessage,
      toolCalls: result.toolCalls.map((call) => ({
        name: call.name,
        status: call.result.status,
        message: call.result.message,
      })),
      pendingConfirmations: result.pendingConfirmations,
      usage: result.usage,
    };
  }
}

@ApiTags('copilot')
@ApiBearerAuth('privy')
@Controller('copilot')
export class CopilotController {
  constructor(private readonly copilot: CopilotService) {}

  @Post('threads')
  @RequirePermissions('ai:copilot')
  @ApiOperation({ summary: 'Start a conversation' })
  async createThread(
    @Auth() auth: AuthContext,
    @Body(zodBody(createThreadSchema)) body: z.infer<typeof createThreadSchema>,
  ) {
    return this.copilot.createThread(auth, body.title);
  }

  @Get('threads')
  @RequirePermissions('ai:copilot')
  @ApiOperation({ summary: 'List your conversations' })
  async listThreads(
    @Auth() auth: AuthContext,
    @Query(zodQuery(listThreadsSchema)) query: z.infer<typeof listThreadsSchema>,
  ) {
    return this.copilot.listThreads(auth, query.limit);
  }

  @Get('threads/:id')
  @RequirePermissions('ai:copilot')
  @ApiOperation({ summary: 'Conversation with its full message history' })
  async getThread(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.copilot.getThread(auth, id);
  }

  @Post('threads/:id/messages')
  @RequirePermissions('ai:copilot')
  @ApiOperation({
    summary: 'Send a message',
    description:
      'The copilot answers using authorised tools over this organization\'s data. Tools that ' +
      'change state return a proposal in pendingConfirmations instead of acting; resend with the ' +
      'proposal actionId in confirmedActionIds to carry it out.',
  })
  async sendMessage(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Body(zodBody(messageSchema)) body: z.infer<typeof messageSchema>,
  ) {
    return this.copilot.sendMessage(auth, id, body);
  }
}
