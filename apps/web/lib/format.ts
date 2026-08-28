/** Presentation helpers shared across screens. */

/** X_THREAD -> "X thread". Enum values are never shown raw. */
export function formatContentType(type: string): string {
  return type
    .split('_')
    .map((part, index) =>
      index === 0 ? part.charAt(0) + part.slice(1).toLowerCase() : part.toLowerCase(),
    )
    .join(' ');
}

export function formatEnum(value: string): string {
  const lower = value.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const future = diff > 0;
  const minutes = Math.abs(Math.round(diff / 60_000));

  if (minutes < 1) return 'just now';
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return future ? `in ${hours}h` : `${hours}h ago`;

  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

/**
 * Formats a timestamp in the organization's timezone.
 * Times are stored in UTC and only ever converted for display.
 */
export function formatInTimezone(
  iso: string | null,
  timezone: string | undefined,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, { ...options, timeZone: timezone });
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** A metric that was never measured renders as an em dash, never as zero. */
export function formatMetric(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(digits)}%`;
}

export function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
