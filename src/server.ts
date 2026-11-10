/**
 * Process entrypoint: wires the container, starts HTTP, and shuts down gracefully on
 * SIGTERM/SIGINT (stop accepting connections, drain in-flight requests, close the pool).
 */
import { createApp } from './app';
import { loadConfig } from './config';
import { buildContainer } from './container';

function main(): void {
  const container = buildContainer(loadConfig());
  const { config, logger, db, fx } = container;

  const server = createApp({ db, fx, logger }).listen(config.PORT, () => {
    logger.info({ port: config.PORT, fxProvider: config.FX_PROVIDER }, 'Harmattan API listening');
  });

  // Warm the FX cache so the first request does not pay for the provider round-trip.
  fx.getSnapshot().catch((error: unknown) => logger.warn({ err: error }, 'FX warm-up failed'));

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => {
      db.destroy()
        .catch((error: unknown) => logger.error({ err: error }, 'Error closing the database pool'))
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (error) {
  console.error('Failed to start:', error);
  process.exit(1);
}
