/**
 * Express application factory.
 *
 * Takes its collaborators (database, FX service, logger) as arguments instead of importing
 * singletons, so tests can build an app against a throwaway database and a fake FX provider.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import type { Db } from './db/database';
import type { FxService } from './fx/fx-service';
import { fxRouter } from './fx/fx.routes';
import { errorHandler, notFoundHandler } from './http/error-handler';
import { TransactionService } from './transactions/transaction.service';
import { transactionRouter } from './transactions/transaction.routes';
import { WalletService } from './wallets/wallet.service';
import { walletRouter } from './wallets/wallet.routes';

export interface AppDependencies {
  db: Db;
  fx: FxService;
  logger: Logger;
}

const OPENAPI_PATH = path.resolve(__dirname, '..', 'docs', 'openapi.yaml');

export function createApp({ db, fx, logger }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind a load balancer, use X-Forwarded-* for client IPs in logs.
  app.set('trust proxy', true);

  app.use(
    pinoHttp({
      logger,
      // Propagate a caller's X-Request-Id (or mint one) so logs can be correlated across services.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );
  // Requests are tiny; a small limit cheaply blunts oversized-payload abuse.
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', async (_req, res) => {
    try {
      await sql`select 1`.execute(db);
      res.json({ status: 'ok', database: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  const openapi = YAML.parse(readFileSync(OPENAPI_PATH, 'utf8')) as Record<string, unknown>;
  app.get('/openapi.json', (_req, res) => {
    res.json(openapi);
  });
  // Swagger UI ships inline scripts, so it gets its own relaxed CSP; the API keeps helmet's.
  app.use(
    '/docs',
    helmet({ contentSecurityPolicy: false }),
    swaggerUi.serve,
    swaggerUi.setup(openapi),
  );

  app.use(helmet());

  const wallets = new WalletService(db, fx);
  const transactions = new TransactionService(db, fx);

  app.use('/v1/wallets', walletRouter(wallets, transactions));
  app.use('/v1/transactions', transactionRouter(transactions));
  app.use('/v1/fx', fxRouter(fx));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
