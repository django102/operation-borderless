import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATIC_RATES_AS_OF } from '../../src/fx/static-rates';
import {
  createTestContext,
  createWallet,
  deposit,
  newKey,
  type TestContext,
} from '../helpers/context';

const contexts: TestContext[] = [];
function context(...args: Parameters<typeof createTestContext>): TestContext {
  const ctx = createTestContext(...args);
  contexts.push(ctx);
  return ctx;
}
afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
});

/** A clock the test can move forward. */
function clock(start = Date.now()) {
  let now = start;
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

describe('GET /v1/fx/rates', () => {
  it('returns every ordered pair with its rate, source and refresh time', async () => {
    const ctx = context();
    const res = await request(ctx.app).get('/v1/fx/rates').expect(200);

    expect(res.body).toMatchObject({ base: 'USDx', source: 'live', provider: 'fake-provider' });
    expect(res.body.rates).toHaveLength(20);
    expect(res.body.rates).toContainEqual({
      from: 'USDx',
      to: 'cNGN',
      rate: '1500',
      source: 'live',
      refreshedAt: res.body.refreshedAt,
    });
    expect(res.body.rates).toContainEqual(
      expect.objectContaining({ from: 'cXAF', to: 'cGHS', rate: '0.025' }),
    );
  });

  it('caches the snapshot and shares one upstream call across concurrent requests', async () => {
    const ctx = context();
    ctx.provider.delayMs = 50;
    await Promise.all(
      Array.from({ length: 10 }, () => request(ctx.app).get('/v1/fx/rates').expect(200)),
    );
    await request(ctx.app).get('/v1/fx/rates').expect(200);
    expect(ctx.provider.calls).toBe(1);
  });

  it('refetches once the cache TTL has expired', async () => {
    const time = clock();
    const ctx = context({ now: time.now, cacheTtlMs: 1_000 });
    await request(ctx.app).get('/v1/fx/rates').expect(200);
    time.advance(1_001);
    await request(ctx.app).get('/v1/fx/rates').expect(200);
    expect(ctx.provider.calls).toBe(2);
  });
});

describe('GET /v1/fx/quote', () => {
  it('prices a conversion without moving money', async () => {
    const ctx = context();
    const res = await request(ctx.app)
      .get('/v1/fx/quote?from=cNGN&to=EURx&amount=3000')
      .expect(200);
    expect(res.body).toMatchObject({
      from: 'cNGN',
      to: 'EURx',
      rate: '0.000533333333333333',
      sourceAmount: '3000.000000',
      destinationAmount: '1.599999',
    });
    await request(ctx.app).get('/v1/fx/quote?from=cNGN&to=EURx').expect(400);
  });
});

describe('FX provider failure handling', () => {
  // Every test starts from a known last-known-good snapshot written by a healthy fetch.
  let seeded: TestContext;
  beforeEach(async () => {
    seeded = context();
    await seeded.fx.getSnapshot();
  });
  afterEach(() => {
    seeded.provider.failWith = null;
  });

  it('falls back to the last-known-good rates stored in Postgres', async () => {
    const ctx = context();
    ctx.provider.failWith = new Error('provider down');
    ctx.provider.rates = { ...ctx.provider.rates, cNGN: '9999' }; // must not be used

    const res = await request(ctx.app).get('/v1/fx/rates').expect(200);
    expect(res.body.source).toBe('cached');
    expect(res.body.rates).toContainEqual(
      expect.objectContaining({ from: 'USDx', to: 'cNGN', rate: '1500' }),
    );
  });

  it('records the fallback source on transactions priced while degraded', async () => {
    const ctx = context();
    ctx.provider.failWith = new Error('provider down');
    const wallet = await createWallet(ctx.app);
    await deposit(ctx.app, wallet.id, 'USDx', '10');
    const res = await request(ctx.app)
      .post(`/v1/wallets/${wallet.id}/swaps`)
      .set('Idempotency-Key', newKey())
      .send({ fromCurrency: 'USDx', toCurrency: 'cNGN', amount: '1' })
      .expect(201);
    expect(res.body.fx).toMatchObject({ rate: '1500', source: 'cached' });
  });

  it('treats a slow provider as failed once the timeout passes', async () => {
    const ctx = context({ providerTimeoutMs: 100 });
    ctx.provider.delayMs = 5_000;
    const started = Date.now();
    const res = await request(ctx.app).get('/v1/fx/rates').expect(200);
    expect(res.body.source).toBe('cached');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('uses the static table when the stored snapshot is too old', async () => {
    const time = clock(Date.now() + 2 * 3_600_000); // two hours ahead, max staleness is one
    const ctx = context({ now: time.now });
    ctx.provider.failWith = new Error('provider down');
    const res = await request(ctx.app).get('/v1/fx/rates').expect(200);
    expect(res.body).toMatchObject({
      source: 'static',
      provider: 'static-table',
      refreshedAt: STATIC_RATES_AS_OF.toISOString(),
    });
  });

  it('goes back to the provider after the retry window and recovers', async () => {
    const time = clock();
    const ctx = context({ now: time.now, retryAfterFailureMs: 1_000 });
    ctx.provider.failWith = new Error('provider down');
    expect((await request(ctx.app).get('/v1/fx/rates')).body.source).toBe('cached');

    ctx.provider.failWith = null;
    expect((await request(ctx.app).get('/v1/fx/rates')).body.source).toBe('cached'); // still in window
    time.advance(1_001);
    expect((await request(ctx.app).get('/v1/fx/rates')).body.source).toBe('live');
    expect(ctx.provider.calls).toBe(2);
  });

  it('refuses to price when no trustworthy rate exists and static fallback is disabled', async () => {
    const time = clock(Date.now() + 2 * 3_600_000);
    const ctx = context({ now: time.now, allowStaticFallback: false });
    ctx.provider.failWith = new Error('provider down');

    const rates = await request(ctx.app).get('/v1/fx/rates').expect(503);
    expect(rates.body.error.code).toBe('FX_UNAVAILABLE');

    const wallet = await createWallet(ctx.app);
    await deposit(ctx.app, wallet.id, 'USDx', '10'); // deposits need no FX
    await request(ctx.app)
      .post(`/v1/wallets/${wallet.id}/swaps`)
      .set('Idempotency-Key', newKey())
      .send({ fromCurrency: 'USDx', toCurrency: 'cNGN', amount: '1' })
      .expect(503);

    // Balances are still served; only the USD valuation is withheld.
    const balances = await request(ctx.app).get(`/v1/wallets/${wallet.id}/balances`).expect(200);
    expect(balances.body).toMatchObject({ totalUsd: null, valuation: null });
    expect(balances.body.balances).toContainEqual({
      currency: 'USDx',
      amount: '10.000000',
      usdValue: null,
    });
  });

  it('serves the static table without calling out in static mode', async () => {
    const ctx = context({ provider: null });
    const res = await request(ctx.app).get('/v1/fx/rates').expect(200);
    expect(res.body.source).toBe('static');
  });
});
