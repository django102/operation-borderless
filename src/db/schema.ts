/**
 * TypeScript view of the database schema (see migrations/ for the DDL and constraints).
 */
import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import type { Currency } from '../domain/currency';

/*
 * Kysely table definitions. NUMERIC columns are read back from `pg` as strings and are
 * only ever turned into Decimal values, never into JavaScript numbers.
 */
type Numeric = ColumnType<string, string, string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type UpdatedAt = ColumnType<Date, Date | string | undefined, Date | string>;

export type TransactionType = 'DEPOSIT' | 'SWAP' | 'TRANSFER';
export type TransactionStatus = 'COMPLETED';
export type RateSource = 'identity' | 'live' | 'cached' | 'static';

export interface CurrenciesTable {
  code: Currency;
  fiat_code: string;
  name: string;
  decimals: number;
}

export interface WalletsTable {
  id: Generated<string>;
  email: string | null;
  phone: string | null;
  created_at: CreatedAt;
}

export interface BalancesTable {
  wallet_id: string;
  currency: Currency;
  amount: Numeric;
  updated_at: UpdatedAt;
}

export interface TransactionsTable {
  id: Generated<string>;
  type: TransactionType;
  status: TransactionStatus;
  wallet_id: string;
  counterparty_wallet_id: string | null;
  source_currency: Currency;
  source_amount: Numeric;
  destination_currency: Currency;
  destination_amount: Numeric;
  fx_rate: Numeric;
  fx_rate_source: RateSource;
  fx_rate_as_of: ColumnType<Date, Date | string, never>;
  idempotency_key: string;
  request_hash: string;
  created_at: CreatedAt;
}

export interface LedgerEntriesTable {
  id: Generated<string>;
  transaction_id: string;
  wallet_id: string;
  currency: Currency;
  amount: Numeric;
  balance_after: Numeric;
  created_at: CreatedAt;
}

export interface FxRatesTable {
  currency: Currency;
  /** Units of `currency` per 1 USD. */
  usd_rate: Numeric;
  provider: string;
  provider_updated_at: Date | null;
  refreshed_at: UpdatedAt;
}

export interface Database {
  currencies: CurrenciesTable;
  wallets: WalletsTable;
  balances: BalancesTable;
  transactions: TransactionsTable;
  ledger_entries: LedgerEntriesTable;
  fx_rates: FxRatesTable;
}

export type WalletRow = Selectable<WalletsTable>;
export type BalanceRow = Selectable<BalancesTable>;
export type TransactionRow = Selectable<TransactionsTable>;
export type NewTransaction = Insertable<TransactionsTable>;
export type FxRateRow = Selectable<FxRatesTable>;
