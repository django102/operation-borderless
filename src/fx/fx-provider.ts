import { z } from 'zod';
import { CURRENCIES, FIAT_PEG, type Currency } from '../domain/currency';
import { toMoney, type MoneyValue } from '../domain/money';

/** Units of each stablecoin per 1 USD, as reported by an upstream provider. */
export interface ProviderQuote {
  provider: string;
  usdRates: Record<Currency, MoneyValue>;
  /** When the provider says it last updated its data, if it tells us. */
  providerUpdatedAt: Date | null;
}

export interface FxProvider {
  readonly name: string;
  fetchUsdRates(signal: AbortSignal): Promise<ProviderQuote>;
}

const openErApiResponse = z.object({
  result: z.literal('success'),
  base_code: z.literal('USD'),
  time_last_update_unix: z.number().int().positive().optional(),
  rates: z.record(z.string(), z.number().positive()),
});

/**
 * https://open.er-api.com: free, keyless, and quotes NGN, GHS and XAF, which most free
 * ECB-based feeds do not.
 */
export class OpenErApiProvider implements FxProvider {
  readonly name = 'open.er-api.com';

  constructor(private readonly url: string) {}

  async fetchUsdRates(signal: AbortSignal): Promise<ProviderQuote> {
    const response = await fetch(this.url, { signal, headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`FX provider responded with HTTP ${response.status}`);
    }
    const body = openErApiResponse.parse(await response.json());
    return {
      provider: this.name,
      usdRates: extractPegRates((fiat) => body.rates[fiat]),
      providerUpdatedAt: body.time_last_update_unix
        ? new Date(body.time_last_update_unix * 1000)
        : null,
    };
  }
}

/** Maps fiat quotes onto our stablecoins, refusing partial data. */
export function extractPegRates(
  lookup: (fiat: string) => number | string | undefined,
): Record<Currency, MoneyValue> {
  const rates = {} as Record<Currency, MoneyValue>;
  for (const currency of CURRENCIES) {
    const fiat = FIAT_PEG[currency];
    const raw = fiat === 'USD' ? 1 : lookup(fiat);
    if (raw === undefined) {
      throw new Error(`FX provider did not quote ${fiat}`);
    }
    // String() of a JSON number is its shortest round-trip form, so no float noise leaks in.
    const rate = toMoney(String(raw));
    if (!rate.isFinite() || rate.lte(0)) {
      throw new Error(`FX provider returned an invalid rate for ${fiat}`);
    }
    rates[currency] = rate;
  }
  return rates;
}
