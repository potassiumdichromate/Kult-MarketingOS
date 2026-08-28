import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="text-center">
        <p className="font-display text-5xl font-bold text-primary">404</p>
        <h1 className="mt-3 font-display text-xl font-semibold">Page not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          That route does not exist in Kult Marketing OS.
        </p>
        <Link
          href="/app/dashboard"
          className="mt-6 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
