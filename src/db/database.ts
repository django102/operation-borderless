/**
 * Kysely instance backed by a `pg` connection pool, plus helpers for recognising Postgres
 * errors. Constraint violations are part of normal control flow here: uniqueness and
 * idempotency are enforced by the database, and the services translate the errors.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema';

export type Db = Kysely<Database>;

export interface DatabaseOptions {
  connectionString: string;
  poolMax?: number;
}

export function createDatabase({ connectionString, poolMax = 10 }: DatabaseOptions): Db {
  const pool = new pg.Pool({ connectionString, max: poolMax });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Postgres SQLSTATE codes we react to. */
export const PgError = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NUMERIC_OUT_OF_RANGE: '22003',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

export interface PgErrorLike {
  code: string;
  constraint?: string;
}

export function isPgError(error: unknown, code?: string): error is PgErrorLike {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const actual = error.code;
  return typeof actual === 'string' && (code === undefined || actual === code);
}
