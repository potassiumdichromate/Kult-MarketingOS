import type { PrismaClient } from '@kult/database';
import { redactSecrets } from '@kult/shared';

/**
 * Workflow orchestration.
 *
 * The pipeline - research, trend detection, niche scoring, opportunity
 * generation, strategy, content, approval, scheduling, publishing, analytics,
 * optimization - is expressed as ordered steps whose state is written to the
 * database after every transition.
 *
 * Nothing about a run lives only in memory. A worker that dies mid-workflow
 * leaves a WorkflowExecution whose steps show exactly how far it got, which step
 * failed, and why, so the run can be reported on and resumed rather than
 * vanishing.
 */

export type StepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export interface StepState {
  name: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** Small, non-secret summary of what the step produced. */
  summary?: Record<string, unknown>;
}

export interface WorkflowStep<Ctx> {
  name: string;
  /** Return false to skip the step; the reason is recorded on the step state. */
  shouldRun?: (context: Ctx) => boolean | Promise<boolean>;
  run: (context: Ctx) => Promise<Record<string, unknown> | void>;
}

export interface WorkflowDefinition<Ctx> {
  name: string;
  description: string;
  steps: Array<WorkflowStep<Ctx>>;
}

export interface WorkflowRunOptions {
  organizationId: string;
  correlationId: string;
  triggeredByUserId?: string;
  input?: Record<string, unknown>;
}

export interface WorkflowRunResult {
  workflowExecutionId: string;
  status: 'SUCCEEDED' | 'FAILED';
  steps: StepState[];
  error?: string;
}

export class AgentOrchestrator {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Creates the WorkflowExecution row up front and returns its id.
   *
   * Split from `execute` so an API handler can enqueue work and return the id
   * immediately, keeping long-running research off the request path.
   */
  async createExecution(
    definition: { name: string },
    options: WorkflowRunOptions,
  ): Promise<string> {
    const workflow = await this.prisma.workflow.findUnique({
      where: { name: definition.name },
      select: { id: true },
    });

    const execution = await this.prisma.workflowExecution.create({
      data: {
        organizationId: options.organizationId,
        ...(workflow ? { workflowId: workflow.id } : {}),
        workflowName: definition.name,
        status: 'PENDING',
        input: redactSecrets(options.input ?? {}) as object,
        correlationId: options.correlationId,
        ...(options.triggeredByUserId
          ? { triggeredById: options.triggeredByUserId, triggeredByType: 'USER' as const }
          : { triggeredByType: 'SYSTEM' as const }),
        steps: [],
      },
      select: { id: true },
    });

    return execution.id;
  }

  /**
   * Runs a workflow, persisting step state as it goes.
   *
   * A failing step aborts the workflow: later steps depend on earlier output, so
   * continuing would produce content built on a failed research pass.
   */
  async execute<Ctx extends { workflowExecutionId: string }>(
    definition: WorkflowDefinition<Ctx>,
    context: Ctx,
    workflowExecutionId: string,
  ): Promise<WorkflowRunResult> {
    const steps: StepState[] = definition.steps.map((step) => ({
      name: step.name,
      status: 'PENDING' as StepStatus,
    }));

    await this.prisma.workflowExecution.update({
      where: { id: workflowExecutionId },
      data: { status: 'RUNNING', steps: steps as unknown as object, startedAt: new Date() },
    });

    for (const [index, step] of definition.steps.entries()) {
      const state = steps[index];
      if (!state) continue;

      if (step.shouldRun) {
        const shouldRun = await step.shouldRun(context);
        if (!shouldRun) {
          state.status = 'SKIPPED';
          await this.persist(workflowExecutionId, steps, step.name);
          continue;
        }
      }

      state.status = 'RUNNING';
      state.startedAt = new Date().toISOString();
      await this.persist(workflowExecutionId, steps, step.name);

      try {
        const summary = await step.run(context);
        state.status = 'SUCCEEDED';
        state.finishedAt = new Date().toISOString();
        if (summary) state.summary = redactSecrets(summary);
        await this.persist(workflowExecutionId, steps, step.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.status = 'FAILED';
        state.finishedAt = new Date().toISOString();
        state.error = message.slice(0, 1_000);

        await this.prisma.workflowExecution.update({
          where: { id: workflowExecutionId },
          data: {
            status: 'FAILED',
            steps: steps as unknown as object,
            currentStep: step.name,
            error: message.slice(0, 2_000),
            finishedAt: new Date(),
          },
        });

        return { workflowExecutionId, status: 'FAILED', steps, error: message };
      }
    }

    await this.prisma.workflowExecution.update({
      where: { id: workflowExecutionId },
      data: {
        status: 'SUCCEEDED',
        steps: steps as unknown as object,
        currentStep: null,
        finishedAt: new Date(),
      },
    });

    return { workflowExecutionId, status: 'SUCCEEDED', steps };
  }

  private async persist(
    workflowExecutionId: string,
    steps: StepState[],
    currentStep: string,
  ): Promise<void> {
    await this.prisma.workflowExecution.update({
      where: { id: workflowExecutionId },
      data: { steps: steps as unknown as object, currentStep },
    });
  }
}

/** Canonical workflow names, referenced by the worker and the API. */
export const WORKFLOW_NAMES = {
  dailyResearch: 'daily-research',
  opportunityDiscovery: 'opportunity-discovery',
  campaignGeneration: 'campaign-generation',
  contentGeneration: 'content-generation',
  performanceReview: 'performance-review',
} as const;

export type WorkflowName = (typeof WORKFLOW_NAMES)[keyof typeof WORKFLOW_NAMES];

/**
 * Static workflow descriptors, seeded into the Workflow table on boot so the
 * agents screen can list what the system can run without hardcoding it in the UI.
 */
export const WORKFLOW_DEFINITIONS: Array<{
  name: WorkflowName;
  description: string;
  steps: string[];
}> = [
  {
    name: WORKFLOW_NAMES.dailyResearch,
    description:
      'Collects from every enabled research source, deduplicates, detects and scores trends, then ' +
      'discovers niches.',
    steps: ['collect-research', 'detect-trends', 'discover-niches'],
  },
  {
    name: WORKFLOW_NAMES.opportunityDiscovery,
    description:
      'Turns current trends and niches into scored, time-bounded marketing opportunities.',
    steps: ['load-signals', 'generate-opportunities', 'expire-stale-opportunities'],
  },
  {
    name: WORKFLOW_NAMES.campaignGeneration,
    description: 'Generates a full campaign strategy and content calendar from a stated goal.',
    steps: ['load-context', 'generate-plan', 'persist-campaign', 'create-calendar-drafts'],
  },
  {
    name: WORKFLOW_NAMES.contentGeneration,
    description:
      'Produces platform-specific content from an opportunity, with brand grounding, claim ' +
      'verification, and an approval decision.',
    steps: ['build-strategy', 'generate-content', 'verify-claims', 'persist-draft'],
  },
  {
    name: WORKFLOW_NAMES.performanceReview,
    description:
      'Collects post metrics, analyses performance against baselines, and proposes strategy insights.',
    steps: ['collect-metrics', 'analyze-performance', 'propose-insights'],
  },
];
