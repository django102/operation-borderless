/**
 * Applies pending migrations. Used by the `migrate` compose service, `npm run migrate`
 * and the test suite's global setup.
 */
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type { Db } from './database';
import * as initialSchema from './migrations/0001_initial_schema';

/*
 * Migrations are registered explicitly rather than discovered on disk, so the same code
 * works under tsx, the compiled build and the test runner.
 */
const migrations: Record<string, Migration> = {
  '0001_initial_schema': initialSchema,
};

const provider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
};

export async function migrateToLatest(db: Db): Promise<string[]> {
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    throw error instanceof Error ? error : new Error('Migration failed', { cause: error });
  }
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
