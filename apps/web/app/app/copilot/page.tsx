'use client';

import { AlertTriangle, ArrowUp, MessageSquare, Plus, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  useCopilotThread,
  useCopilotThreads,
  useCreateCopilotThread,
  useSendCopilotMessage,
} from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import type { CopilotReply } from '@/lib/types';
import { Badge, Button, Card, CardContent, Skeleton, Textarea, cn } from '@/components/ui';

const SUGGESTIONS = [
  'What should Kult post today?',
  'Find opportunities around AI gaming.',
  'Show me content we can publish today.',
  'Why did our last thread perform badly?',
  'Find three niches we should target.',
  'Analyze our last 30 days.',
];

/**
 * Marketing copilot.
 *
 * The important behaviour here is the confirmation gate. Tools that change
 * anything - scheduling, publishing, deleting, changing automation mode - come
 * back as a proposal the user must explicitly confirm. The copilot cannot act
 * because a question sounded like an instruction.
 */
export default function CopilotPage() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<CopilotReply['pendingConfirmations']>([]);

  const threads = useCopilotThreads();
  const thread = useCopilotThread(threadId);
  const createThread = useCreateCopilotThread();
  const sendMessage = useSendCopilotMessage(threadId);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Open the most recent conversation on first load.
  useEffect(() => {
    if (!threadId && threads.data && threads.data.length > 0) {
      setThreadId(threads.data[0]!.id);
    }
  }, [threads.data, threadId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [thread.data?.messages.length, sendMessage.isPending]);

  async function send(message: string, confirmedActionIds: string[] = []): Promise<void> {
    if (!message.trim()) return;

    let activeThreadId = threadId;
    if (!activeThreadId) {
      const created = await createThread.mutateAsync({});
      activeThreadId = created.id;
      setThreadId(created.id);
    }

    setDraft('');
    setPending([]);

    const reply = await sendMessage.mutateAsync({ message: message.trim(), confirmedActionIds });
    // Anything needing explicit approval surfaces as an action card.
    setPending(reply.pendingConfirmations);
  }

  return (
    <div className="animate-fade-in grid h-[calc(100vh-7rem)] gap-4 lg:grid-cols-[260px_1fr]">
      {/* Conversations */}
      <Card className="hidden overflow-hidden lg:flex lg:flex-col">
        <div className="border-b border-border/60 p-3">
          <Button
            variant="secondary"
            className="w-full"
            onClick={async () => {
              const created = await createThread.mutateAsync({});
              setThreadId(created.id);
              setPending([]);
            }}
            loading={createThread.isPending}
          >
            <Plus className="h-4 w-4" aria-hidden />
            New conversation
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {threads.isLoading ? (
            <Skeleton className="h-32" />
          ) : (threads.data ?? []).length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">No conversations yet.</p>
          ) : (
            <ul className="space-y-1">
              {(threads.data ?? []).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setThreadId(item.id);
                      setPending([]);
                    }}
                    className={cn(
                      'w-full rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                      item.id === threadId
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <span className="line-clamp-2">{item.title}</span>
                    <span className="tabular mt-0.5 block text-[11px] text-muted-foreground/70">
                      {relativeTime(item.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* Conversation */}
      <Card className="flex min-h-0 flex-col overflow-hidden">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
          {!threadId || (thread.data?.messages.length ?? 0) === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <MessageSquare className="h-10 w-10 text-muted-foreground" aria-hidden />
              <h2 className="mt-3 font-display text-lg font-semibold">Marketing copilot</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Ask about your own research, content, campaigns and performance. It answers from
                your data using authorised tools, not from memory.
              </p>
              <div className="mt-6 flex max-w-lg flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => void send(suggestion)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ul className="space-y-4">
              {(thread.data?.messages ?? []).map((message) => (
                <li
                  key={message.id}
                  className={cn('flex', message.role === 'USER' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      'max-w-[85%] rounded-xl px-4 py-2.5',
                      message.role === 'USER'
                        ? 'bg-primary text-primary-foreground'
                        : 'border border-border/60 bg-surface-raised/60',
                    )}
                  >
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>

                    {message.toolCalls.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1 border-t border-border/40 pt-2">
                        {message.toolCalls.map((call, index) => (
                          <Badge
                            key={index}
                            tone={call.status === 'OK' ? 'neutral' : 'warning'}
                          >
                            <Wrench className="h-3 w-3" aria-hidden />
                            {call.name}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}

              {sendMessage.isPending ? (
                <li className="flex justify-start">
                  <div className="rounded-xl border border-border/60 bg-surface-raised/60 px-4 py-3">
                    <div className="flex gap-1">
                      {[0, 1, 2].map((index) => (
                        <span
                          key={index}
                          className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground"
                          style={{ animationDelay: `${index * 150}ms` }}
                        />
                      ))}
                    </div>
                  </div>
                </li>
              ) : null}
            </ul>
          )}

          {/* Confirmation gate for side-effecting tools. */}
          {pending.length > 0 ? (
            <div className="mt-4 space-y-2">
              {pending.map((proposal) => (
                <Card key={proposal.actionId} className="border-warning/50 bg-warning/5">
                  <CardContent className="pt-4">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">This action needs your confirmation</p>
                        <p className="mt-1 text-sm text-muted-foreground">{proposal.summary}</p>
                        <div className="mt-3 flex gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() =>
                              void send('Yes, go ahead.', [proposal.actionId])
                            }
                            loading={sendMessage.isPending}
                          >
                            Confirm
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPending((current) => current.filter((item) => item.actionId !== proposal.actionId))}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : null}
        </div>

        {/* Composer */}
        <div className="border-t border-border/60 p-3">
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter is a newline.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
              placeholder="Ask about your research, content, campaigns or performance…"
              className="max-h-40 min-h-11 flex-1 resize-none py-2.5"
              rows={1}
            />
            <Button
              variant="primary"
              size="icon"
              onClick={() => void send(draft)}
              disabled={draft.trim().length === 0}
              loading={sendMessage.isPending}
              aria-label="Send message"
            >
              <ArrowUp className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Publishing, scheduling and deletion always require explicit confirmation.
          </p>
        </div>
      </Card>
    </div>
  );
}
