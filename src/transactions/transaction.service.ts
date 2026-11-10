/**
 * Money movement: deposits, swaps and transfers, plus transaction history.
 *
 * Invariants this module guarantees:
 *   - A balance never goes negative (service check under row lock + DB CHECK constraint).
 *   - Each (wallet, Idempotency-Key) moves money at most once, even under concurrent retries.
 *   - Every balance change has a ledger entry recording the resulting balance, written in the
 *     same DB transaction as the change.
 *   - The rate, its source and its timestamp are stored on the transaction, so a historical
 *     conversion can always be explained and recomputed.
 */
import { sql, type Transaction } from 'kysely';
import type { Currency } from '../domain/currency';
import { Errors } from '../domain/errors';
import { convert, formatAmount, toMoney, type MoneyValue } from '../domain/money';
import { PgError, isPgError, type Db } from '../db/database';
import type { Database, TransactionRow, TransactionType } from '../db/schema';
import type { AppliedRate, FxService } from '../fx/fx-service';
import { fingerprint } from '../http/idempotency';

export interface IdempotencyContext {
  key: string;
}

export interface DepositInput {
  walletId: string;
  currency: Currency;
  amount: MoneyValue;
}

export interface SwapInput {
  walletId: string;
  fromCurrency: Currency;
  toCurrency: Currency;
  amount: MoneyValue;
}

export interface TransferInput {
  walletId: string;
  toWalletId: string;
  sourceCurrency: Currency;
  destinationCurrency: Currency;
  amount: MoneyValue;
}

export interface ListTransactionsInput {
  walletId: string;
  types?: TransactionType[] | undefined;
  currency?: Currency | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface OperationResult {
  transaction: TransactionRow;
  /** True when this response replays an earlier request with the same Idempotency-Key. */
  replayed: boolean;
}

/** A single balance movement. Negative deltas are debits. */
interface Leg {
  walletId: string;
  currency: Currency;
  delta: MoneyValue;
}

interface Operation {
  type: TransactionType;
  walletId: string;
  counterpartyWalletId: string | null;
  sourceCurrency: Currency;
  sourceAmount: MoneyValue;
  destinationCurrency: Currency;
  destinationAmount: MoneyValue;
  rate: AppliedRate;
  legs: Leg[];
  idempotencyKey: string;
  requestHash: string;
}

const IDEMPOTENCY_CONSTRAINT = 'transactions_wallet_idempotency_key';
const MAX_ATTEMPTS = 3;

export class TransactionService {
  constructor(
    private readonly db: Db,
    private readonly fx: FxService,
  ) {}

  async deposit(input: DepositInput, idem: IdempotencyContext): Promise<OperationResult> {
    const requestHash = fingerprint('deposit', {
      walletId: input.walletId,
      currency: input.currency,
      amount: formatAmount(input.amount),
    });
    return this.run(input.walletId, idem.key, requestHash, async () => ({
      type: 'DEPOSIT',
      walletId: input.walletId,
      counterpartyWalletId: null,
      sourceCurrency: input.currency,
      sourceAmount: input.amount,
      destinationCurrency: input.currency,
      destinationAmount: input.amount,
      rate: await this.fx.getRate(input.currency, input.currency),
      legs: [{ walletId: input.walletId, currency: input.currency, delta: input.amount }],
      idempotencyKey: idem.key,
      requestHash,
    }));
  }

  async swap(input: SwapInput, idem: IdempotencyContext): Promise<OperationResult> {
    if (input.fromCurrency === input.toCurrency) throw Errors.sameCurrencySwap();
    const requestHash = fingerprint('swap', {
      walletId: input.walletId,
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      amount: formatAmount(input.amount),
    });
    return this.run(input.walletId, idem.key, requestHash, async () => {
      const rate = await this.fx.getRate(input.fromCurrency, input.toCurrency);
      const received = convert(input.amount, rate.rate);
      if (received.lte(0)) throw Errors.amountTooSmall();
      return {
        type: 'SWAP',
        walletId: input.walletId,
        counterpartyWalletId: null,
        sourceCurrency: input.fromCurrency,
        sourceAmount: input.amount,
        destinationCurrency: input.toCurrency,
        destinationAmount: received,
        rate,
        legs: [
          { walletId: input.walletId, currency: input.fromCurrency, delta: input.amount.neg() },
          { walletId: input.walletId, currency: input.toCurrency, delta: received },
        ],
        idempotencyKey: idem.key,
        requestHash,
      };
    });
  }

