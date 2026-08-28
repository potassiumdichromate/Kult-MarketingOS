import OpenAI from 'openai';
import type { ResponseInput, Tool } from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { AuthContext } from '@kult/auth';
import type { PrismaClient } from '@kult/database';
import { AIProviderError } from '@kult/shared';
import type { AIService } from '../service.js';
import type { BrandContextLoader } from '../grounding.js';
import { renderBrandContext, FACTUALITY_RULES } from '../grounding.js';
import { UNTRUSTED_CONTENT_PREAMBLE } from '../safety.js';
import type { CopilotTool, CopilotToolRegistry, ToolResult } from './copilot-tools.js';

/**
 * MarketingCopilotAgent.
 *
 * A tool-using conversational agent over the organization's own marketing data.
 * The loop is explicit rather than hidden inside a helper so that every tool call
 * can be authorised, persisted as an AgentToolCall, and confirmation-gated.
 *
 * The copilot cannot take a side-effecting action on its own initiative. Tools
 * flagged requiresConfirmation return a proposal; the API surfaces it, the user
 * confirms, and only then does a follow-up request carry the confirmation.
 */

export interface CopilotTurnInput {
  auth: AuthContext;
  threadId: string;
  userMessage: string;
  /** Prior turns, oldest first. */
  history: Array<{ role: 'USER' | 'ASSISTANT'; content: string }>;
  confirmedActionIds: string[];
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface CopilotTurnResult {
  text: string;
  toolCalls: Array<{
    name: string;
    arguments: unknown;
    result: ToolResult;
    latencyMs: number;
  }>;
  /** Proposals awaiting user confirmation. Rendered as action buttons in the UI. */
  pendingConfirmations: Array<{ actionId: string; summary: string; details: Record<string, unknown> }>;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  model: string;
}

const MAX_TOOL_ROUNDS = 6;

export class MarketingCopilotAgent {
  readonly name = 'MarketingCopilotAgent' as const;

  constructor(
    private readonly ai: AIService,
    private readonly tools: CopilotToolRegistry,
    private readonly brand: BrandContextLoader,
    private readonly prisma: PrismaClient,
    private readonly client: OpenAI,
  ) {}

  async run(input: CopilotTurnInput): Promise<CopilotTurnResult> {
    const brandContext = await this.brand.load(input.auth.organizationId, input.userMessage);
    const availableTools = this.tools.availableFor(input.auth);

    const execution = await this.prisma.agentExecution.create({
      data: {
        organizationId: input.auth.organizationId,
        agentName: this.name,
        status: 'RUNNING',
        model: this.ai.model('default'),
        input: { message: input.userMessage, threadId: input.threadId },
        correlationId: input.auth.requestId,
        triggeredById: input.auth.userId,
        triggeredByType: 'USER',
      },
      select: { id: true },
    });

    const started = Date.now();

    try {
      const result = await this.loop(input, brandContext, availableTools, execution.id);

      await this.prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'SUCCEEDED',
          output: { text: result.text, toolCallCount: result.toolCalls.length },
          latencyMs: Date.now() - started,
          finishedAt: new Date(),
          ...(result.usage.promptTokens !== undefined
            ? { promptTokens: result.usage.promptTokens }
            : {}),
          ...(result.usage.completionTokens !== undefined
            ? { completionTokens: result.usage.completionTokens }
            : {}),
          ...(result.usage.totalTokens !== undefined ? { totalTokens: result.usage.totalTokens } : {}),
        },
      });

