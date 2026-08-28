import type { z } from 'zod';
import type { PrismaClient } from '@kult/database';
import type { AgentName } from '@kult/shared';
import { redactSecrets } from '@kult/shared';
import type { AIService, ModelTier } from '../service.js';
import type { BrandContextLoader } from '../grounding.js';
import type { KnowledgeBase } from '../knowledge.js';

/**
 * Agent framework.
 *
 * Each agent is an explicit service with a declared input schema, output schema,
 * model tier, timeout, and retry policy - not a prompt string buried in a route
 * handler. Running one always produces an AgentExecution row, so every AI
 * decision in the system is traceable to an agent, an organization, a trigger,
 * a model, a token count, and a latency.
 */

export interface AgentDefinition<Input extends z.ZodType, Output extends z.ZodType> {
  name: AgentName;
  description: string;
  inputSchema: Input;
  outputSchema: Output;
  modelTier: ModelTier;
  timeoutMs: number;
  maxRetries: number;
  /** Tools this agent may use. Empty for agents that only transform text. */
  toolNames: string[];
  /** Whether this agent may use the provider's hosted web search. */
  usesWebSearch: boolean;
}

/** Everything an agent needs to do its work, injected rather than imported. */
export interface AgentContext {
  organizationId: string;
  prisma: PrismaClient;
  ai: AIService;
  brand: BrandContextLoader;
  knowledge: KnowledgeBase;
  /** Ties this run to the originating request or queue job. */
  correlationId: string;
  /** Present when a person triggered the run. */
  triggeredByUserId?: string;
  workflowExecutionId?: string;
}

export abstract class Agent<Input extends z.ZodType, Output extends z.ZodType> {
  abstract readonly definition: AgentDefinition<Input, Output>;

  /** The agent's own work. Wrapped by AgentRunner for persistence and timing. */
  protected abstract execute(
    context: AgentContext,
    input: z.infer<Input>,
  ): Promise<z.infer<Output>>;

  /**
   * Validates input, runs the agent under its declared timeout, and returns the
   * validated output. Persistence is handled by AgentRunner so this stays pure
   * enough to unit test without a database.
   */
  async run(context: AgentContext, rawInput: unknown): Promise<z.infer<Output>> {
    const input = this.definition.inputSchema.parse(rawInput) as z.infer<Input>;
    const result = await withTimeout(
      this.execute(context, input),
      this.definition.timeoutMs,
      this.definition.name,
    );
    return this.definition.outputSchema.parse(result) as z.infer<Output>;
  }
}

export interface AgentRunResult<T> {
  output: T;
  executionId: string;
}

/**
 * Runs agents and records their executions.
 *
 * The execution row is created *before* the agent runs, so an agent that hangs
 * or crashes still leaves a RUNNING/FAILED trace rather than disappearing.
 */
export class AgentRunner {
  constructor(private readonly prisma: PrismaClient) {}

  async run<Input extends z.ZodType, Output extends z.ZodType>(
    agent: Agent<Input, Output>,
    context: AgentContext,
    input: unknown,
  ): Promise<AgentRunResult<z.infer<Output>>> {
    const definition = agent.definition;
    const agentRow = await this.prisma.agent.findUnique({
      where: { name: definition.name },
      select: { id: true },
    });

    const execution = await this.prisma.agentExecution.create({
      data: {
        organizationId: context.organizationId,
        ...(agentRow ? { agentId: agentRow.id } : {}),
        agentName: definition.name,
        ...(context.workflowExecutionId
          ? { workflowExecutionId: context.workflowExecutionId }
          : {}),
        status: 'RUNNING',
        model: context.ai.model(definition.modelTier),
        // Inputs can carry user text; secrets never belong here, but redact defensively.
        input: redactSecrets(input) as object,
        correlationId: context.correlationId,
        ...(context.triggeredByUserId
          ? { triggeredById: context.triggeredByUserId, triggeredByType: 'USER' as const }
          : { triggeredByType: 'AGENT' as const }),
      },
      select: { id: true },
    });

    const started = Date.now();

    try {
      const output = await agent.run(context, input);

      await this.prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'SUCCEEDED',
          output: redactSecrets(output) as object,
          latencyMs: Date.now() - started,
          finishedAt: new Date(),
        },
      });

      return { output, executionId: execution.id };
    } catch (error) {
      await this.prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
          latencyMs: Date.now() - started,
          finishedAt: new Date(),
        },
      });
      throw error;
    }
  }

  /** Records token accounting reported by the AI service onto an execution. */
  async recordUsage(
    executionId: string,
    usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
  ): Promise<void> {
    await this.prisma.agentExecution.update({
      where: { id: executionId },
      data: {
        ...(usage.promptTokens !== undefined ? { promptTokens: usage.promptTokens } : {}),
        ...(usage.completionTokens !== undefined ? { completionTokens: usage.completionTokens } : {}),
        ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
      },
    });
  }
}

export class AgentTimeoutError extends Error {
  constructor(agentName: string, timeoutMs: number) {
    super(`${agentName} exceeded its ${timeoutMs}ms timeout.`);
    this.name = 'AgentTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, agentName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentTimeoutError(agentName, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
