import { z } from 'zod';
import type { AuthContext } from '@kult/auth';
import { assertPermission } from '@kult/auth';
import type { Permission } from '@kult/shared';

/**
 * Copilot tool registry.
 *
 * Three rules govern every tool here, and they are enforced in code rather than
 * in the prompt:
 *
 *  1. Authorization is re-checked server-side on every invocation, against the
 *     caller's role. A model asking to call a tool proves nothing.
 *
 *  2. Tenant scope comes from the AuthContext, never from tool arguments. A model
 *     cannot pass an organizationId, because the parameter does not exist.
 *
 *  3. Side-effecting tools are confirmation-gated. They return a proposal
 *     describing exactly what would happen and stop. The action runs only after
 *     the user confirms it through the API, in a separate request. This is what
 *     stops a vague question from publishing a post.
 */

export interface ToolInvocationContext {
  auth: AuthContext;
  /** Ids the user has explicitly confirmed in this request. */
  confirmedActionIds: Set<string>;
}

export interface ToolResult {
  status: 'OK' | 'CONFIRMATION_REQUIRED' | 'DENIED' | 'ERROR';
  data?: unknown;
  /** Present for CONFIRMATION_REQUIRED: what the user is being asked to approve. */
  proposal?: {
    actionId: string;
    summary: string;
    details: Record<string, unknown>;
  };
  message?: string;
}

export interface CopilotTool<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: Schema;
  /** Permission the caller must hold. */
  permission: Permission;
  /**
   * True for tools that change state or reach the outside world. These never
   * execute on the model's say-so alone.
   */
  requiresConfirmation: boolean;
  handler: (input: z.infer<Schema>, context: ToolInvocationContext) => Promise<unknown>;
  /** Builds the human-readable confirmation prompt. */
  describeAction?: (input: z.infer<Schema>) => string;
}

export class CopilotToolRegistry {
  private readonly tools = new Map<string, CopilotTool>();

  register<Schema extends z.ZodType>(tool: CopilotTool<Schema>): void {
    this.tools.set(tool.name, tool as unknown as CopilotTool);
  }

  get(name: string): CopilotTool | undefined {
    return this.tools.get(name);
  }

  /** Tools the caller's role permits. The model is only ever shown these. */
  availableFor(auth: AuthContext): CopilotTool[] {
    return [...this.tools.values()].filter((tool) => {
      try {
        assertPermission(auth, tool.permission);
        return true;
      } catch {
        return false;
      }
    });
  }

  /**
   * Invokes a tool with full validation and authorization.
   *
   * Every failure mode returns a structured ToolResult rather than throwing, so
   * the model receives an explanation it can relay and the conversation
   * continues instead of collapsing.
   */
  async invoke(
    name: string,
    rawArguments: unknown,
    context: ToolInvocationContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { status: 'ERROR', message: `No tool named "${name}" is available.` };
    }

    try {
      assertPermission(context.auth, tool.permission);
    } catch {
      return {
        status: 'DENIED',
        message:
          `Your role (${context.auth.role}) does not permit "${name}". ` +
          'Ask an administrator to perform this action or to change your role.',
      };
    }

    const parsed = tool.parameters.safeParse(rawArguments);
    if (!parsed.success) {
      return {
        status: 'ERROR',
        message:
          `Invalid arguments for "${name}": ` +
          parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
      };
    }

    if (tool.requiresConfirmation) {
      const actionId = actionIdFor(name, parsed.data);
      if (!context.confirmedActionIds.has(actionId)) {
        return {
          status: 'CONFIRMATION_REQUIRED',
          proposal: {
            actionId,
            summary: tool.describeAction?.(parsed.data) ?? `Run ${name}`,
            details: parsed.data as Record<string, unknown>,
          },
          message:
            'This action changes state and needs explicit confirmation. Describe what will happen ' +
            'and wait for the user to confirm.',
        };
      }
    }

    try {
      const data = await tool.handler(parsed.data, context);
      return { status: 'OK', data };
    } catch (error) {
      return {
        status: 'ERROR',
        message: error instanceof Error ? error.message : 'The tool failed.',
      };
    }
  }
}

/**
 * Stable id for a proposed action, derived from the tool and its arguments.
 * Confirming one proposal cannot authorise a different call.
 */
export function actionIdFor(toolName: string, args: unknown): string {
  const canonical = JSON.stringify(args, Object.keys(args as object).sort());
  let hash = 0;
  const input = `${toolName}:${canonical}`;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  return `${toolName}_${(hash >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------
// Note: no schema accepts an organizationId. Tenant scope is taken from the
// authenticated context so the model cannot reach another tenant's data.

export const toolSchemas = {
  searchResearch: z.object({
    query: z.string().describe('What to search the collected research corpus for.'),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  getTrendingTopics: z.object({
    limit: z.number().int().min(1).max(50).default(10),
    minScore: z.number().min(0).max(100).default(0),
  }),
  getNiches: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
  getOpportunities: z.object({
    status: z.enum(['NEW', 'REVIEWED', 'SELECTED', 'CONVERTED', 'DISMISSED', 'EXPIRED']).nullable().default(null),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  getBrandKnowledge: z.object({
    query: z.string(),
    limit: z.number().int().min(1).max(25).default(8),
  }),
  getCampaigns: z.object({
    status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']).nullable().default(null),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  createCampaign: z.object({
    goal: z.string(),
    durationDays: z.number().int().min(1).max(90).default(14),
    platforms: z.array(z.enum(['X', 'INSTAGRAM', 'LINKEDIN'])).min(1),
  }),
  generateContent: z.object({
    contentType: z.enum([
      'X_POST',
      'X_THREAD',
      'INSTAGRAM_CAPTION',
      'INSTAGRAM_REEL',
      'INSTAGRAM_CAROUSEL',
      'LINKEDIN_POST',
      'LINKEDIN_ARTICLE',
    ]),
    brief: z.string(),
    opportunityId: z.string().nullable().default(null),
  }),
  getAnalytics: z.object({
    periodDays: z.number().int().min(1).max(365).default(30),
  }),
  analyzePerformance: z.object({
    periodDays: z.number().int().min(1).max(365).default(30),
  }),
  getContentReadyToPublish: z.object({
    limit: z.number().int().min(1).max(50).default(20),
  }),
  scheduleContent: z.object({
    contentItemId: z.string(),
    scheduledAtIso: z.string().describe('ISO 8601 timestamp, interpreted in UTC.'),
  }),
  publishContent: z.object({
    contentItemId: z.string(),
  }),
  deleteContent: z.object({
    contentItemId: z.string(),
  }),
  changeAutomationMode: z.object({
    mode: z.enum(['MANUAL', 'COPILOT', 'AUTOPILOT']),
  }),
} as const;
