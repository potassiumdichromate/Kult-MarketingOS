import { z } from 'zod';
import type { PrismaClient } from '@kult/database';
import {
  CompetitorResearchAgent,
  NicheDiscoveryAgent,
  TrendResearchAgent,
} from './agents/research.js';
import {
  ContentCreationAgent,
  ContentStrategyAgent,
  OpportunityAgent,
  RepurposingAgent,
} from './agents/content.js';
import { AnalyticsAgent, CampaignAgent, OptimizationAgent } from './agents/campaign.js';
import { WORKFLOW_DEFINITIONS } from './orchestrator.js';

/**
 * Agent registry.
 *
 * Holds one instance of each agent and mirrors their declared configuration into
 * the Agent table on boot. That gives the agents screen a real, inspectable
 * record of every agent's model tier, timeout, retry policy, and schemas rather
 * than a hardcoded list in the UI.
 */

export const agents = {
  TrendResearchAgent: new TrendResearchAgent(),
  NicheDiscoveryAgent: new NicheDiscoveryAgent(),
  CompetitorResearchAgent: new CompetitorResearchAgent(),
  OpportunityAgent: new OpportunityAgent(),
  ContentStrategyAgent: new ContentStrategyAgent(),
  ContentCreationAgent: new ContentCreationAgent(),
  RepurposingAgent: new RepurposingAgent(),
  CampaignAgent: new CampaignAgent(),
  AnalyticsAgent: new AnalyticsAgent(),
  OptimizationAgent: new OptimizationAgent(),
} as const;

export type RegisteredAgentName = keyof typeof agents;

/**
 * Upserts agent and workflow definitions.
 *
 * Called once at worker startup. Idempotent: re-running it converges the rows on
 * the code's definitions without disturbing execution history, which references
 * agents by id and by name.
 */
export async function syncAgentDefinitions(prisma: PrismaClient): Promise<{
  agents: number;
  workflows: number;
}> {
  let agentCount = 0;

  for (const agent of Object.values(agents)) {
    const definition = agent.definition;
    const data = {
      description: definition.description,
      systemInstructions:
        `${definition.description} Model tier: ${definition.modelTier}. ` +
        `Web search: ${definition.usesWebSearch ? 'enabled' : 'disabled'}.`,
      modelTier: definition.modelTier,
      timeoutMs: definition.timeoutMs,
      maxRetries: definition.maxRetries,
      toolNames: definition.toolNames,
      inputSchema: safeJsonSchema(definition.inputSchema),
      outputSchema: safeJsonSchema(definition.outputSchema),
      enabled: true,
    };

    await prisma.agent.upsert({
      where: { name: definition.name },
      create: { name: definition.name, ...data },
      update: data,
    });
    agentCount += 1;
  }

  // The copilot is registered too, though it is driven by its own tool loop
  // rather than the Agent base class.
  await prisma.agent.upsert({
    where: { name: 'MarketingCopilotAgent' },
    create: {
      name: 'MarketingCopilotAgent',
      description:
        'Conversational marketing copilot with authorised, confirmation-gated tools over the ' +
        "organization's own research, content, campaign, and analytics data.",
      systemInstructions:
        'Answers from tools rather than memory. Side-effecting tools require explicit user ' +
        'confirmation before they execute.',
      modelTier: 'default',
      timeoutMs: 180_000,
      maxRetries: 1,
      toolNames: [
        'searchResearch',
        'getTrendingTopics',
        'getNiches',
        'getOpportunities',
        'getBrandKnowledge',
        'getCampaigns',
        'createCampaign',
        'generateContent',
        'getAnalytics',
        'analyzePerformance',
        'getContentReadyToPublish',
        'scheduleContent',
        'publishContent',
        'deleteContent',
        'changeAutomationMode',
      ],
      enabled: true,
    },
    update: {},
  });
  agentCount += 1;

  let workflowCount = 0;
  for (const workflow of WORKFLOW_DEFINITIONS) {
    const data = {
      description: workflow.description,
      definition: { steps: workflow.steps } as object,
      enabled: true,
    };
    await prisma.workflow.upsert({
      where: { name: workflow.name },
      create: { name: workflow.name, ...data },
      update: data,
    });
    workflowCount += 1;
  }

  return { agents: agentCount, workflows: workflowCount };
}

/**
 * Renders a Zod schema as JSON Schema for display.
 *
 * Some schemas contain constructs JSON Schema cannot express; a failure here
 * must not stop startup, so the reason is recorded instead.
 */
function safeJsonSchema(schema: z.ZodType): object {
  try {
    return z.toJSONSchema(schema, { io: 'input' }) as object;
  } catch (error) {
    return {
      unavailable: true,
      reason: error instanceof Error ? error.message : 'Schema could not be rendered as JSON Schema.',
    };
  }
}
