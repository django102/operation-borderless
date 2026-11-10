import { describe, expect, it } from 'vitest';
import {
  convert,
  formatAmount,
  formatRate,
  parseAmount,
  toMoney,
  value,
} from '../../src/domain/money';

describe('parseAmount', () => {
  it.each(['1', '0.5', '100.123456', '1000000000000000', ' 42 '])('accepts %j', (raw) => {
    expect(parseAmount(raw).ok).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['0', 'zero'],
    ['0.000000', 'zero with decimals'],
    ['-1', 'negative'],
    ['+1', 'explicit sign'],
    ['1.', 'trailing dot'],
    ['.5', 'leading dot'],
    ['1.1234567', 'seven decimals'],
    ['1e5', 'exponent'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['1,000', 'thousands separator'],
    ['1000000000000000.000001', 'above the maximum'],
  ])('rejects %j (%s)', (raw) => {
    expect(parseAmount(raw).ok).toBe(false);
  });
});

describe('arithmetic', () => {
  it('is exact where floating point is not', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(formatAmount(toMoney('0.1').add('0.2'))).toBe('0.300000');
  });

  it('rounds conversions down so value is never created', () => {
    expect(formatAmount(convert(toMoney('1'), toMoney('0.6666666666')))).toBe('0.666666');
    expect(formatAmount(convert(toMoney('0.000001'), toMoney('0.5')))).toBe('0.000000');
  });

  it("rounds valuations with banker's rounding", () => {
    expect(formatAmount(value(toMoney('1'), toMoney('0.0000025')))).toBe('0.000002');
    expect(formatAmount(value(toMoney('1'), toMoney('0.0000035')))).toBe('0.000004');
  });

  it('handles values far beyond Number.MAX_SAFE_INTEGER', () => {
    const big = toMoney('999999999999999.999999');
    expect(formatAmount(big.add('0.000001'))).toBe('1000000000000000.000000');
  });

  it('formats rates without exponent notation or trailing zeros', () => {
    expect(formatRate(toMoney('1').div('1500'))).toBe('0.000666666666666667');
    expect(formatRate(toMoney('1500.000'))).toBe('1500');
  });
});
