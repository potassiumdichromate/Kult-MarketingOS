'use client';

import { Bot, Clock, Cpu } from 'lucide-react';
import { useState } from 'react';
import { useAgentExecutions, useAgents } from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  statusTone,
} from '@/components/ui';

/**
 * Agent activity.
 *
 * Every AI decision in the system leaves an AgentExecution row. This screen is
 * the audit surface for that: which agent ran, on whose behalf, with which
 * model, how long it took, how many tokens it used, and how many tools it
 * called.
 */
export default function AgentsPage() {
  const [agentName, setAgentName] = useState('');

  const agents = useAgents();
  const executions = useAgentExecutions({
    ...(agentName ? { agentName } : {}),
    limit: 100,
  });

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="Agent activity"
        description="Every AI run is recorded with its model, token usage, latency and tool calls."
        actions={
          <Select
            value={agentName}
            onChange={(event) => setAgentName(event.target.value)}
            className="w-56"
            aria-label="Filter by agent"
          >
            <option value="">All agents</option>
            {(agents.data ?? []).map((agent) => (
              <option key={agent.id} value={agent.name}>
                {agent.name}
              </option>
            ))}
          </Select>
        }
      />

      {/* Registered agents */}
      <Card>
        <CardHeader>
          <CardTitle>Registered agents</CardTitle>
        </CardHeader>
        <CardContent>
          {agents.isLoading ? (
            <Skeleton className="h-40" />
          ) : agents.error ? (
            <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {(agents.data ?? []).map((agent) => (
                <div key={agent.id} className="rounded-lg border border-border/50 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{agent.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{agent.description}</p>
                    </div>
                    <Badge tone={agent.enabled ? 'success' : 'neutral'}>
                      {agent.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                  </div>
                  <div className="tabular mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Cpu className="h-3 w-3" aria-hidden />
                      {agent.modelTier}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" aria-hidden />
                      {Math.round(agent.timeoutMs / 1000)}s timeout
                    </span>
                    <span>{agent.maxRetries} retries</span>
                    {agent.toolNames.length > 0 ? (
                      <span>{agent.toolNames.length} tools</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Execution log */}
      <Card>
        <CardHeader>
          <CardTitle>Recent executions</CardTitle>
        </CardHeader>
        <CardContent>
          {executions.isLoading ? (
            <Skeleton className="h-64" />
          ) : executions.error ? (
            <ErrorState error={executions.error} onRetry={() => void executions.refetch()} />
          ) : (executions.data ?? []).length === 0 ? (
            <EmptyState
              icon={<Bot className="h-8 w-8" />}
              title="No agent runs yet"
              description="Agents run when you generate content, run research, build a campaign, or use the copilot."
            />
          ) : (
            <ul className="divide-y divide-border/40">
              {(executions.data ?? []).map((execution) => (
                <li key={execution.id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="tabular w-16 shrink-0 text-xs text-muted-foreground">
                      {new Date(execution.startedAt).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {execution.agentName}
                    </span>
                    <Badge tone={statusTone(execution.status)}>{execution.status}</Badge>
                    {execution.model ? (
                      <span className="tabular text-xs text-muted-foreground">
                        {execution.model}
                      </span>
                    ) : null}
                    {execution.latencyMs !== null ? (
                      <span className="tabular text-xs text-muted-foreground">
                        {(execution.latencyMs / 1000).toFixed(1)}s
                      </span>
                    ) : null}
                    {execution.totalTokens ? (
                      <span className="tabular text-xs text-muted-foreground">
                        {execution.totalTokens.toLocaleString()} tokens
                      </span>
                    ) : null}
                    {execution._count.toolCalls > 0 ? (
                      <Badge>{execution._count.toolCalls} tools</Badge>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {execution.triggeredBy?.displayName ??
                        execution.triggeredByType.toLowerCase()}
                    </span>
                    <span className="tabular text-xs text-muted-foreground/70">
                      {relativeTime(execution.startedAt)}
                    </span>
                  </div>
                  {execution.error ? (
                    <p className="mt-1 pl-16 text-xs text-destructive">{execution.error}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
