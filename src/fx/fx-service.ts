import type { Logger } from 'pino';
import { CURRENCIES, REPORTING_CURRENCY, type Currency } from '../domain/currency';
import { Errors } from '../domain/errors';
import { Money, RATE_DECIMALS, formatRate, toMoney, type MoneyValue } from '../domain/money';
import type { Db } from '../db/database';
import type { RateSource } from '../db/schema';
import type { FxProvider, ProviderQuote } from './fx-provider';
import { STATIC_RATES_AS_OF, STATIC_USD_RATES } from './static-rates';

export type SnapshotSource = Exclude<RateSource, 'identity'>;

export interface RateSnapshot {
  /** Units of each stablecoin per 1 USD. */
  usdRates: Record<Currency, MoneyValue>;
  source: SnapshotSource;
  provider: string;
  /** When these rates were last refreshed from their provider. */
  refreshedAt: Date;
}

export interface AppliedRate {
  from: Currency;
  to: Currency;
  rate: MoneyValue;
  source: RateSource;
  asOf: Date;
}

export interface FxServiceOptions {
  db: Db;
  /** `null` means static mode: never call out. */
  provider: FxProvider | null;
  logger: Logger;
  cacheTtlMs: number;
  retryAfterFailureMs: number;
  providerTimeoutMs: number;
  maxStalenessMs: number;
  allowStaticFallback: boolean;
  now?: () => Date;
}

/**
 * Serves FX rates with a three-level fallback:
 *
 *   1. live      - fetched from the provider, cached in memory for `cacheTtlMs`
 *   2. cached    - the last-known-good snapshot persisted in Postgres, if younger than
 *                  `maxStalenessMs`
 *   3. static    - the hard-coded table (can be disabled with FX_STATIC_FALLBACK=false)
 *
 * After a provider failure, the fallback is cached only for `retryAfterFailureMs` so we go
 * back to the provider soon without hammering it. Concurrent callers share one in-flight
 * refresh (single-flight), so a burst of requests produces one upstream call.
 */
