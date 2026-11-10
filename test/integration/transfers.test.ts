import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { balanceOf, createTestContext, createWallet, deposit, newKey } from '../helpers/context';

const ctx = createTestContext();
afterAll(() => ctx.close());

const transfer = (fromWalletId: string, body: object, key = newKey()) =>
  request(ctx.app)
    .post(`/v1/wallets/${fromWalletId}/transfers`)
    .set('Idempotency-Key', key)
    .send(body);

describe('POST /v1/wallets/:id/transfers', () => {
  it('moves funds between wallets in the same currency', async () => {
    const [alice, bola] = [await createWallet(ctx.app), await createWallet(ctx.app)];
    await deposit(ctx.app, alice.id, 'cGHS', '500');

    const res = await transfer(alice.id, {
      toWalletId: bola.id,
      sourceCurrency: 'cGHS',
      amount: '120.5',
    }).expect(201);
    expect(res.body).toMatchObject({
      type: 'TRANSFER',
      senderWalletId: alice.id,
      receiverWalletId: bola.id,
      source: { currency: 'cGHS', amount: '120.500000' },
      destination: { currency: 'cGHS', amount: '120.500000' },
      fx: { rate: '1', source: 'identity' },
    });
    expect(await balanceOf(ctx.app, alice.id, 'cGHS')).toBe('379.500000');
    expect(await balanceOf(ctx.app, bola.id, 'cGHS')).toBe('120.500000');
  });

  it('converts automatically when the currencies differ and records the rate', async () => {
    const [sender, receiver] = [await createWallet(ctx.app), await createWallet(ctx.app)];
    await deposit(ctx.app, sender.id, 'EURx', '80');

    // 1 EURx = 1500 / 0.8 = 1875 cNGN.
    const res = await transfer(sender.id, {
      toWalletId: receiver.id,
      sourceCurrency: 'EURx',
      destinationCurrency: 'cNGN',
      amount: '80',
    }).expect(201);
    expect(res.body).toMatchObject({
      senderWalletId: sender.id,
      receiverWalletId: receiver.id,
      source: { currency: 'EURx', amount: '80.000000' },
      destination: { currency: 'cNGN', amount: '150000.000000' },
      fx: { rate: '1875', source: 'live' },
    });
    expect(Date.parse(res.body.createdAt)).not.toBeNaN();
    expect(await balanceOf(ctx.app, sender.id, 'EURx')).toBe('0.000000');
    expect(await balanceOf(ctx.app, receiver.id, 'cNGN')).toBe('150000.000000');
  });

  it('rejects an overdraft and leaves both wallets untouched', async () => {
    const [sender, receiver] = [await createWallet(ctx.app), await createWallet(ctx.app)];
    await deposit(ctx.app, sender.id, 'USDx', '5');
    const res = await transfer(sender.id, {
      toWalletId: receiver.id,
      sourceCurrency: 'USDx',
      amount: '6',
    }).expect(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(ctx.app, sender.id, 'USDx')).toBe('5.000000');
    expect(await balanceOf(ctx.app, receiver.id, 'USDx')).toBe('0.000000');
  });

  it('rejects transfers to self and to unknown wallets', async () => {
    const wallet = await createWallet(ctx.app);
    await deposit(ctx.app, wallet.id, 'USDx', '5');
    const self = await transfer(wallet.id, {
      toWalletId: wallet.id,
      sourceCurrency: 'USDx',
      amount: '1',
    }).expect(400);
    expect(self.body.error.code).toBe('SELF_TRANSFER');
    const unknown = await transfer(wallet.id, {
      toWalletId: randomUUID(),
      sourceCurrency: 'USDx',
      amount: '1',
    }).expect(404);
    expect(unknown.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('is idempotent per sender', async () => {
    const [sender, receiver] = [await createWallet(ctx.app), await createWallet(ctx.app)];
    await deposit(ctx.app, sender.id, 'USDx', '100');
    const key = newKey();
    const body = { toWalletId: receiver.id, sourceCurrency: 'USDx', amount: '30' };
    const first = await transfer(sender.id, body, key).expect(201);
    const retry = await transfer(sender.id, body, key).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(await balanceOf(ctx.app, receiver.id, 'USDx')).toBe('30.000000');

    const changed = await transfer(
      sender.id,
      { ...body, toWalletId: (await createWallet(ctx.app)).id },
      key,
    );
    expect(changed.status).toBe(422);
  });

  it('handles opposite transfers between two wallets concurrently without deadlock or loss', async () => {
    const [a, b] = [await createWallet(ctx.app), await createWallet(ctx.app)];
    await deposit(ctx.app, a.id, 'USDx', '1000');
    await deposit(ctx.app, b.id, 'USDx', '1000');

    const requests = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0
        ? transfer(a.id, { toWalletId: b.id, sourceCurrency: 'USDx', amount: '7' })
        : transfer(b.id, { toWalletId: a.id, sourceCurrency: 'USDx', amount: '3' }),
    );
    const results = await Promise.all(requests);
    expect(results.every((r) => r.status === 201)).toBe(true);

    // 15 x 7 from a to b, 15 x 3 from b to a: net 60 moves to b, nothing is created or lost.
    expect(await balanceOf(ctx.app, a.id, 'USDx')).toBe('940.000000');
    expect(await balanceOf(ctx.app, b.id, 'USDx')).toBe('1060.000000');
  });
});
