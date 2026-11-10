/**
 * Wallet lifecycle and balance views.
 */
import { CURRENCIES, type Currency } from '../domain/currency';
import { AppError, Errors } from '../domain/errors';
import { Money, formatAmount, toMoney, value, type MoneyValue } from '../domain/money';
import { PgError, isPgError, type Db } from '../db/database';
import type { WalletRow } from '../db/schema';
import { FxService, type RateSnapshot } from '../fx/fx-service';

export interface CreateWalletInput {
  email?: string | undefined;
  phone?: string | undefined;
}

export interface BalanceView {
  currency: Currency;
  amount: string;
  usdValue: string | null;
}

export interface BalancesView {
  walletId: string;
  balances: BalanceView[];
  totalUsd: string | null;
  valuation: { rateSource: string; ratesRefreshedAt: string } | null;
}

export class WalletService {
  constructor(
    private readonly db: Db,
    private readonly fx: FxService,
  ) {}

  async create(input: CreateWalletInput): Promise<WalletRow> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const wallet = await trx
          .insertInto('wallets')
          .values({ email: input.email ?? null, phone: input.phone ?? null })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('balances')
          .values(CURRENCIES.map((currency) => ({ wallet_id: wallet.id, currency, amount: '0' })))
          .execute();
        return wallet;
      });
    } catch (error) {
      // The unique constraints, not a prior SELECT, decide: two concurrent sign-ups with the
      // same email cannot both win.
      if (isPgError(error, PgError.UNIQUE_VIOLATION)) {
        throw Errors.walletExists(error.constraint === 'wallets_phone_key' ? 'phone' : 'email');
      }
      throw error;
    }
  }

  async get(walletId: string): Promise<WalletRow> {
    const wallet = await this.db
      .selectFrom('wallets')
      .selectAll()
      .where('id', '=', walletId)
      .executeTakeFirst();
    if (!wallet) throw Errors.walletNotFound(walletId);
    return wallet;
  }

  /** Wallet details together with its balances and USD valuation. */
  async view(wallet: WalletRow) {
    const { walletId: _, ...balances } = await this.balancesFor(wallet.id);
    return { ...serializeWallet(wallet), ...balances };
  }

  /** Balances with per-currency and total USD valuation at current rates. */
  async balances(walletId: string): Promise<BalancesView> {
    await this.get(walletId);
    return this.balancesFor(walletId);
  }

  private async balancesFor(walletId: string): Promise<BalancesView> {
    const rows = await this.db
      .selectFrom('balances')
      .select(['currency', 'amount'])
      .where('wallet_id', '=', walletId)
      .execute();
    const amounts = new Map(rows.map((row) => [row.currency, toMoney(row.amount)]));

    // Balances are always served; if FX is unavailable only the USD valuation is omitted.
    let snapshot: RateSnapshot | null = null;
    try {
      snapshot = await this.fx.getSnapshot();
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }

    // Total is the sum of the rounded per-currency values, so the figures shown add up exactly.
    let total: MoneyValue = new Money(0);
    const balances = CURRENCIES.map((currency): BalanceView => {
      const amount = amounts.get(currency) ?? new Money(0);
      if (!snapshot) return { currency, amount: formatAmount(amount), usdValue: null };
      const usd = value(amount, FxService.toReporting(snapshot, currency).rate);
      total = total.add(usd);
      return { currency, amount: formatAmount(amount), usdValue: formatAmount(usd) };
    });

    return {
      walletId,
      balances,
      totalUsd: snapshot ? formatAmount(total) : null,
      valuation: snapshot
        ? { rateSource: snapshot.source, ratesRefreshedAt: snapshot.refreshedAt.toISOString() }
        : null,
    };
  }
}

export function serializeWallet(wallet: WalletRow) {
  return {
    id: wallet.id,
    email: wallet.email,
    phone: wallet.phone,
    createdAt: wallet.created_at.toISOString(),
  };
}
