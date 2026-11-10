import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { balanceOf, createTestContext, createWallet, deposit, newKey } from '../helpers/context';

const ctx = createTestContext();
afterAll(() => ctx.close());

const swap = (walletId: string, body: object, key = newKey()) =>
  request(ctx.app).post(`/v1/wallets/${walletId}/swaps`).set('Idempotency-Key', key).send(body);

describe('POST /v1/wallets/:id/swaps', () => {
  it('converts between stablecoins at the current rate', async () => {
    const wallet = await createWallet(ctx.app);
    await deposit(ctx.app, wallet.id, 'cNGN', '30000');

    // Test rates: 1 USD = 1500 NGN = 15 GHS, so 1 cNGN = 0.01 cGHS.
    const res = await swap(wallet.id, {
      fromCurrency: 'cNGN',
      toCurrency: 'cGHS',
      amount: '12345.67',
    }).expect(201);
    expect(res.body).toMatchObject({
      type: 'SWAP',
      walletId: wallet.id,
      source: { currency: 'cNGN', amount: '12345.670000' },
      destination: { currency: 'cGHS', amount: '123.456700' },
      fx: { rate: '0.01', source: 'live' },
    });
    expect(await balanceOf(ctx.app, wallet.id, 'cNGN')).toBe('17654.330000');
    expect(await balanceOf(ctx.app, wallet.id, 'cGHS')).toBe('123.456700');
  });

  it('rounds the credited amount down, never up', async () => {
    const wallet = await createWallet(ctx.app);
    await deposit(ctx.app, wallet.id, 'cNGN', '1');
    // 1 / 1500 = 0.000666666...
    const res = await swap(wallet.id, {
      fromCurrency: 'cNGN',
      toCurrency: 'USDx',
      amount: '1',
    }).expect(201);
    expect(res.body.destination.amount).toBe('0.000666');
    expect(res.body.fx.rate).toBe('0.000666666666666667');
  });

  it('rejects a swap whose proceeds round to zero', async () => {
    const wallet = await createWallet(ctx.app);
    await deposit(ctx.app, wallet.id, 'cNGN', '1');
    const res = await swap(wallet.id, {
      fromCurrency: 'cNGN',
      toCurrency: 'USDx',
      amount: '0.001',
    }).expect(422);
    expect(res.body.error.code).toBe('AMOUNT_TOO_SMALL');
    expect(await balanceOf(ctx.app, wallet.id, 'cNGN')).toBe('1.000000');
  });

  it('rejects a swap that would make the balance negative and changes nothing', async () => {
    const wallet = await createWallet(ctx.app);
    await deposit(ctx.app, wallet.id, 'USDx', '10');
    const res = await swap(wallet.id, {
      fromCurrency: 'USDx',
      toCurrency: 'EURx',
      amount: '10.000001',
    }).expect(422);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      details: { currency: 'USDx', available: '10.000000', required: '10.000001' },
    });
    expect(await balanceOf(ctx.app, wallet.id, 'USDx')).toBe('10.000000');
    expect(await balanceOf(ctx.app, wallet.id, 'EURx')).toBe('0.000000');

    // The failed attempt left no transaction behind.
    const history = await request(ctx.app).get(`/v1/wallets/${wallet.id}/transactions?type=SWAP`);
    expect(history.body.data).toHaveLength(0);
  });

  it('rejects swapping a currency for itself', async () => {
    const wallet = await createWallet(ctx.app);
    const res = await swap(wallet.id, {
      fromCurrency: 'USDx',
      toCurrency: 'USDx',
      amount: '1',
    }).expect(400);
    expect(res.body.error.code).toBe('SAME_CURRENCY_SWAP');
  });

  it('never processes the same request twice', async () => {
    const wallet = await createWallet(ctx.app);
    await deposit(ctx.app, wallet.id, 'USDx', '100');
    const key = newKey();
    const body = { fromCurrency: 'USDx', toCurrency: 'cXAF', amount: '40' };

    const results = await Promise.all(Array.from({ length: 5 }, () => swap(wallet.id, body, key)));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await balanceOf(ctx.app, wallet.id, 'USDx')).toBe('60.000000');
    expect(await balanceOf(ctx.app, wallet.id, 'cXAF')).toBe('24000.000000');

    // A replay is served from the record, even if rates have moved since.
    ctx.provider.rates = { ...ctx.provider.rates, cXAF: '700' };
    ctx.fx.invalidate();
    const replay = await swap(wallet.id, body, key).expect(201);
    expect(replay.body.destination.amount).toBe('24000.000000');
    ctx.provider.rates = { ...ctx.provider.rates, cXAF: '600' };
    ctx.fx.invalidate();
  });

  it('allows no overdraft under heavy concurrent spending', async () => {
    const wallet = await createWallet(ctx.app);
    await deposit(ctx.app, wallet.id, 'USDx', '100');

    // 25 distinct swaps of 10 USDx race for a 100 USDx balance: exactly 10 can succeed.
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        swap(wallet.id, { fromCurrency: 'USDx', toCurrency: 'cNGN', amount: '10' }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 422)).toHaveLength(15);
    expect(await balanceOf(ctx.app, wallet.id, 'USDx')).toBe('0.000000');
    expect(await balanceOf(ctx.app, wallet.id, 'cNGN')).toBe('150000.000000');
  });
});