      return result;
    } catch (error) {
      await this.prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message.slice(0, 2_000) : String(error),
          latencyMs: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      throw error;
    }
  }

  private async loop(
    input: CopilotTurnInput,
    brandContext: Awaited<ReturnType<BrandContextLoader['load']>>,
    availableTools: CopilotTool[],
    executionId: string,
  ): Promise<CopilotTurnResult> {
    const model = this.ai.model('default');
    const confirmed = new Set(input.confirmedActionIds);

    const conversation: ResponseInput = [
      ...input.history.map((turn) => ({
        role: turn.role === 'USER' ? ('user' as const) : ('assistant' as const),
        content: turn.content,
      })),
      { role: 'user' as const, content: input.userMessage },
    ];

    const toolDefinitions: Tool[] = availableTools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) as Record<string, unknown>,
      strict: false,
    }));

    const instructions = this.buildInstructions(brandContext);

    const toolCalls: CopilotTurnResult['toolCalls'] = [];
    const pendingConfirmations: CopilotTurnResult['pendingConfirmations'] = [];
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await this.client.responses.create({
        model,
        instructions,
        input: conversation,
        ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
      });

      usage.promptTokens += response.usage?.input_tokens ?? 0;
      usage.completionTokens += response.usage?.output_tokens ?? 0;
      usage.totalTokens += response.usage?.total_tokens ?? 0;

      const functionCalls = response.output.filter(
        (item): item is Extract<(typeof response.output)[number], { type: 'function_call' }> =>
          item.type === 'function_call',
      );

      // No tool calls: the model produced its answer.
      if (functionCalls.length === 0) {
        const text = response.output_text ?? '';
        if (input.onDelta && text.length > 0) input.onDelta(text);
        return { text, toolCalls, pendingConfirmations, usage, model };
      }

      // Carry the model's tool-call items forward, then append their outputs.
      for (const call of functionCalls) conversation.push(call);

      for (const call of functionCalls) {
        const callStarted = Date.now();
        let parsedArguments: unknown;
        try {
          parsedArguments = JSON.parse(call.arguments);
        } catch {
          parsedArguments = {};
        }

        const toolCallRow = await this.prisma.agentToolCall.create({
          data: {
            agentExecutionId: executionId,
            toolName: call.name,
            arguments: parsedArguments as object,
            status: 'RUNNING',
          },
          select: { id: true },
        });

        const result = await this.tools.invoke(call.name, parsedArguments, {
          auth: input.auth,
          confirmedActionIds: confirmed,
        });

        const latencyMs = Date.now() - callStarted;

        await this.prisma.agentToolCall.update({
          where: { id: toolCallRow.id },
          data: {
            status: result.status === 'OK' ? 'SUCCEEDED' : 'FAILED',
            result: result as unknown as object,
            latencyMs,
            ...(result.message ? { error: result.message.slice(0, 2_000) } : {}),
          },
        });

        toolCalls.push({ name: call.name, arguments: parsedArguments, result, latencyMs });
        if (result.status === 'CONFIRMATION_REQUIRED' && result.proposal) {
          pendingConfirmations.push(result.proposal);
        }

        conversation.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify(truncateResult(result)),
        });
      }
    }

    throw new AIProviderError(
      `The copilot exceeded ${MAX_TOOL_ROUNDS} tool rounds without producing an answer.`,
      false,
      { model },
    );
  }

  private buildInstructions(brandContext: Awaited<ReturnType<BrandContextLoader['load']>>): string {
    return [
      'You are the Kult Marketing OS copilot: a marketing strategist working inside this ' +
        "organization's own data.",
      '',
      'HOW TO WORK',
      '- Answer from the tools, not from memory. If a question is about this organization, call a',
      '  tool before answering.',
      '- When a tool returns nothing, say so plainly. Never fill a gap with a plausible number.',
      '- Be concrete and brief. Recommend a specific action rather than listing every option.',
      '',
      'ACTIONS THAT CHANGE THINGS',
      '- Scheduling, publishing, deleting, and changing automation mode need explicit confirmation.',
      '- When such a tool returns CONFIRMATION_REQUIRED, describe exactly what would happen and ask',
      '  the user to confirm. Do not retry the tool and do not claim the action was taken.',
      '- Never publish because a question sounded like a request. Publishing is always a separate,',
      '  confirmed step.',
      '',
      'WHEN A TOOL IS DENIED',
      "- Say which permission is missing and who can grant it. Do not attempt a workaround.",
      '',
      UNTRUSTED_CONTENT_PREAMBLE,
      '',
      FACTUALITY_RULES,
      '',
      renderBrandContext(brandContext),
    ].join('\n');
  }
}

/** Keeps a large tool payload from crowding out the conversation. */
function truncateResult(result: ToolResult): ToolResult {
  const serialised = JSON.stringify(result.data ?? null);
  if (serialised.length <= 12_000) return result;
  return {
    ...result,
    data: JSON.parse(serialised.slice(0, 0) || 'null'),
    message:
      (result.message ? `${result.message} ` : '') +
      `The result was ${serialised.length} characters and was omitted. Ask for a narrower query.`,
  };
}