  async transfer(input: TransferInput, idem: IdempotencyContext): Promise<OperationResult> {
    if (input.walletId === input.toWalletId) throw Errors.selfTransfer();
    const requestHash = fingerprint('transfer', {
      walletId: input.walletId,
      toWalletId: input.toWalletId,
      sourceCurrency: input.sourceCurrency,
      destinationCurrency: input.destinationCurrency,
      amount: formatAmount(input.amount),
    });
    return this.run(input.walletId, idem.key, requestHash, async () => {
      await this.assertWalletExists(input.toWalletId);
      const rate = await this.fx.getRate(input.sourceCurrency, input.destinationCurrency);
      const received = convert(input.amount, rate.rate);
      if (received.lte(0)) throw Errors.amountTooSmall();
      return {
        type: 'TRANSFER',
        walletId: input.walletId,
        counterpartyWalletId: input.toWalletId,
        sourceCurrency: input.sourceCurrency,
        sourceAmount: input.amount,
        destinationCurrency: input.destinationCurrency,
        destinationAmount: received,
        rate,
        legs: [
          { walletId: input.walletId, currency: input.sourceCurrency, delta: input.amount.neg() },
          { walletId: input.toWalletId, currency: input.destinationCurrency, delta: received },
        ],
        idempotencyKey: idem.key,
        requestHash,
      };
    });
  }

  async get(transactionId: string): Promise<TransactionRow> {
    const row = await this.db
      .selectFrom('transactions')
      .selectAll()
      .where('id', '=', transactionId)
      .executeTakeFirst();
    if (!row) throw Errors.transactionNotFound(transactionId);
    return row;
  }

  /** Newest first, keyset-paginated on (created_at, id). */
  async list(input: ListTransactionsInput): Promise<{ rows: TransactionRow[]; hasMore: boolean }> {
    await this.assertWalletExists(input.walletId);
    const { walletId, types, currency, limit, cursor } = input;

    let query = this.db
      .selectFrom('transactions as t')
      .selectAll('t')
      .where((eb) =>
        eb.or([eb('t.wallet_id', '=', walletId), eb('t.counterparty_wallet_id', '=', walletId)]),
      );

    if (types?.length) {
      query = query.where('t.type', 'in', types);
    }
    if (currency) {
      // Match on the currency that actually moved in *this* wallet: a cNGN -> USDx transfer
      // is a cNGN transaction for the sender and a USDx transaction for the receiver.
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom('ledger_entries as le')
            .select(sql.lit(1).as('one'))
            .whereRef('le.transaction_id', '=', 't.id')
            .where('le.wallet_id', '=', walletId)
            .where('le.currency', '=', currency),
        ),
      );
    }
    if (cursor) {
      // Comparing against the cursor row's own timestamp in SQL avoids losing the
      // microsecond precision a JS Date would drop.
      query = query.where(
        sql<boolean>`(t.created_at, t.id) < (select c.created_at, c.id from transactions c where c.id = ${cursor})`,
      );
    }

    const rows = await query
      .orderBy('t.created_at', 'desc')
      .orderBy('t.id', 'desc')
      .limit(limit + 1)
      .execute();

    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  private async assertWalletExists(walletId: string): Promise<void> {
    const found = await this.db
      .selectFrom('wallets')
      .select('id')
      .where('id', '=', walletId)
      .executeTakeFirst();
    if (!found) throw Errors.walletNotFound(walletId);
  }

