/**
 * Composition root: the only place that turns configuration into concrete objects.
 */
import pino, { type Logger } from 'pino';
import type { AppConfig } from './config';
import { createDatabase, type Db } from './db/database';
import { OpenErApiProvider } from './fx/fx-provider';
import { FxService } from './fx/fx-service';

export interface Container {
  config: AppConfig;
  logger: Logger;
  db: Db;
  fx: FxService;
}

export function buildContainer(config: AppConfig): Container {
  const logger = pino({
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
  const db = createDatabase({
    connectionString: config.DATABASE_URL,
    poolMax: config.DATABASE_POOL_MAX,
  });
  const fx = new FxService({
    db,
    logger: logger.child({ module: 'fx' }),
    provider: config.FX_PROVIDER === 'live' ? new OpenErApiProvider(config.FX_API_URL) : null,
    cacheTtlMs: config.FX_CACHE_TTL_SECONDS * 1000,
    retryAfterFailureMs: config.FX_RETRY_AFTER_FAILURE_SECONDS * 1000,
    providerTimeoutMs: config.FX_PROVIDER_TIMEOUT_MS,
    maxStalenessMs: config.FX_MAX_STALENESS_SECONDS * 1000,
    allowStaticFallback: config.FX_STATIC_FALLBACK,
  });
  return { config, logger, db, fx };
}
