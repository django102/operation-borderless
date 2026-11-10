import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { balanceOf, createTestContext, createWallet, newKey } from '../helpers/context';

const ctx = createTestContext();
afterAll(() => ctx.close());

const depositReq = (walletId: string, key: string | null, body: object) => {
  const req = request(ctx.app).post(`/v1/wallets/${walletId}/deposits`);
  if (key !== null) req.set('Idempotency-Key', key);
  return req.send(body);
};

describe('POST /v1/wallets/:id/deposits', () => {
  it('credits the balance immediately and records a transaction', async () => {
    const wallet = await createWallet(ctx.app);
    const res = await depositReq(wallet.id, newKey(), {
      currency: 'cNGN',
      amount: '2500.75',
    }).expect(201);

    expect(res.headers['idempotent-replayed']).toBe('false');
    expect(res.headers.location).toBe(`/v1/transactions/${res.body.id}`);
    expect(res.body).toMatchObject({
      type: 'DEPOSIT',
      status: 'COMPLETED',
      walletId: wallet.id,
      source: { currency: 'cNGN', amount: '2500.750000' },
      destination: { currency: 'cNGN', amount: '2500.750000' },
      fx: { rate: '1', source: 'identity' },
    });
    expect(await balanceOf(ctx.app, wallet.id, 'cNGN')).toBe('2500.750000');

    const ledger = await ctx.db
      .selectFrom('ledger_entries')
      .selectAll()
      .where('transaction_id', '=', res.body.id)
      .execute();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: '2500.750000', balance_after: '2500.750000' });
  });

  it('keeps full precision across many small deposits (no float drift)', async () => {
    const wallet = await createWallet(ctx.app);
    for (let i = 0; i < 10; i++) {
      await depositReq(wallet.id, newKey(), { currency: 'USDx', amount: '0.1' }).expect(201);
    }
    expect(await balanceOf(ctx.app, wallet.id, 'USDx')).toBe('1.000000');
  });

  it('accepts a plain JSON number, held to the same rules as a string', async () => {
    const wallet = await createWallet(ctx.app);
    await depositReq(wallet.id, newKey(), { currency: 'USDx', amount: 12.5 }).expect(201);
    expect(await balanceOf(ctx.app, wallet.id, 'USDx')).toBe('12.500000');
  });

  it.each([
    ['0', 'zero'],
    ['-5', 'negative'],
    ['1.0000001', 'more than 6 decimals'],
    ['abc', 'not a number'],
    ['1e3', 'scientific notation'],
    ['01.5', 'a leading zero'],
    ['10000000000000000', 'above the per-operation limit'],
    [1e21, 'a huge JSON number'],
  ])('rejects amount %j (%s)', async (amount: string | number, _reason: string) => {
    const wallet = await createWallet(ctx.app);
    const res = await depositReq(wallet.id, newKey(), { currency: 'USDx', amount }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unsupported currencies', async () => {
    const wallet = await createWallet(ctx.app);
    const res = await depositReq(wallet.id, newKey(), { currency: 'BTC', amount: '1' }).expect(400);
    expect(res.body.error.details[0]).toMatchObject({ path: 'currency' });
  });

  it('requires an Idempotency-Key header', async () => {
    const wallet = await createWallet(ctx.app);
    const missing = await depositReq(wallet.id, null, { currency: 'USDx', amount: '1' }).expect(
      400,
    );
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    await depositReq(wallet.id, 'has spaces', { currency: 'USDx', amount: '1' }).expect(400);
  });

  it('returns 404 for an unknown wallet', async () => {
    const res = await depositReq(randomUUID(), newKey(), { currency: 'USDx', amount: '1' }).expect(
      404,
    );
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  describe('idempotency', () => {
    it('replays a retried request instead of crediting twice', async () => {
      const wallet = await createWallet(ctx.app);
      const key = newKey();
      const first = await depositReq(wallet.id, key, { currency: 'USDx', amount: '50' }).expect(
        201,
      );
      // "50.00" normalises to the same request as "50".
      const retry = await depositReq(wallet.id, key, { currency: 'USDx', amount: '50.00' }).expect(
        201,
      );

      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(await balanceOf(ctx.app, wallet.id, 'USDx')).toBe('50.000000');
    });

    it('rejects a reused key carrying a different request', async () => {
      const wallet = await createWallet(ctx.app);
      const key = newKey();
      await depositReq(wallet.id, key, { currency: 'USDx', amount: '50' }).expect(201);
      const res = await depositReq(wallet.id, key, { currency: 'USDx', amount: '51' }).expect(422);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balanceOf(ctx.app, wallet.id, 'USDx')).toBe('50.000000');
    });

    it('processes a burst of concurrent duplicates exactly once', async () => {
      const wallet = await createWallet(ctx.app);
      const key = newKey();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          depositReq(wallet.id, key, { currency: 'cGHS', amount: '10' }),
        ),
      );

      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(results.filter((r) => r.headers['idempotent-replayed'] === 'false')).toHaveLength(1);
      expect(await balanceOf(ctx.app, wallet.id, 'cGHS')).toBe('10.000000');
    });

    it('scopes keys to the wallet, so two wallets may use the same key', async () => {
      const [a, b] = [await createWallet(ctx.app), await createWallet(ctx.app)];
      const key = newKey();
      await depositReq(a.id, key, { currency: 'USDx', amount: '1' }).expect(201);
      const res = await depositReq(b.id, key, { currency: 'USDx', amount: '1' }).expect(201);
      expect(res.headers['idempotent-replayed']).toBe('false');
    });
  });
});
