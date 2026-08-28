'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { clsx, type ClassValue } from 'clsx';
import { Loader2 } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { twMerge } from 'tailwind-merge';

/**
 * UI primitives.
 *
 * A deliberately small set. Everything here is used by more than one screen;
 * anything used once lives with the screen that uses it.
 */

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_hsl(278_88%_58%/0.25)] hover:shadow-[0_0_28px_hsl(278_88%_58%/0.4)]',
        secondary: 'bg-surface-raised text-foreground border border-border hover:border-border-strong hover:bg-muted',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        outline: 'border border-border text-foreground hover:border-primary hover:text-primary',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        accent: 'bg-accent text-accent-foreground hover:bg-accent/90',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
        lg: 'h-12 px-6 text-base',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('glass rounded-xl border border-border/60 shadow-lg shadow-black/20', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('font-display text-base font-semibold tracking-tight', className)} {...props} />
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted/60 text-muted-foreground',
        primary: 'border-primary/40 bg-primary/15 text-primary',
        accent: 'border-accent/40 bg-accent/15 text-accent',
        success: 'border-success/40 bg-success/15 text-success',
        warning: 'border-warning/40 bg-warning/15 text-warning',
        danger: 'border-destructive/40 bg-destructive/15 text-destructive',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/** Maps a domain status onto a badge tone, so colour is consistent everywhere. */
export function statusTone(status: string): BadgeProps['tone'] {
  switch (status) {
    case 'PUBLISHED':
    case 'SUCCEEDED':
    case 'ACTIVE':
    case 'APPROVED':
    case 'ACCEPTED':
    case 'INDEXED':
      return 'success';
    case 'FAILED':
    case 'REJECTED':
    case 'ERROR':
    case 'EXPIRED':
    case 'CRITICAL':
      return 'danger';
    case 'PENDING_APPROVAL':
    case 'PENDING':
    case 'RUNNING':
    case 'PUBLISHING':
    case 'PROCESSING':
    case 'HIGH':
    case 'PROPOSED':
      return 'warning';
    case 'SCHEDULED':
    case 'EMERGING':
    case 'SELECTED':
      return 'accent';
    case 'MEDIUM':
      return 'warning';
    default:
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const fieldClasses =
  'w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 transition-colors focus:border-primary focus:outline-none disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(fieldClasses, 'h-10', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldClasses, 'min-h-24 resize-y', className)} {...props} />
  ),
);
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select ref={ref} className={cn(fieldClasses, 'h-10 cursor-pointer', className)} {...props} />
  ),
);
Select.displayName = 'Select';

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </span>
      {children}
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-shimmer rounded-lg', className)} />;
}

/**
 * Empty state. `action` is optional because some empties are simply "nothing has
 * happened yet" rather than "you should do something".
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <h3 className="font-display text-base font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * Renders an API failure with its stable code and requestId.
 *
 * The requestId is shown deliberately: it is the thread that ties a user's
 * report to the API log, the agent execution, and the provider response.
 */
export function ErrorState({
  error,
  onRetry,
}: {
  error: { message: string; code?: string; requestId?: string; requirement?: string };
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-display text-sm font-semibold text-destructive">
            {error.code ?? 'Request failed'}
          </h3>
          <p className="mt-1 text-sm text-foreground">{error.message}</p>
          {error.requirement ? (
            <p className="mt-2 rounded-md bg-surface-sunken p-2 text-xs text-muted-foreground">
              {error.requirement}
            </p>
          ) : null}
          {error.requestId ? (
            <p className="tabular mt-2 text-xs text-muted-foreground">
              Request {error.requestId}
            </p>
          ) : null}
        </div>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-6 shadow-2xl">
          <DialogPrimitive.Title className="font-display text-lg font-semibold">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
              {description}
            </DialogPrimitive.Description>
          ) : null}
          <div className="mt-4">{children}</div>
          {footer ? <div className="mt-6 flex justify-end gap-2">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

/**
 * A single metric.
 *
 * `value` accepts null to mean "not measured", which renders as an em dash with
 * an explanation rather than zero. That distinction matters throughout this
 * product: several providers genuinely do not report some metrics.
 */
export function Stat({
  label,
  value,
  hint,
  unavailableReason,
}: {
  label: string;
  value: number | string | null;
  hint?: string;
  unavailableReason?: string;
}) {
  const unavailable = value === null || value === undefined;
  return (
    <div className="rounded-lg border border-border/60 bg-surface-raised/50 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          'tabular mt-1 text-2xl font-semibold',
          unavailable ? 'text-muted-foreground' : 'text-foreground',
        )}
        title={unavailable ? (unavailableReason ?? 'Not reported by the provider') : undefined}
      >
        {unavailable ? '—' : typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {unavailable && unavailableReason ? (
        <p className="mt-1 text-xs text-muted-foreground">{unavailableReason}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Horizontal score bar with the numeric value alongside. */
export function ScoreBar({
  label,
  value,
  max = 100,
  tone = 'primary',
}: {
  label: string;
  value: number;
  max?: number;
  tone?: 'primary' | 'accent' | 'success' | 'warning' | 'danger';
}) {
  const percentage = Math.max(0, Math.min(100, (value / max) * 100));
  const toneClass = {
    primary: 'bg-primary',
    accent: 'bg-accent',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-destructive',
  }[tone];

  return (
    <div className="flex items-center gap-3">
      <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-all', toneClass)} style={{ width: `${percentage}%` }} />
      </div>
      <span className="tabular w-10 shrink-0 text-right text-xs text-foreground">
        {Math.round(value)}
      </span>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
