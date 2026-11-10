import Decimal from 'decimal.js';

/**
 * All money maths goes through this Decimal constructor. JavaScript numbers are never
 * used for amounts: they are parsed from strings, computed with arbitrary precision
 * and serialised back to strings.
 */
export const Money = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_DOWN });
export type MoneyValue = InstanceType<typeof Money>;

/** Every stablecoin in the sandbox has 6 decimal places (like USDC). Matches NUMERIC(38, 6). */
export const AMOUNT_DECIMALS = 6;
/** FX rates are stored with 18 decimal places. Matches NUMERIC(38, 18). */
export const RATE_DECIMALS = 18;

/** Upper bound for a single operation, well inside NUMERIC(38, 6). */
export const MAX_AMOUNT = new Money('1000000000000000'); // 1e15

const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

export type AmountParseResult = { ok: true; value: MoneyValue } | { ok: false; reason: string };

/** Parses a client-supplied amount. Rejects anything that is not a plain positive decimal. */
export function parseAmount(raw: string): AmountParseResult {
  const text = raw.trim();
  if (!AMOUNT_PATTERN.test(text)) {
    return { ok: false, reason: 'must be a positive decimal string such as "100.50"' };
  }
  const value = new Money(text);
  if (value.decimalPlaces() > AMOUNT_DECIMALS) {
    return { ok: false, reason: `must have at most ${AMOUNT_DECIMALS} decimal places` };
  }
  if (value.lte(0)) {
    return { ok: false, reason: 'must be greater than zero' };
  }
  if (value.gt(MAX_AMOUNT)) {
    return { ok: false, reason: `must not exceed ${MAX_AMOUNT.toFixed(0)}` };
  }
  return { ok: true, value };
}

export function toMoney(value: string | number | MoneyValue): MoneyValue {
  return new Money(value);
}

/** Fixed-scale string representation used everywhere in the API. */
export function formatAmount(value: MoneyValue): string {
  return value.toFixed(AMOUNT_DECIMALS, Money.ROUND_DOWN);
}

export function formatRate(value: MoneyValue): string {
  return value.toDecimalPlaces(RATE_DECIMALS, Money.ROUND_HALF_EVEN).toFixed();
}

/**
 * Converts an amount at a given rate. Always rounds DOWN to the currency's precision so the
 * platform never credits value that was not debited (the sub-unit dust stays with the house).
 */
export function convert(amount: MoneyValue, rate: MoneyValue): MoneyValue {
  return amount.mul(rate).toDecimalPlaces(AMOUNT_DECIMALS, Money.ROUND_DOWN);
}

/** Valuation (not a movement of funds), so banker's rounding is appropriate. */
export function value(amount: MoneyValue, rate: MoneyValue): MoneyValue {
  return amount.mul(rate).toDecimalPlaces(AMOUNT_DECIMALS, Money.ROUND_HALF_EVEN);
}
