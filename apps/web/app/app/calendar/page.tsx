'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useContentList, useOrganization } from '@/lib/queries';
import { formatContentType, formatInTimezone } from '@/lib/format';
import type { ContentItem } from '@/lib/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  cn,
  statusTone,
} from '@/components/ui';

type View = 'month' | 'week' | 'day';

/**
 * Content calendar.
 *
 * Timestamps are stored in UTC and rendered in the organization's timezone,
 * which is what makes "posted at 9am" mean the same thing to everyone on the
 * team regardless of where they are.
 */
export default function CalendarPage() {
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState(() => new Date());

  const organization = useOrganization();
  const timezone = organization.data?.timezone;

  const range = useMemo(() => rangeFor(view, anchor), [view, anchor]);

  const content = useContentList({
    scheduledFrom: range.start.toISOString(),
    scheduledTo: range.end.toISOString(),
    limit: 200,
  });

  const byDay = useMemo(() => {
    const map = new Map<string, ContentItem[]>();
    for (const item of content.data?.items ?? []) {
      if (!item.scheduledAt) continue;
      const key = dayKey(item.scheduledAt, timezone);
      const existing = map.get(key) ?? [];
      existing.push(item);
      map.set(key, existing);
    }
    return map;
  }, [content.data, timezone]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Calendar"
        description={`Scheduled and published content, shown in ${timezone ?? 'UTC'}.`}
        actions={
          <>
            <Select
              value={view}
              onChange={(event) => setView(event.target.value as View)}
              className="w-28"
              aria-label="Calendar view"
            >
              <option value="month">Month</option>
              <option value="week">Week</option>
              <option value="day">Day</option>
            </Select>
            <div className="flex items-center gap-1">
              <Button
                variant="secondary"
                size="icon"
                onClick={() => setAnchor(shift(anchor, view, -1))}
                aria-label="Previous"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setAnchor(new Date())}>
                Today
              </Button>
              <Button
                variant="secondary"
                size="icon"
                onClick={() => setAnchor(shift(anchor, view, 1))}
                aria-label="Next"
              >
                <ChevronRight className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </>
        }
      />

      <p className="mb-4 font-display text-lg font-semibold">{range.label}</p>

      {content.isLoading ? (
        <Skeleton className="h-96" />
      ) : content.error ? (
        <ErrorState error={content.error} onRetry={() => void content.refetch()} />
      ) : view === 'day' ? (
        <DayList items={byDay.get(dayKey(anchor.toISOString(), timezone)) ?? []} timezone={timezone} />
      ) : (
        <div
          className={cn(
            'grid gap-px overflow-hidden rounded-xl border border-border/60 bg-border/40',
            view === 'week' ? 'grid-cols-7' : 'grid-cols-7',
          )}
        >
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
            <div key={label} className="bg-surface px-2 py-1.5 text-center text-xs font-medium text-muted-foreground">
              {label}
            </div>
          ))}

          {range.days.map((day) => {
            const key = dayKey(day.toISOString(), timezone);
            const items = byDay.get(key) ?? [];
            const inRange = view === 'week' || day.getMonth() === anchor.getMonth();
            const isToday = key === dayKey(new Date().toISOString(), timezone);

            return (
              <div
                key={key}
                className={cn(
                  'min-h-28 bg-surface p-1.5',
                  !inRange && 'opacity-40',
                  isToday && 'ring-1 ring-inset ring-primary/50',
                )}
              >
                <p
                  className={cn(
                    'tabular mb-1 text-xs',
                    isToday ? 'font-semibold text-primary' : 'text-muted-foreground',
                  )}
                >
                  {day.getDate()}
                </p>
                <ul className="space-y-1">
                  {items.slice(0, view === 'week' ? 8 : 3).map((item) => (
                    <li key={item.id}>
                      <Link
                        href={`/app/content/${item.id}`}
                        className="block truncate rounded border-l-2 border-primary bg-primary/10 px-1.5 py-1 text-[11px] hover:bg-primary/20"
                        title={item.title ?? formatContentType(item.contentType)}
                      >
                        <span className="tabular text-muted-foreground">
                          {formatInTimezone(item.scheduledAt, timezone, {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>{' '}
                        {item.title ?? formatContentType(item.contentType)}
                      </Link>
                    </li>
                  ))}
                  {items.length > (view === 'week' ? 8 : 3) ? (
                    <li className="px-1.5 text-[11px] text-muted-foreground">
                      +{items.length - (view === 'week' ? 8 : 3)} more
                    </li>
                  ) : null}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DayList({ items, timezone }: { items: ContentItem[]; timezone: string | undefined }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Nothing scheduled for this day.
        </CardContent>
      </Card>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={`/app/content/${item.id}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-surface/40 p-4 transition-colors hover:border-border-strong"
          >
            <div className="min-w-0">
              <p className="tabular text-xs text-accent">
                {formatInTimezone(item.scheduledAt, timezone, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
              <p className="mt-0.5 text-sm font-medium">
                {item.title ?? formatContentType(item.contentType)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge>{formatContentType(item.contentType)}</Badge>
              <Badge tone={statusTone(item.status)}>{item.status.replace(/_/g, ' ')}</Badge>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Day key in the organization's timezone, so grouping matches what is displayed. */
function dayKey(iso: string, timezone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(0, 10);
  }
}

function rangeFor(view: View, anchor: Date): { start: Date; end: Date; days: Date[]; label: string } {
  if (view === 'day') {
    const start = new Date(anchor);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return {
      start,
      end,
      days: [start],
      label: anchor.toLocaleDateString(undefined, { dateStyle: 'full' }),
    };
  }

  if (view === 'week') {
    const start = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
    const end = new Date(addDays(start, 6));
    end.setHours(23, 59, 59, 999);
    return {
      start,
      end,
      days,
      label: `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    };
  }

  // Month view renders whole weeks, so it starts on the Monday before the first.
  const firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = startOfWeek(firstOfMonth);
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  const end = new Date(days[days.length - 1]!);
  end.setHours(23, 59, 59, 999);

  return {
    start: gridStart,
    end,
    days,
    label: anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  };
}

/** Weeks start on Monday, matching how the team plans. */
function startOfWeek(date: Date): Date {
  const result = new Date(date);
  const day = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - day);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function shift(date: Date, view: View, direction: number): Date {
  const result = new Date(date);
  if (view === 'month') result.setMonth(result.getMonth() + direction);
  else if (view === 'week') result.setDate(result.getDate() + 7 * direction);
  else result.setDate(result.getDate() + direction);
  return result;
}
