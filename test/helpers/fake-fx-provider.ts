import { CURRENCIES, type Currency } from '../../src/domain/currency';
import { toMoney, type MoneyValue } from '../../src/domain/money';
import type { FxProvider, ProviderQuote } from '../../src/fx/fx-provider';

/** Round numbers so expected amounts are easy to verify by hand. Units per 1 USD. */
export const TEST_USD_RATES: Record<Currency, string> = {
  USDx: '1',
  cNGN: '1500',
  cGHS: '15',
  cXAF: '600',
  EURx: '0.8',
};

export class FakeFxProvider implements FxProvider {
  readonly name = 'fake-provider';
  calls = 0;
  failWith: Error | null = null;
  delayMs = 0;
  rates: Record<Currency, string> = { ...TEST_USD_RATES };

  async fetchUsdRates(signal: AbortSignal): Promise<ProviderQuote> {
    this.calls++;
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    }
    if (this.failWith) throw this.failWith;
    const usdRates = {} as Record<Currency, MoneyValue>;
    for (const currency of CURRENCIES) usdRates[currency] = toMoney(this.rates[currency]);
    return { provider: this.name, usdRates, providerUpdatedAt: null };
  }
}
