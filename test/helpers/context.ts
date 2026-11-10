import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../../src/app';
import { createDatabase, type Db } from '../../src/db/database';
import { FxService, type FxServiceOptions } from '../../src/fx/fx-service';
import { FakeFxProvider } from './fake-fx-provider';

export interface TestContext {
  app: Express;
  db: Db;
  fx: FxService;
  provider: FakeFxProvider;
  close: () => Promise<void>;
}

export function createTestContext(fxOverrides: Partial<FxServiceOptions> = {}): TestContext {
  const db = createDatabase({ connectionString: inject('databaseUrl'), poolMax: 20 });
  const logger = pino({ level: 'silent' });
  const provider = new FakeFxProvider();
  const fx = new FxService({
    db,
    logger,
    provider,
    cacheTtlMs: 60_000,
    retryAfterFailureMs: 1_000,
    providerTimeoutMs: 500,
    maxStalenessMs: 3_600_000,
    allowStaticFallback: true,
    ...fxOverrides,
  });
  return { app: createApp({ db, fx, logger }), db, fx, provider, close: () => db.destroy() };
}

export const uniqueEmail = () => `user-${randomUUID()}@example.com`;
export const newKey = () => randomUUID();

export async function createWallet(app: Express, body: object = { email: uniqueEmail() }) {
  const res = await request(app).post('/v1/wallets').send(body).expect(201);
  return res.body as { id: string; email: string | null; phone: string | null };
}

export async function deposit(app: Express, walletId: string, currency: string, amount: string) {
  return request(app)
    .post(`/v1/wallets/${walletId}/deposits`)
    .set('Idempotency-Key', newKey())
    .send({ currency, amount })
    .expect(201);
}

export async function balanceOf(app: Express, walletId: string, currency: string) {
  const res = await request(app).get(`/v1/wallets/${walletId}/balances`).expect(200);
  const balances = (res.body as { balances: { currency: string; amount: string }[] }).balances;
  return balances.find((b) => b.currency === currency)?.amount;
}
