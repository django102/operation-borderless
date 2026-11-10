import type { Currency } from '../domain/currency';

/**
 * Hard-coded last-resort table: units per 1 USD, captured from open.er-api.com on the date
 * below. Only used when the live provider is down and no recent snapshot exists in the DB
 * (or when FX_PROVIDER=static).
 */
export const STATIC_RATES_AS_OF = new Date('2026-11-10T00:00:00Z');

export const STATIC_USD_RATES: Readonly<Record<Currency, string>> = {
  USDx: '1',
  cNGN: '1349.07',
  cGHS: '11.706158',
  cXAF: '585.411511',
  EURx: '0.892449',
};
