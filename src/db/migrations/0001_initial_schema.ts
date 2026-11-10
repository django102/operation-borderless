import { sql, type Kysely } from 'kysely';

/* eslint-disable @typescript-eslint/no-explicit-any -- migrations must not depend on the live schema types */

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('currencies')
    .addColumn('code', 'text', (c) => c.primaryKey())
    .addColumn('fiat_code', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('decimals', 'smallint', (c) => c.notNull().check(sql`decimals between 0 and 18`))
    .execute();

  await db
    .insertInto('currencies')
    .values([
      { code: 'cNGN', fiat_code: 'NGN', name: 'Nigerian Naira Stablecoin', decimals: 6 },
      { code: 'cGHS', fiat_code: 'GHS', name: 'Ghanaian Cedi Stablecoin', decimals: 6 },
      { code: 'cXAF', fiat_code: 'XAF', name: 'Central African CFA Franc Stablecoin', decimals: 6 },
      { code: 'USDx', fiat_code: 'USD', name: 'US Dollar Stablecoin', decimals: 6 },
      { code: 'EURx', fiat_code: 'EUR', name: 'Euro Stablecoin', decimals: 6 },
    ])
    .execute();

  await db.schema
    .createTable('wallets')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('email', 'text', (c) => c.unique())
    .addColumn('phone', 'text', (c) => c.unique())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('wallets_identifier_present', sql`email is not null or phone is not null`)
    .execute();

  // One row per (wallet, currency). The CHECK constraint is the last line of defence against
  // overdrafts: even a bug in the service layer cannot persist a negative balance.
  await db.schema
    .createTable('balances')
    .addColumn('wallet_id', 'uuid', (c) => c.notNull().references('wallets.id').onDelete('cascade'))
    .addColumn('currency', 'text', (c) => c.notNull().references('currencies.code'))
    .addColumn('amount', sql`numeric(38, 6)`, (c) => c.notNull().defaultTo(0))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('balances_pkey', ['wallet_id', 'currency'])
    .addCheckConstraint('balances_amount_non_negative', sql`amount >= 0`)
    .execute();

  await db.schema
    .createTable('transactions')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('type', 'text', (c) =>
      c.notNull().check(sql`type in ('DEPOSIT', 'SWAP', 'TRANSFER')`),
    )
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('COMPLETED'))
    .addColumn('wallet_id', 'uuid', (c) => c.notNull().references('wallets.id'))
    .addColumn('counterparty_wallet_id', 'uuid', (c) => c.references('wallets.id'))
    .addColumn('source_currency', 'text', (c) => c.notNull().references('currencies.code'))
    .addColumn('source_amount', sql`numeric(38, 6)`, (c) =>
      c.notNull().check(sql`source_amount > 0`),
    )
    .addColumn('destination_currency', 'text', (c) => c.notNull().references('currencies.code'))
    .addColumn('destination_amount', sql`numeric(38, 6)`, (c) =>
      c.notNull().check(sql`destination_amount > 0`),
    )
    .addColumn('fx_rate', sql`numeric(38, 18)`, (c) => c.notNull().check(sql`fx_rate > 0`))
    .addColumn('fx_rate_source', 'text', (c) => c.notNull())
    .addColumn('fx_rate_as_of', 'timestamptz', (c) => c.notNull())
    .addColumn('idempotency_key', 'text', (c) => c.notNull())
    .addColumn('request_hash', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    // Idempotency keys are scoped to the wallet that initiates the operation.
    .addUniqueConstraint('transactions_wallet_idempotency_key', ['wallet_id', 'idempotency_key'])
    .addCheckConstraint(
      'transactions_transfer_has_counterparty',
      sql`(type = 'TRANSFER') = (counterparty_wallet_id is not null)`,
    )
    .execute();

  await db.schema
    .createIndex('transactions_wallet_created_idx')
    .on('transactions')
    .columns(['wallet_id', 'created_at desc', 'id desc'])
    .execute();
  await db.schema
    .createIndex('transactions_counterparty_created_idx')
    .on('transactions')
    .columns(['counterparty_wallet_id', 'created_at desc', 'id desc'])
    .where(sql.ref('counterparty_wallet_id'), 'is not', null)
    .execute();

  // Append-only ledger: every balance change is recorded with the balance it produced.
  await db.schema
    .createTable('ledger_entries')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('transaction_id', 'uuid', (c) => c.notNull().references('transactions.id'))
    .addColumn('wallet_id', 'uuid', (c) => c.notNull().references('wallets.id'))
    .addColumn('currency', 'text', (c) => c.notNull().references('currencies.code'))
    .addColumn('amount', sql`numeric(38, 6)`, (c) => c.notNull().check(sql`amount <> 0`))
    .addColumn('balance_after', sql`numeric(38, 6)`, (c) =>
      c.notNull().check(sql`balance_after >= 0`),
    )
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('ledger_entries_wallet_currency_idx')
    .on('ledger_entries')
    .columns(['wallet_id', 'currency', 'transaction_id'])
    .execute();
  await db.schema
    .createIndex('ledger_entries_transaction_idx')
    .on('ledger_entries')
    .column('transaction_id')
    .execute();

  // Last-known-good FX snapshot, used when the live provider is down.
  await db.schema
    .createTable('fx_rates')
    .addColumn('currency', 'text', (c) => c.primaryKey().references('currencies.code'))
    .addColumn('usd_rate', sql`numeric(38, 18)`, (c) => c.notNull().check(sql`usd_rate > 0`))
    .addColumn('provider', 'text', (c) => c.notNull())
    .addColumn('provider_updated_at', 'timestamptz')
    .addColumn('refreshed_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    'fx_rates',
    'ledger_entries',
    'transactions',
    'balances',
    'wallets',
    'currencies',
  ]) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
