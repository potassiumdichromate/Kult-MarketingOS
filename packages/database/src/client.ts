import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../generated/client/client.js';

export { Prisma };
export type { PrismaClient };

export interface DatabaseOptions {
  connectionString: string;
  /** Maximum pooled connections. Keep API and worker pools sized independently. */
  maxConnections?: number;
  /** Emit query-level logs. Never enable in production: values are included. */
  logQueries?: boolean;
}

/**
 * Builds a PrismaClient bound to a PostgreSQL driver adapter.
 *
 * Prisma 7 removed `url` from the datasource block: the runtime connection is
 * supplied here through PrismaPg, and the migration connection comes from
 * prisma.config.ts. There is intentionally no fallback to process.env inside
 * this function - callers pass a validated connection string from @kult/config.
 */
export function createPrismaClient(options: DatabaseOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
  });

  return new PrismaClient({
    adapter,
    log: options.logQueries
      ? [
          { emit: 'stdout', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
  });
}

/**
 * Liveness probe used by the readiness endpoint.
 * Returns false rather than throwing so the health handler can report per-dependency.
 */
export async function checkDatabase(client: PrismaClient): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
