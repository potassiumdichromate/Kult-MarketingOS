import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * In Prisma 7 the datasource block carries no `url`; the connection string for
 * migration and introspection commands comes from here instead. Runtime
 * connections are separate and come from the PrismaPg driver adapter, which is
 * constructed in packages/database/src/client.ts from validated configuration.
 *
 * DATABASE_URL is read directly rather than through Prisma's `env()` helper,
 * which throws when the variable is unset. Generation genuinely does not need a
 * database - `prisma generate` runs during the Docker build, long before any
 * connection string exists - and failing there would be wrong. The commands
 * that do need it fail on their own, and the migration entrypoint checks for it
 * explicitly before running anything.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL ?? '' },
  migrations: { path: 'prisma/migrations' },
});
