'use client';

import {
  Activity,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Calendar,
  Compass,
  FileText,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  Megaphone,
  MessageSquare,
  Plug,
  Settings,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useNotifications, useMarkNotificationsRead, useOrganization } from '@/lib/queries';
import { useSession } from '@/components/providers';
import { Badge, Button, cn } from '@/components/ui';

/**
 * Authenticated application shell.
 *
 * Navigation is grouped by the job being done rather than by data model, which
 * is how the team actually works: find something worth saying, make it, ship it,
 * then learn from it.
 */

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Overview',
    items: [
      { href: '/app/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/app/copilot', label: 'Copilot', icon: MessageSquare },
    ],
  },
  {
    label: 'Discover',
    items: [
      { href: '/app/research', label: 'Research', icon: Compass },
      { href: '/app/trends', label: 'Trends', icon: TrendingUp },
      { href: '/app/niches', label: 'Niches', icon: Layers },
      { href: '/app/opportunities', label: 'Opportunities', icon: Sparkles },
    ],
  },
  {
    label: 'Create',
    items: [
      { href: '/app/content', label: 'Content', icon: FileText },
      { href: '/app/campaigns', label: 'Campaigns', icon: Megaphone },
      { href: '/app/calendar', label: 'Calendar', icon: Calendar },
    ],
  },
  {
    label: 'Measure',
    items: [
      { href: '/app/analytics', label: 'Analytics', icon: BarChart3 },
      { href: '/app/agents', label: 'Agent activity', icon: Bot },
    ],
  },
  {
    label: 'Configure',
    items: [
      { href: '/app/knowledge', label: 'Brand knowledge', icon: BookOpen },
      { href: '/app/integrations', label: 'Integrations', icon: Plug },
      { href: '/app/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { me, organizationId, setOrganizationId, logout } = useSession();
  const organization = useOrganization();

  const activeOrg = me?.organizations.find((org) => org.id === organizationId);

  return (
    <div className="flex min-h-screen">
      {/* Mobile backdrop */}
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          'glass fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-border/60 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-5 py-5">
          <Link href="/app/dashboard" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary shadow-[0_0_16px_hsl(278_88%_58%/0.5)]">
              <Sparkles className="h-4 w-4 text-primary-foreground" aria-hidden />
            </div>
            <div className="leading-tight">
              <p className="font-display text-sm font-bold">Kult</p>
              <p className="text-[11px] text-muted-foreground">Marketing OS</p>
            </div>
          </Link>
          <button
            type="button"
            className="text-muted-foreground lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Organization switcher, shown only when there is a choice to make. */}
        {me && me.organizations.length > 1 ? (
          <div className="px-4 pb-3">
            <select
              value={organizationId ?? ''}
              onChange={(event) => setOrganizationId(event.target.value)}
              className="w-full rounded-lg border border-border bg-input px-2 py-1.5 text-xs"
              aria-label="Active organization"
            >
              {me.organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active =
                    pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setMobileOpen(false)}
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                          active
                            ? 'bg-primary/15 font-medium text-primary'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                        aria-current={active ? 'page' : undefined}
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-border/60 p-3">
          {organization.data ? (
            <div className="mb-2 px-2">
              <p className="truncate text-xs font-medium">{organization.data.name}</p>
              <div className="mt-1 flex items-center gap-1.5">
                <Badge tone={organization.data.automationMode === 'AUTOPILOT' ? 'warning' : 'neutral'}>
                  {organization.data.automationMode}
                </Badge>
                <Badge tone="neutral">{activeOrg?.role ?? organization.data.yourRole}</Badge>
              </div>
            </div>
          ) : null}
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenuClick={() => setMobileOpen(true)} />
        <main className="flex-1 px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notifications = useNotifications(false);
  const markRead = useMarkNotificationsRead();

  const unread = (notifications.data ?? []).filter((item) => !item.readAt);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border/60 bg-background/80 px-4 backdrop-blur lg:px-8">
      <button
        type="button"
        onClick={onMenuClick}
        className="text-muted-foreground lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      <div className="flex-1" />

      <div className="relative">
        <button
          type="button"
          onClick={() => setNotificationsOpen((open) => !open)}
          className="relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`Notifications${unread.length > 0 ? `, ${unread.length} unread` : ''}`}
        >
          <Bell className="h-4 w-4" />
          {unread.length > 0 ? (
            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" />
          ) : null}
        </button>

        {notificationsOpen ? (
          <div className="absolute right-0 top-11 z-30 w-80 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
              <p className="text-sm font-semibold">Notifications</p>
              {unread.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => markRead.mutate(unread.map((item) => item.id))}
                  loading={markRead.isPending}
                >
                  Mark all read
                </Button>
              ) : null}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {notifications.data && notifications.data.length > 0 ? (
                notifications.data.slice(0, 20).map((item) => (
                  <div
                    key={item.id}
                    className={cn(
                      'border-b border-border/40 px-4 py-3 last:border-0',
                      !item.readAt && 'bg-primary/5',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <Activity
                        className={cn(
                          'mt-0.5 h-3.5 w-3.5 shrink-0',
                          item.severity === 'ERROR'
                            ? 'text-destructive'
                            : item.severity === 'WARNING'
                              ? 'text-warning'
                              : 'text-accent',
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{item.title}</p>
                        {item.body ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">{item.body}</p>
                        ) : null}
                        <p className="tabular mt-1 text-[11px] text-muted-foreground/70">
                          {new Date(item.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  Nothing yet.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}
