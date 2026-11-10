/**
 * The mock stablecoins supported by the sandbox. Each one is pegged 1:1 to a fiat
 * currency, which is what we price it against on the FX market.
 */
export const CURRENCIES = ['cNGN', 'cGHS', 'cXAF', 'USDx', 'EURx'] as const;

export type Currency = (typeof CURRENCIES)[number];

export const FIAT_PEG: Readonly<Record<Currency, string>> = {
  cNGN: 'NGN',
  cGHS: 'GHS',
  cXAF: 'XAF',
  USDx: 'USD',
  EURx: 'EUR',
};

/** USDx is the reporting currency for "total value" figures. */
export const REPORTING_CURRENCY: Currency = 'USDx';

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}
