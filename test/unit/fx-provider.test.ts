import { afterEach, describe, expect, it, vi } from 'vitest';
import { toMoney } from '../../src/domain/money';
import { OpenErApiProvider } from '../../src/fx/fx-provider';
import { FxService, type RateSnapshot } from '../../src/fx/fx-service';

const liveBody = {
  result: 'success',
  base_code: 'USD',
  time_last_update_unix: 1794268951,
  rates: { USD: 1, NGN: 1349.070025, GHS: 11.706158, XAF: 585.411511, EUR: 0.892449, GBP: 0.76 },
};

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenErApiProvider', () => {
  const provider = new OpenErApiProvider('https://fx.test/latest/USD');

  it('maps fiat quotes onto stablecoins without float noise', async () => {
    mockFetch(liveBody);
    const quote = await provider.fetchUsdRates(new AbortController().signal);
    expect(quote.usdRates.cNGN.toFixed()).toBe('1349.070025');
    expect(quote.usdRates.EURx.toFixed()).toBe('0.892449');
    expect(quote.usdRates.USDx.toFixed()).toBe('1');
    expect(quote.providerUpdatedAt?.toISOString()).toBe('2026-11-10T00:02:31.000Z');
  });

  it('rejects HTTP errors, error payloads and missing currencies', async () => {
    const signal = new AbortController().signal;
    mockFetch({}, 500);
    await expect(provider.fetchUsdRates(signal)).rejects.toThrow('HTTP 500');

    mockFetch({ result: 'error', 'error-type': 'quota-reached' });
    await expect(provider.fetchUsdRates(signal)).rejects.toThrow();

    mockFetch({ ...liveBody, rates: { USD: 1, NGN: 1500 } });
    await expect(provider.fetchUsdRates(signal)).rejects.toThrow('did not quote GHS');

    mockFetch({ ...liveBody, rates: { ...liveBody.rates, XAF: -1 } });
    await expect(provider.fetchUsdRates(signal)).rejects.toThrow();
  });
});

describe('FxService.crossRate', () => {
  const snapshot: RateSnapshot = {
    usdRates: {
      USDx: toMoney('1'),
      cNGN: toMoney('1500'),
      cGHS: toMoney('15'),
      cXAF: toMoney('600'),
      EURx: toMoney('0.8'),
    },
    source: 'live',
    provider: 'test',
    refreshedAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('derives cross rates through USD', () => {
    expect(FxService.crossRate(snapshot, 'cNGN', 'cGHS').rate.toFixed()).toBe('0.01');
    expect(FxService.crossRate(snapshot, 'EURx', 'cXAF').rate.toFixed()).toBe('750');
  });

  it('returns an identity rate for the same currency', () => {
    expect(FxService.crossRate(snapshot, 'cXAF', 'cXAF')).toMatchObject({ source: 'identity' });
    expect(FxService.crossRate(snapshot, 'cXAF', 'cXAF').rate.toFixed()).toBe('1');
  });

  it('lists all 20 ordered pairs', () => {
    expect(FxService.allPairs(snapshot)).toHaveLength(20);
  });
});
