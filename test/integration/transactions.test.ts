import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createWallet, deposit, newKey } from '../helpers/context';

const ctx = createTestContext();
afterAll(() => ctx.close());

interface TxBody {
  id: string;
  type: string;
  direction?: string;
  source: { currency: string };
  destination: { currency: string };
  createdAt: string;
}

let alice: { id: string };
let bola: { id: string };
const created: string[] = []; // ids in creation order

beforeAll(async () => {
  alice = await createWallet(ctx.app);
  bola = await createWallet(ctx.app);

  const post = async (path: string, body: object, walletId = alice.id) => {
    const res = await request(ctx.app)
      .post(`/v1/wallets/${walletId}/${path}`)
      .set('Idempotency-Key', newKey())
      .send(body)
      .expect(201);
    created.push((res.body as TxBody).id);
  };

  await post('deposits', { currency: 'USDx', amount: '100' });
  await post('deposits', { currency: 'cNGN', amount: '3000' });
  await post('swaps', { fromCurrency: 'USDx', toCurrency: 'EURx', amount: '10' });
  await post('transfers', {
    toWalletId: bola.id,
    sourceCurrency: 'USDx',
    destinationCurrency: 'cGHS',
    amount: '20',
  });
  await deposit(ctx.app, bola.id, 'cXAF', '600');
  await post('transfers', { toWalletId: alice.id, sourceCurrency: 'cXAF', amount: '60' }, bola.id);
});

const history = (walletId: string, query = '') =>
  request(ctx.app).get(`/v1/wallets/${walletId}/transactions${query}`);

describe('GET /v1/wallets/:id/transactions', () => {
  it('lists deposits, swaps and transfers sent and received, newest first', async () => {
    const res = await history(alice.id).expect(200);
    const data = res.body.data as TxBody[];
    expect(data.map((t) => t.id)).toEqual([...created].reverse());
    expect(data.map((t) => [t.type, t.direction])).toEqual([
      ['TRANSFER', 'RECEIVED'],
      ['TRANSFER', 'SENT'],
      ['SWAP', undefined],
      ['DEPOSIT', undefined],
      ['DEPOSIT', undefined],
    ]);
    expect(res.body.pagination).toEqual({ limit: 20, hasMore: false, nextCursor: null });
  });

  it('paginates with an opaque cursor without gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await history(alice.id, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(
        200,
      );
      seen.push(...(res.body.data as TxBody[]).map((t) => t.id));
      cursor = res.body.pagination.nextCursor as string | null;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([...created].reverse());
  });

  it('filters by type (single or comma-separated)', async () => {
    const deposits = await history(alice.id, '?type=DEPOSIT').expect(200);
    expect((deposits.body.data as TxBody[]).every((t) => t.type === 'DEPOSIT')).toBe(true);
    expect(deposits.body.data).toHaveLength(2);

    const mixed = await history(alice.id, '?type=swap,transfer').expect(200);
    expect(mixed.body.data).toHaveLength(3);
  });

  it('filters by the currency that moved in this wallet', async () => {
    // Alice sent USDx and Bola received cGHS for the same transfer.
    const aliceUsd = await history(alice.id, '?currency=USDx').expect(200);
    expect((aliceUsd.body.data as TxBody[]).map((t) => t.type)).toEqual([
      'TRANSFER',
      'SWAP',
      'DEPOSIT',
    ]);

    const bolaGhs = await history(bola.id, '?currency=cGHS').expect(200);
    expect(bolaGhs.body.data).toHaveLength(1);
    const bolaUsd = await history(bola.id, '?currency=USDx').expect(200);
    expect(bolaUsd.body.data).toHaveLength(0);

    const combined = await history(alice.id, '?currency=cXAF&type=TRANSFER').expect(200);
    expect((combined.body.data as TxBody[])[0]?.direction).toBe('RECEIVED');
  });

  it('validates query parameters', async () => {
    await history(alice.id, '?type=REFUND').expect(400);
    await history(alice.id, '?currency=BTC').expect(400);
    await history(alice.id, '?limit=0').expect(400);
    await history(alice.id, '?limit=101').expect(400);
    await history(alice.id, '?cursor=garbage').expect(400);
    await history(randomUUID()).expect(404);
  });
});

describe('GET /v1/transactions/:id', () => {
  it('returns a single transaction', async () => {
    const id = created[3]!;
    const res = await request(ctx.app).get(`/v1/transactions/${id}`).expect(200);
    expect(res.body).toMatchObject({
      id,
      type: 'TRANSFER',
      senderWalletId: alice.id,
      receiverWalletId: bola.id,
      source: { currency: 'USDx', amount: '20.000000' },
      destination: { currency: 'cGHS', amount: '300.000000' },
      fx: { rate: '15', source: 'live' },
    });
    expect(res.body).not.toHaveProperty('direction');
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    const res = await request(ctx.app).get(`/v1/transactions/${randomUUID()}`).expect(404);
    expect(res.body.error.code).toBe('TRANSACTION_NOT_FOUND');
    await request(ctx.app).get('/v1/transactions/123').expect(400);
  });
});