export class FxService {
  private cached: { snapshot: RateSnapshot; expiresAt: number } | null = null;
  private inflight: Promise<RateSnapshot> | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: FxServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async getSnapshot(): Promise<RateSnapshot> {
    if (this.cached && this.cached.expiresAt > this.now().getTime()) {
      return this.cached.snapshot;
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async getRate(from: Currency, to: Currency): Promise<AppliedRate> {
    if (from === to) {
      return { from, to, rate: new Money(1), source: 'identity', asOf: this.now() };
    }
    return FxService.crossRate(await this.getSnapshot(), from, to);
  }

  /** Clears the in-memory cache (used by tests and when rates must be re-read). */
  invalidate(): void {
    this.cached = null;
  }

  static crossRate(snapshot: RateSnapshot, from: Currency, to: Currency): AppliedRate {
    if (from === to) {
      return { from, to, rate: new Money(1), source: 'identity', asOf: snapshot.refreshedAt };
    }
    const rate = snapshot.usdRates[to]
      .div(snapshot.usdRates[from])
      .toDecimalPlaces(RATE_DECIMALS, Money.ROUND_HALF_EVEN);
    return { from, to, rate, source: snapshot.source, asOf: snapshot.refreshedAt };
  }

  /** Every ordered pair of distinct supported currencies. */
  static allPairs(snapshot: RateSnapshot): AppliedRate[] {
    return CURRENCIES.flatMap((from) =>
      CURRENCIES.filter((to) => to !== from).map((to) => FxService.crossRate(snapshot, from, to)),
    );
  }

  static toReporting(snapshot: RateSnapshot, from: Currency): AppliedRate {
    return FxService.crossRate(snapshot, from, REPORTING_CURRENCY);
  }

  private async refresh(): Promise<RateSnapshot> {
    const { provider, logger } = this.options;

    if (provider) {
      try {
        const quote = await this.fetchWithTimeout(provider);
        const refreshedAt = this.now();
        await this.persist(quote, refreshedAt);
        return this.remember(
          { usdRates: quote.usdRates, source: 'live', provider: quote.provider, refreshedAt },
          this.options.cacheTtlMs,
        );
      } catch (error) {
        logger.warn({ err: error, provider: provider.name }, 'FX provider failed; falling back');
      }

      const lastKnownGood = await this.loadLastKnownGood();
      if (lastKnownGood) {
        logger.warn(
          { refreshedAt: lastKnownGood.refreshedAt },
          'Serving last-known-good FX rates from the database',
        );
        return this.remember(lastKnownGood, this.options.retryAfterFailureMs);
      }
    }

    if (!this.options.allowStaticFallback) {
      throw Errors.fxUnavailable();
    }
    if (provider) {
      logger.error('No usable FX snapshot; serving the static rate table');
    }
    return this.remember(
      staticSnapshot(),
      provider ? this.options.retryAfterFailureMs : this.options.cacheTtlMs,
    );
  }

  private async fetchWithTimeout(provider: FxProvider): Promise<ProviderQuote> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`FX provider timed out after ${this.options.providerTimeoutMs}ms`));
      }, this.options.providerTimeoutMs);
    });
    try {
      return await Promise.race([provider.fetchUsdRates(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async persist(quote: ProviderQuote, refreshedAt: Date): Promise<void> {
    try {
      await this.options.db
        .insertInto('fx_rates')
        .values(
          CURRENCIES.map((currency) => ({
            currency,
            usd_rate: quote.usdRates[currency].toFixed(),
            provider: quote.provider,
            provider_updated_at: quote.providerUpdatedAt,
            refreshed_at: refreshedAt,
          })),
        )
        .onConflict((oc) =>
          oc.column('currency').doUpdateSet((eb) => ({
            usd_rate: eb.ref('excluded.usd_rate'),
            provider: eb.ref('excluded.provider'),
            provider_updated_at: eb.ref('excluded.provider_updated_at'),
            refreshed_at: eb.ref('excluded.refreshed_at'),
          })),
        )
        .execute();
    } catch (error) {
      // Failing to persist must not stop us from serving fresh rates.
      this.options.logger.warn({ err: error }, 'Could not persist FX snapshot');
    }
  }

  private async loadLastKnownGood(): Promise<RateSnapshot | null> {
    try {
      const rows = await this.options.db.selectFrom('fx_rates').selectAll().execute();
      const byCurrency = new Map(rows.map((row) => [row.currency, row]));
      if (!CURRENCIES.every((currency) => byCurrency.has(currency))) return null;

      const oldest = Math.min(...rows.map((row) => row.refreshed_at.getTime()));
      if (this.now().getTime() - oldest > this.options.maxStalenessMs) return null;

      const usdRates = {} as Record<Currency, MoneyValue>;
      for (const currency of CURRENCIES) {
        usdRates[currency] = toMoney(byCurrency.get(currency)!.usd_rate);
      }
      return {
        usdRates,
        source: 'cached',
        provider: rows[0]!.provider,
        refreshedAt: new Date(oldest),
      };
    } catch (error) {
      this.options.logger.warn({ err: error }, 'Could not load last-known-good FX snapshot');
      return null;
    }
  }

  private remember(snapshot: RateSnapshot, ttlMs: number): RateSnapshot {
    this.cached = { snapshot, expiresAt: this.now().getTime() + ttlMs };
    return snapshot;
  }
}

function staticSnapshot(): RateSnapshot {
  const usdRates = {} as Record<Currency, MoneyValue>;
  for (const currency of CURRENCIES) {
    usdRates[currency] = toMoney(STATIC_USD_RATES[currency]);
  }
  return { usdRates, source: 'static', provider: 'static-table', refreshedAt: STATIC_RATES_AS_OF };
}

export function serializeRate(rate: AppliedRate) {
  return {
    from: rate.from,
    to: rate.to,
    rate: formatRate(rate.rate),
    source: rate.source,
    refreshedAt: rate.asOf.toISOString(),
  };
}
