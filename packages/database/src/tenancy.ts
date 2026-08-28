import { NotFoundError } from '@kult/shared';

/**
 * Tenant isolation helpers.
 *
 * The rule this module enforces: no organization-owned row is ever read or
 * written without an explicit `organizationId` predicate. Rather than trusting
 * every call site to remember, repositories build their `where` clauses through
 * `scoped()`, and single-row reads go through `requireInOrg()` which treats a
 * cross-tenant id exactly like a missing one - a 404, never a 403, so the
 * existence of another tenant's records is not disclosed.
 */

export interface TenantScope {
  organizationId: string;
}

/**
 * Note on call sites: TypeScript widens a bare string literal to `string` when
 * inferring `T`, which Prisma's enum filters reject. Write enum values as
 * `status: 'ACTIVE' as const`. A `const` type parameter would fix that
 * automatically but would also make inline arrays readonly, which Prisma's
 * `in` filters reject - so the narrowing is done at the call site instead.
 */
export function scoped<T extends Record<string, unknown>>(
  scope: TenantScope,
  where: T = {} as T,
): T & { organizationId: string } {
  if (!scope.organizationId) {
    throw new Error('Tenant scope is missing organizationId. Refusing to query unscoped.');
  }
  return { ...where, organizationId: scope.organizationId };
}

/**
 * Asserts a fetched row belongs to the caller's organization.
 * Rows from another tenant are reported as not found.
 */
export function requireInOrg<T extends { organizationId: string } | null | undefined>(
  row: T,
  scope: TenantScope,
  resourceName: string,
): NonNullable<T> {
  if (!row || row.organizationId !== scope.organizationId) {
    throw new NotFoundError(resourceName);
  }
  return row as NonNullable<T>;
}

/** Same as requireInOrg for rows that reach the tenant through a parent relation. */
export function requireFound<T>(row: T | null | undefined, resourceName: string): T {
  if (row === null || row === undefined) throw new NotFoundError(resourceName);
  return row;
}