  /**
   * The idempotent, atomic core shared by every money movement.
   *
   *   1. Fast path: if this wallet already used the key, replay the stored result.
   *   2. Price the operation (FX lookup happens outside the DB transaction).
   *   3. In one DB transaction:
   *        a. INSERT the transaction row. The (wallet_id, idempotency_key) unique constraint
   *           makes a concurrent duplicate block here until the first one commits, then fail.
   *        b. Lock the affected balance rows with SELECT ... FOR UPDATE, in a fixed order
   *           (wallet_id, currency) so two opposite transfers cannot deadlock.
   *        c. Check funds, apply the deltas, write the ledger entries.
   *   4. If 3a lost a race, replay the winner's result.
   */
  private async run(
    walletId: string,
    idempotencyKey: string,
    requestHash: string,
    prepare: () => Promise<Operation>,
  ): Promise<OperationResult> {
    await this.assertWalletExists(walletId);

    const existing = await this.findByIdempotencyKey(walletId, idempotencyKey);
    if (existing) return this.replay(existing, requestHash);

    const operation = await prepare();

    for (let attempt = 1; ; attempt++) {
      try {
        const transaction = await this.db
          .transaction()
          .execute((trx) => this.apply(trx, operation));
        return { transaction, replayed: false };
      } catch (error) {
        if (
          isPgError(error, PgError.UNIQUE_VIOLATION) &&
          error.constraint === IDEMPOTENCY_CONSTRAINT
        ) {
          const winner = await this.findByIdempotencyKey(walletId, idempotencyKey);
          if (winner) return this.replay(winner, requestHash);
        }
        const retryable =
          isPgError(error, PgError.DEADLOCK_DETECTED) ||
          isPgError(error, PgError.SERIALIZATION_FAILURE);
        if (retryable && attempt < MAX_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  private async apply(trx: Transaction<Database>, op: Operation): Promise<TransactionRow> {
    const transaction = await trx
      .insertInto('transactions')
      .values({
        type: op.type,
        status: 'COMPLETED',
        wallet_id: op.walletId,
        counterparty_wallet_id: op.counterpartyWalletId,
        source_currency: op.sourceCurrency,
        source_amount: formatAmount(op.sourceAmount),
        destination_currency: op.destinationCurrency,
        destination_amount: formatAmount(op.destinationAmount),
        fx_rate: op.rate.rate.toFixed(),
        fx_rate_source: op.rate.source,
        fx_rate_as_of: op.rate.asOf,
        idempotency_key: op.idempotencyKey,
        request_hash: op.requestHash,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Code-unit comparison (not localeCompare) so the lock order is identical in every process.
    const lockKey = (leg: Leg) => `${leg.walletId}:${leg.currency}`;
    const legs = [...op.legs].sort((a, b) =>
      lockKey(a) < lockKey(b) ? -1 : lockKey(a) > lockKey(b) ? 1 : 0,
    );

    // Lock one row at a time, in order, so lock acquisition order is deterministic.
    const balances = new Map<string, MoneyValue>();
    for (const leg of legs) {
      const row = await trx
        .selectFrom('balances')
        .select('amount')
        .where('wallet_id', '=', leg.walletId)
        .where('currency', '=', leg.currency)
        .forUpdate()
        .executeTakeFirstOrThrow();
      balances.set(lockKey(leg), toMoney(row.amount));
    }

    for (const leg of legs) {
      const current = balances.get(lockKey(leg))!;
      const next = current.add(leg.delta);
      if (next.isNegative()) {
        throw Errors.insufficientFunds(
          leg.currency,
          formatAmount(current),
          formatAmount(leg.delta.abs()),
        );
      }
      const updated = await trx
        .updateTable('balances')
        .set({
          amount: sql<string>`amount + ${formatAmount(leg.delta)}::numeric`,
          updated_at: sql<Date>`now()`,
        })
        .where('wallet_id', '=', leg.walletId)
        .where('currency', '=', leg.currency)
        .returning('amount')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('ledger_entries')
        .values({
          transaction_id: transaction.id,
          wallet_id: leg.walletId,
          currency: leg.currency,
          amount: formatAmount(leg.delta),
          balance_after: updated.amount,
        })
        .execute();
    }

    return transaction;
  }

  private findByIdempotencyKey(walletId: string, key: string): Promise<TransactionRow | undefined> {
    return this.db
      .selectFrom('transactions')
      .selectAll()
      .where('wallet_id', '=', walletId)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  private replay(existing: TransactionRow, requestHash: string): OperationResult {
    if (existing.request_hash !== requestHash) throw Errors.idempotencyKeyReused();
    return { transaction: existing, replayed: true };
  }
}
