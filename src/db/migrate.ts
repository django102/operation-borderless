import { loadConfig } from '../config';
import { createDatabase } from './database';
import { migrateToLatest } from './migrator';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase({ connectionString: config.DATABASE_URL });
  try {
    const applied = await migrateToLatest(db);
    console.log(
      applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date.',
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
