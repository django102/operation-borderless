import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { createDatabase } from '../../src/db/database';
import { migrateToLatest } from '../../src/db/migrator';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Starts a throwaway Postgres in Docker (Testcontainers) unless TEST_DATABASE_URL points at
 * an existing database, then runs the migrations once for the whole run.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    databaseUrl = container.getConnectionUri();
  }

  const db = createDatabase({ connectionString: databaseUrl });
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }

  project.provide('databaseUrl', databaseUrl);

  return async () => {
    await container?.stop();
  };
}
