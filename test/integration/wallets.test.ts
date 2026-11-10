import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestContext, createWallet, deposit, uniqueEmail } from '../helpers/context';

const ctx = createTestContext();
afterAll(() => ctx.close());

/** A random, valid Nigerian mobile number in E.164. */
const uniquePhone = () => `+234803${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

describe('POST /v1/wallets', () => {
  it('creates a wallet by email with a zero balance in every supported stablecoin', async () => {
    const email = uniqueEmail();
    const res = await request(ctx.app).post('/v1/wallets').send({ email }).expect(201);

    expect(res.headers.location).toBe(`/v1/wallets/${res.body.id}`);
    expect(res.body).toMatchObject({ email, phone: null, totalUsd: '0.000000' });
    expect(res.body.balances).toEqual(
      ['cNGN', 'cGHS', 'cXAF', 'USDx', 'EURx'].map((currency) => ({
        currency,
        amount: '0.000000',
        usdValue: '0.000000',
      })),
    );
  });

  it('creates a wallet by phone and normalises it to E.164', async () => {
    const phone = uniquePhone();
    const spaced = `${phone.slice(0, 4)} ${phone.slice(4, 7)} ${phone.slice(7)}`;
    const res = await request(ctx.app).post('/v1/wallets').send({ phone: spaced }).expect(201);
    expect(res.body.phone).toBe(phone);
  });

  it('rejects a second wallet for the same email, case-insensitively', async () => {
    const email = uniqueEmail();
    await createWallet(ctx.app, { email });
    const res = await request(ctx.app)
      .post('/v1/wallets')
      .send({ email: `  ${email.toUpperCase()} ` })
      .expect(409);
    expect(res.body.error).toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
      details: { field: 'email' },
    });
  });

  it('rejects a second wallet for the same phone number written differently', async () => {
    const phone = uniquePhone();
    await createWallet(ctx.app, { phone });
    const res = await request(ctx.app)
      .post('/v1/wallets')
      .send({ phone: `${phone.slice(0, 4)}-${phone.slice(4)}` })
      .expect(409);
    expect(res.body.error).toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
      details: { field: 'phone' },
    });
  });

  it('lets exactly one of several concurrent sign-ups with the same email win', async () => {
    const email = uniqueEmail();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => request(ctx.app).post('/v1/wallets').send({ email })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
  });

  it.each([
    [{}, 'neither identifier'],
    [{ email: 'not-an-email' }, 'an invalid email'],
    [{ phone: '12345' }, 'an invalid phone'],
    [{ email: uniqueEmail(), nickname: 'x' }, 'unknown fields'],
  ])('returns 400 for %j (%s)', async (body: object, _reason: string) => {
    const res = await request(ctx.app).post('/v1/wallets').send(body).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(ctx.app)
      .post('/v1/wallets')
      .set('content-type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('GET /v1/wallets/:id and /balances', () => {
  it('returns balances and their total value in USD at current rates', async () => {
    const wallet = await createWallet(ctx.app);
    await deposit(ctx.app, wallet.id, 'USDx', '100');
    await deposit(ctx.app, wallet.id, 'cNGN', '1500'); // 1 USD
    await deposit(ctx.app, wallet.id, 'EURx', '8'); // 10 USD

    const res = await request(ctx.app).get(`/v1/wallets/${wallet.id}`).expect(200);
    expect(res.body.id).toBe(wallet.id);
    expect(res.body.totalUsd).toBe('111.000000');
    expect(res.body.valuation).toMatchObject({ rateSource: 'live' });
    expect(res.body.balances).toContainEqual({
      currency: 'EURx',
      amount: '8.000000',
      usdValue: '10.000000',
    });

    const balances = await request(ctx.app).get(`/v1/wallets/${wallet.id}/balances`).expect(200);
    expect(balances.body).toMatchObject({ walletId: wallet.id, totalUsd: '111.000000' });
  });

  it('returns 404 for an unknown wallet and 400 for a malformed id', async () => {
    const missing = await request(ctx.app).get(`/v1/wallets/${randomUUID()}`).expect(404);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');
    await request(ctx.app).get('/v1/wallets/not-a-uuid').expect(400);
  });
});

describe('infrastructure endpoints', () => {
  it('reports health, serves the OpenAPI document and 404s unknown routes', async () => {
    await request(ctx.app).get('/health').expect(200, { status: 'ok', database: 'up' });
    const spec = await request(ctx.app).get('/openapi.json').expect(200);
    expect(spec.body.openapi).toMatch(/^3\./);
    const res = await request(ctx.app).get('/v1/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('echoes or generates a request id', async () => {
    const res = await request(ctx.app).get('/health').set('x-request-id', 'trace-123');
    expect(res.headers['x-request-id']).toBe('trace-123');
  });
});
