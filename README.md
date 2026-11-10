# Harmattan

> _Operation Borderless_: a stablecoin-powered cross-border payments sandbox API.

The Harmattan is the West African trade wind that blows from the Sahara to the Gulf of Guinea,
taking no notice of borders. **Harmattan** moves money the same way: a REST API for multi-currency wallets holding mock African and international
stablecoins (**cNGN, cGHS, cXAF, USDx, EURx**), with simulated deposits, FX swaps, cross-currency
transfers, transaction history and live conversion rates.

The scope is deliberately small. The effort went into what matters most for money: exact
arithmetic, no double-processing, no overdrafts under concurrency, and FX that degrades safely.

---

## Contents

- [Quick start](#quick-start)
- [Running the tests](#running-the-tests)
- [Tech stack and why](#tech-stack-and-why)
- [Why PostgreSQL](#why-postgresql)
- [API walkthrough](#api-walkthrough)
- [Data model](#data-model)
- [How the hard parts are handled](#how-the-hard-parts-are-handled)
  - [Money precision](#money-precision)
  - [Idempotency](#idempotency)
  - [Concurrency](#concurrency)
  - [FX rates and provider failures](#fx-rates-and-provider-failures)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Command reference (npm and Yarn)](#command-reference-npm-and-yarn)
- [Assumptions](#assumptions)
- [Known limitations](#known-limitations)
- [What I would do with more time](#what-i-would-do-with-more-time)

---

## Quick start

Requirements: **Docker** with Compose v2. Nothing else is needed to run the API.

```bash
docker compose up --build
```

This starts three services:

| Service   | What it does                                                                      |
| --------- | --------------------------------------------------------------------------------- |
| `db`      | PostgreSQL 16 (port `5432`, user/password/db `borderless`)                        |
| `migrate` | One-shot: applies database migrations, then exits                                 |
| `api`     | The API on **<http://localhost:3000>**; starts only after `migrate` has succeeded |

Migrations run automatically, and there is no seed data to load: create wallets through the API
(see the [walkthrough](#api-walkthrough)).

| URL                                  | What                              |
| ------------------------------------ | --------------------------------- |
| <http://localhost:3000/docs>         | Swagger UI (interactive API docs) |
| <http://localhost:3000/openapi.json> | OpenAPI 3 document                |
| <http://localhost:3000/health>       | Liveness + database check         |

The OpenAPI source is committed at [`docs/openapi.yaml`](docs/openapi.yaml).

**No internet access?** Run fully offline with the static rate table:
`FX_PROVIDER=static docker compose up --build`. Ports are configurable too:
`API_PORT=3001 DB_PORT=5433 docker compose up --build`.

### Running locally without Docker for the API

Requires Node.js 22 LTS. Postgres can still come from Compose:

```bash
npm install
docker compose up -d db        # or point DATABASE_URL at your own Postgres
cp .env.example .env           # optional; the defaults match the compose database
npm run migrate
npm run dev                    # tsx watch mode, pretty logs
```

---

## Running the tests

```bash
npm install
npm test
```

The suite needs **Docker running**: the integration tests start a throwaway PostgreSQL 16
container through [Testcontainers](https://testcontainers.com/), apply the migrations, and remove
the container afterwards. The first run pulls `postgres:16-alpine`; later runs take a few seconds.

To use an existing database instead of a container (in CI, say), set `TEST_DATABASE_URL`:

```bash
docker compose up -d db
TEST_DATABASE_URL=postgres://borderless:borderless@localhost:5432/borderless npm test
```

Tests create uniquely named data and never truncate tables, so pointing at a dev database is safe.

| Command                 | What                                     |
| ----------------------- | ---------------------------------------- |
| `npm test`              | Full suite (unit + integration), once    |
| `npm run test:watch`    | Watch mode                               |
| `npm run test:coverage` | With a V8 coverage report in `coverage/` |
| `npm run lint`          | ESLint (type-aware rules)                |
| `npm run format:check`  | Prettier check                           |
| `npm run typecheck`     | `tsc --noEmit` over source and tests     |

**What is covered (93 tests).** Integration tests go through HTTP (Supertest) against a real
Postgres, because the guarantees that matter (row locks, unique constraints, transactions) only
exist in the database. Highlights:

- **No overdraft under contention:** 25 concurrent swaps race for a balance that covers 10.
  Exactly 10 succeed, and the balance ends at exactly zero.
- **Exactly-once:** 10 concurrent requests with the same `Idempotency-Key` produce one transaction
  and one credit. Replays return the original body. A reused key with a different body is rejected.
- **No deadlocks:** 30 concurrent transfers flow in both directions between the same two wallets.
  All succeed and the totals are conserved.
- **Precision:** ten deposits of `0.1` total exactly `1.000000`, conversions round down, and
  amounts that would round to zero are rejected.
- **FX resilience:** single-flight caching, TTL expiry, provider timeout, fallback to the stored
  snapshot and then the static table, recovery after the retry window, and a hard
  `503 FX_UNAVAILABLE` when static fallback is disabled (balances are still served).
- Validation of every input, duplicate wallets (case and format-insensitive, including concurrent
  sign-ups), keyset pagination without gaps, and filters by type and by currency.

Using Yarn? `yarn test` runs the same suite; see the [command reference](#command-reference-npm-and-yarn).

---

## Tech stack and why

| Area          | Choice                                                              | Why                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | Node.js 22 LTS, TypeScript (`strict`, `noUncheckedIndexedAccess`)   | As required. The extra strictness catches `undefined` lookups, a common source of money bugs.                                                                                         |
| Framework     | **Express 5**                                                       | Small and explicit, and v5 forwards async errors to the error handler natively. NestJS would have added DI ceremony that this scope doesn't need.                                     |
| Database      | **PostgreSQL 16**                                                   | See [Why PostgreSQL](#why-postgresql).                                                                                                                                                |
| Query layer   | **Kysely**                                                          | Type-safe SQL that stays SQL: `SELECT … FOR UPDATE`, row-value comparisons and `ON CONFLICT` are first-class. An ORM would hide exactly the parts that need reviewing.                |
| Money         | **decimal.js**                                                      | Arbitrary-precision decimals. JavaScript `number` never touches an amount.                                                                                                            |
| Validation    | **Zod 4**                                                           | One schema validates, normalises (E.164 phones, lower-cased emails, Decimal amounts) and types each request.                                                                          |
| Logging       | **pino** + pino-http                                                | Structured JSON logs with request ids (`X-Request-Id` is honoured or generated).                                                                                                      |
| Tests         | **Vitest** + **Supertest** + **Testcontainers**                     | Real-Postgres integration tests with one command.                                                                                                                                     |
| Tooling       | **npm**, **ESLint** (typescript-eslint, type-checked), **Prettier** |                                                                                                                                                                                       |
| Cache / queue | **None, deliberately**                                              | The FX cache lives in process memory with its last-known-good copy in Postgres. Redis would only start paying off with several API instances (see [limitations](#known-limitations)). |
| Runtime       | Docker multi-stage image, Compose                                   | Production image with dev dependencies pruned, running as a non-root user, with a healthcheck.                                                                                        |

## Why PostgreSQL

This is a ledger, and the core requirements map directly onto relational guarantees:

- **ACID transactions across rows.** A transfer debits one balance, credits another, and writes a
  transaction plus two ledger entries. Either all of it commits or none of it does.
- **Row-level locks (`SELECT … FOR UPDATE`)** serialise competing spends on one balance without
  locking the whole wallet or table.
- **Constraints as a safety net.** `CHECK (amount >= 0)` on balances means even a bug in the
  service layer cannot persist an overdraft. `UNIQUE (wallet_id, idempotency_key)` makes
  exactly-once processing a database guarantee, not a best-effort check. `UNIQUE` on email and
  phone settles sign-up races.
- **Exact `NUMERIC` types** for amounts and rates.
- **Relational queries** for history (sent _and_ received, filtered by the currency that moved in
  this wallet), which come naturally with joins and `EXISTS`.

MongoDB could be made to work (it has multi-document transactions), but every guarantee above
would have to be rebuilt in application code. MySQL would also work; Postgres won on its stricter
`CHECK` enforcement, row-value comparisons for keyset pagination, and `gen_random_uuid()`.

---

## API walkthrough

All examples below are real responses from `docker compose up`, priced with live rates. Every
money-moving `POST` needs an `Idempotency-Key` header (a UUID is ideal). Amounts go in as decimal
strings and come back with a fixed scale of 6.

### 1. Create wallets: `POST /v1/wallets`

```bash
curl -s -X POST localhost:3000/v1/wallets \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com"}'
```

```json
{
  "id": "c437aece-f1f6-43b2-aa6c-b9fe2b24ef53",
  "email": "ada@example.com",
  "phone": null,
  "createdAt": "2026-11-10T14:07:50.846Z",
  "balances": [
    { "currency": "cNGN", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "cGHS", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "cXAF", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "USDx", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "EURx", "amount": "0.000000", "usdValue": "0.000000" }
  ],
  "totalUsd": "0.000000",
  "valuation": { "rateSource": "live", "ratesRefreshedAt": "2026-11-10T14:07:34.431Z" }
}
```

A wallet can also be created by phone (`{"phone":"+233 24 123 4567"}`, stored as `+233241234567`)
or with both. A second wallet with the same email (any casing) or the same number (any formatting)
returns `409 WALLET_ALREADY_EXISTS`.

### 2. Deposit: `POST /v1/wallets/{walletId}/deposits`

```bash
curl -s -X POST localhost:3000/v1/wallets/$ADA/deposits \
  -H 'content-type: application/json' -H 'Idempotency-Key: dep-001' \
  -d '{"currency":"cNGN","amount":"250000"}'
```

```json
{
  "id": "f9626984-d8fe-433a-894e-a1e5278d0fc5",
  "type": "DEPOSIT",
  "status": "COMPLETED",
  "walletId": "c437aece-f1f6-43b2-aa6c-b9fe2b24ef53",
  "source": { "currency": "cNGN", "amount": "250000.000000" },
  "destination": { "currency": "cNGN", "amount": "250000.000000" },
  "fx": { "rate": "1", "source": "identity", "asOf": "2026-11-10T14:07:50.971Z" },
  "createdAt": "2026-11-10T14:07:50.971Z"
}
```

Sending the identical request again returns the same body with `Idempotent-Replayed: true`, and
the wallet is not credited twice.

### 3. Swap: `POST /v1/wallets/{walletId}/swaps`

```bash
curl -s -X POST localhost:3000/v1/wallets/$ADA/swaps \
  -H 'content-type: application/json' -H 'Idempotency-Key: swap-001' \
  -d '{"fromCurrency":"cNGN","toCurrency":"USDx","amount":"150000"}'
```

```json
{
  "id": "731304d7-8c14-49ba-9e1e-9893069bd3cb",
  "type": "SWAP",
  "status": "COMPLETED",
  "walletId": "c437aece-f1f6-43b2-aa6c-b9fe2b24ef53",
  "source": { "currency": "cNGN", "amount": "150000.000000" },
  "destination": { "currency": "USDx", "amount": "111.187705" },
  "fx": { "rate": "0.000741251366844356", "source": "live", "asOf": "2026-11-10T14:07:34.431Z" },
  "createdAt": "2026-11-10T14:07:51.141Z"
}
```

150000 × 0.000741251366844356 = 111.18770502…, rounded **down** to `111.187705`.

### 4. Cross-currency transfer: `POST /v1/wallets/{walletId}/transfers`

```bash
curl -s -X POST localhost:3000/v1/wallets/$ADA/transfers \
  -H 'content-type: application/json' -H 'Idempotency-Key: xfer-001' \
  -d '{"toWalletId":"'$KOFI'","sourceCurrency":"USDx","destinationCurrency":"cGHS","amount":"25"}'
```

```json
{
  "id": "3eed5481-b042-453a-9c9d-674951e89630",
  "type": "TRANSFER",
  "status": "COMPLETED",
  "walletId": "c437aece-f1f6-43b2-aa6c-b9fe2b24ef53",
  "senderWalletId": "c437aece-f1f6-43b2-aa6c-b9fe2b24ef53",
  "receiverWalletId": "a5b6586a-b2a4-45bc-b1a7-36753a05cfa7",
  "source": { "currency": "USDx", "amount": "25.000000" },
  "destination": { "currency": "cGHS", "amount": "292.653950" },
  "fx": { "rate": "11.706158", "source": "live", "asOf": "2026-11-10T14:07:34.431Z" },
  "createdAt": "2026-11-10T14:07:51.172Z"
}
```

This records the sender, receiver, source amount and currency, destination amount and currency,
the rate applied (with its source and timestamp) and when it happened. Omit `destinationCurrency`
for a same-currency transfer.

### 5. Errors

```bash
curl -s -X POST localhost:3000/v1/wallets/$ADA/swaps \
  -H 'content-type: application/json' -H 'Idempotency-Key: swap-002' \
  -d '{"fromCurrency":"USDx","toCurrency":"EURx","amount":"1000"}'
```

```json
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Insufficient USDx balance.",
    "details": { "currency": "USDx", "available": "86.187705", "required": "1000.000000" }
  }
}
```

| Status | Codes                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`, `INVALID_JSON`, `IDEMPOTENCY_KEY_REQUIRED`, `SAME_CURRENCY_SWAP`, `SELF_TRANSFER` |
| 404    | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `NOT_FOUND`                                              |
| 409    | `WALLET_ALREADY_EXISTS`                                                                               |
| 422    | `INSUFFICIENT_FUNDS`, `AMOUNT_TOO_SMALL`, `IDEMPOTENCY_KEY_REUSED`                                    |
| 503    | `FX_UNAVAILABLE`                                                                                      |

### 6. Balances and USD total: `GET /v1/wallets/{walletId}` (or `/balances`)

```json
{
  "id": "c437aece-f1f6-43b2-aa6c-b9fe2b24ef53",
  "email": "ada@example.com",
  "phone": null,
  "createdAt": "2026-11-10T14:07:50.846Z",
  "balances": [
    { "currency": "cNGN", "amount": "100000.000000", "usdValue": "74.125137" },
    { "currency": "cGHS", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "cXAF", "amount": "0.000000", "usdValue": "0.000000" },
    { "currency": "USDx", "amount": "86.187705", "usdValue": "86.187705" },
    { "currency": "EURx", "amount": "0.000000", "usdValue": "0.000000" }
  ],
  "totalUsd": "160.312842",
  "valuation": { "rateSource": "live", "ratesRefreshedAt": "2026-11-10T14:07:34.431Z" }
}
```

### 7. History: `GET /v1/wallets/{walletId}/transactions`

Newest first. It includes deposits, swaps, and transfers both sent and received, the latter
marked with `direction`.

| Query      | Example         | Meaning                                                                   |
| ---------- | --------------- | ------------------------------------------------------------------------- |
| `type`     | `SWAP,TRANSFER` | One type or a comma-separated list                                        |
| `currency` | `cGHS`          | Only transactions that moved this currency **in this wallet**             |
| `limit`    | `20`            | 1–100, default 20                                                         |
| `cursor`   | _from response_ | Opaque keyset cursor: pass `pagination.nextCursor` to fetch the next page |

```bash
curl -s "localhost:3000/v1/wallets/$KOFI/transactions?currency=cGHS&limit=5"
```

```json
{
  "data": [
    {
      "id": "3eed5481-b042-453a-9c9d-674951e89630",
      "type": "TRANSFER",
      "status": "COMPLETED",
      "walletId": "c437aece-f1f6-43b2-aa6c-b9fe2b24ef53",
      "senderWalletId": "c437aece-f1f6-43b2-aa6c-b9fe2b24ef53",
      "receiverWalletId": "a5b6586a-b2a4-45bc-b1a7-36753a05cfa7",
      "direction": "RECEIVED",
      "source": { "currency": "USDx", "amount": "25.000000" },
      "destination": { "currency": "cGHS", "amount": "292.653950" },
      "fx": { "rate": "11.706158", "source": "live", "asOf": "2026-11-10T14:07:34.431Z" },
      "createdAt": "2026-11-10T14:07:51.172Z"
    }
  ],
  "pagination": { "limit": 5, "hasMore": false, "nextCursor": null }
}
```

A single transaction: `GET /v1/transactions/{transactionId}`.

### 8. Rates: `GET /v1/fx/rates` and `GET /v1/fx/quote`

```json
{
  "base": "USDx",
  "source": "live",
  "provider": "open.er-api.com",
  "refreshedAt": "2026-11-10T14:07:34.431Z",
  "rates": [
    {
      "from": "cNGN",
      "to": "cGHS",
      "rate": "0.008677205617995997",
      "source": "live",
      "refreshedAt": "2026-11-10T14:07:34.431Z"
    },
    {
      "from": "cNGN",
      "to": "cXAF",
      "rate": "0.433937082695169956",
      "source": "live",
      "refreshedAt": "2026-11-10T14:07:34.431Z"
    },
    {
      "from": "cNGN",
      "to": "USDx",
      "rate": "0.000741251366844356",
      "source": "live",
      "refreshedAt": "2026-11-10T14:07:34.431Z"
    }
  ]
}
```

(It returns all 20 ordered pairs; three are shown here.) To price a conversion without moving money:

```bash
curl -s "localhost:3000/v1/fx/quote?from=cNGN&to=cGHS&amount=10000"
```

```json
{
  "from": "cNGN",
  "to": "cGHS",
  "rate": "0.008677205617995997",
  "source": "live",
  "refreshedAt": "2026-11-10T14:07:34.431Z",
  "sourceAmount": "10000.000000",
  "destinationAmount": "86.772056"
}
```

---

## Data model

```mermaid
erDiagram
    currencies ||--o{ balances : "denominates"
    wallets ||--|{ balances : "has one per currency"
    wallets ||--o{ transactions : "initiates (wallet_id)"
    wallets ||--o{ transactions : "receives (counterparty_wallet_id)"
    transactions ||--|{ ledger_entries : "produces"
    wallets ||--o{ ledger_entries : ""
    currencies ||--o| fx_rates : "last-known-good"

    currencies {
        text code PK "cNGN, cGHS, cXAF, USDx, EURx"
        text fiat_code "NGN, GHS, XAF, USD, EUR"
        smallint decimals "6"
    }
    wallets {
        uuid id PK
        text email UK "lower-cased"
        text phone UK "E.164"
        timestamptz created_at
    }
    balances {
        uuid wallet_id PK,FK
        text currency PK,FK
        numeric_38_6 amount "CHECK >= 0"
        timestamptz updated_at
    }
    transactions {
        uuid id PK
        text type "DEPOSIT | SWAP | TRANSFER"
        text status "COMPLETED"
        uuid wallet_id FK "initiator / sender"
        uuid counterparty_wallet_id FK "receiver (transfers only)"
        text source_currency
        numeric_38_6 source_amount "> 0"
        text destination_currency
        numeric_38_6 destination_amount "> 0"
        numeric_38_18 fx_rate
        text fx_rate_source "identity | live | cached | static"
        timestamptz fx_rate_as_of
        text idempotency_key "UNIQUE with wallet_id"
        text request_hash "sha256 of normalised request"
        timestamptz created_at
    }
    ledger_entries {
        bigserial id PK
        uuid transaction_id FK
        uuid wallet_id FK
        text currency FK
        numeric_38_6 amount "signed, non-zero"
        numeric_38_6 balance_after "CHECK >= 0"
    }
    fx_rates {
        text currency PK,FK
        numeric_38_18 usd_rate "units per 1 USD"
        text provider
        timestamptz refreshed_at
    }
```

- **`balances`** is the current state (one row per wallet × currency, created with the wallet),
  so reads are O(1) and there is a row to lock.
- **`transactions`** is the business record shown to clients. Every operation, deposits
  included, uses the same source → destination shape; for deposits and same-currency transfers
  the rate is `1` with source `identity`.
- **`ledger_entries`** is append-only: one entry per balance movement, with the balance it
  produced, written in the same DB transaction as the balance update. It provides an audit trail,
  makes it possible to rebuild `balances` from history, and powers the per-wallet currency filter.
- A CHECK constraint ties `type = 'TRANSFER'` to `counterparty_wallet_id IS NOT NULL`.
- Indexes: `(wallet_id, created_at DESC, id DESC)` on transactions, a partial index on the
  counterparty for received transfers, and `(wallet_id, currency, transaction_id)` on ledger entries.

The schema lives in one migration, [`src/db/migrations/0001_initial_schema.ts`](src/db/migrations/0001_initial_schema.ts).

---

## How the hard parts are handled

### Money precision

- **Never a float.** Amounts are `NUMERIC(38, 6)` in Postgres, read back as strings by `pg`,
  handled as `decimal.js` values in code, and serialised as strings with a fixed scale of 6. FX
  rates are `NUMERIC(38, 18)`.
- **Strict input.** An amount must be a plain positive decimal (`/^(0|[1-9]\d*)(\.\d+)?$/`), with
  at most 6 decimal places and at most 10¹⁵ per operation. That rules out `1e3`, `-5`, `0`,
  `01.5`, `1,000`, `NaN` and `Infinity`. JSON numbers are accepted for convenience but go through
  their string form and the same rules; strings are the documented, recommended format.
- **Rounding direction is explicit.** Conversions (`amount × rate`) round **down** to 6 dp, so the
  platform never credits value it didn't debit; the sub-micro-unit remainder stays with the house.
  A conversion that rounds to zero is rejected (`AMOUNT_TOO_SMALL`) instead of silently consuming
  funds. Valuations (USD totals, which move no money) use banker's rounding.
- **Reproducible.** The stored rate is the exact 18-dp rate used to compute the destination
  amount, so `source_amount × fx_rate`, rounded down, always reproduces `destination_amount`.
- 6 decimals for every coin mirrors USDC and USDT. The `currencies.decimals` column is there for
  per-coin precision later (see [limitations](#known-limitations)).

### Idempotency

Every money-moving `POST` (deposit, swap, transfer) requires an `Idempotency-Key` header, scoped
to the initiating wallet.

1. **Fingerprint.** The _validated and normalised_ request (operation, wallet, currencies,
   recipient, amount in canonical form) is hashed with SHA-256. So `"100"` and `"100.000000"` count
   as the same request, while a different amount, currency or recipient does not.
2. **Fast path.** If the wallet already used this key, the stored transaction is returned
   (`201`, `Idempotent-Replayed: true`) without touching balances or calling the FX provider. The
   replay is the original result, at the original rate, even if rates have moved since. If the
   fingerprint differs, the response is `422 IDEMPOTENCY_KEY_REUSED`.
3. **Race-safe slow path.** The key is a column on the transaction row with
   `UNIQUE (wallet_id, idempotency_key)`, inserted as the **first** statement of the DB
   transaction. If two identical requests race, Postgres makes the second `INSERT` wait on the
   first's uncommitted row. When the first commits, the second gets a unique violation, rolls back
   having changed nothing, and replays the winner's result.
4. **Atomic by construction.** Since the key lives on the transaction itself, "the money moved"
   and "the key was consumed" commit together or not at all. There is no separate idempotency
   table that could drift from the ledger.

Failed operations (for example insufficient funds) roll back entirely and do not consume the key.
A client can top up and retry with the same key. That is deliberate: no money moved, so nothing
needs protecting.

### Concurrency

Each operation runs in a single Postgres transaction (`READ COMMITTED`) that:

1. inserts the transaction row (the idempotency gate above);
2. locks every affected balance row with `SELECT … FOR UPDATE`, **one at a time in a fixed global
   order** (`wallet_id:currency`), so two opposite transfers A→B and B→A can never deadlock;
3. checks for sufficient funds against the locked, current balance;
4. applies each delta with `amount = amount + delta` and writes a ledger entry with the resulting
   balance.

Spends against the same balance are serialised; unrelated wallets never block each other. As
defence in depth, `CHECK (amount >= 0)` on `balances` and `ledger_entries.balance_after` makes an
overdraft impossible to persist even if the service logic were wrong. Deadlock and serialization
failures (`40P01`, `40001`) are retried up to 3 times, though the lock ordering should make them
unreachable. Wallet sign-up races are settled by the unique indexes on email and phone.

The FX lookup happens _before_ the DB transaction opens, so no row lock is ever held across a
network call.

### FX rates and provider failures

Rates come live from [open.er-api.com](https://open.er-api.com) (free, no API key, and it quotes
NGN, GHS and XAF, which most ECB-based feeds don't). Each stablecoin is priced at its fiat peg,
and all cross rates are derived through USD: `rate(A→B) = usdRate[B] / usdRate[A]`.

```mermaid
flowchart LR
    R[Request needs a rate] --> C{In-memory snapshot fresh?}
    C -- yes --> U[Use it]
    C -- no --> P[Fetch provider<br/>3 s timeout, single-flight]
    P -- ok --> S[Persist to fx_rates<br/>cache for 5 min] --> U
    P -- fails / times out --> D{Snapshot in fx_rates<br/>younger than 24 h?}
    D -- yes --> DC[Use it as 'cached'<br/>retry provider in 30 s] --> U
    D -- no --> F{FX_STATIC_FALLBACK?}
    F -- true --> ST[Use static table as 'static'<br/>retry provider in 30 s] --> U
    F -- false --> E[503 FX_UNAVAILABLE]
```

- **Cache with single-flight.** A fresh snapshot is served from memory for `FX_CACHE_TTL_SECONDS`.
  When it expires, concurrent requests share one upstream call instead of stampeding the provider.
- **Defensive parsing.** The provider response is validated with Zod; partial data (a missing
  currency), non-positive rates and HTTP errors count as failures. Numbers convert to decimals via
  their shortest round-trip string, so no float noise gets in.
- **Last-known-good in Postgres.** Every successful fetch is upserted into `fx_rates`. When the
  provider is down, that snapshot is used if it is younger than `FX_MAX_STALENESS_SECONDS`. It also
  survives restarts.
- **Static table as the last resort**, captured from the live feed on 2026-11-10. It can be turned
  off (`FX_STATIC_FALLBACK=false`), in which case swaps and cross-currency transfers return `503`.
  Deposits and same-currency transfers still work, and balances are still served, with the USD
  valuation `null`.
- **Back-off.** After a failure the fallback is cached for only `FX_RETRY_AFTER_FAILURE_SECONDS`,
  so the service returns to live rates quickly without hammering a struggling provider.
- **Transparency.** Every rate, every balance valuation and every transaction carries its
  `source` (`live`, `cached`, `static` or `identity`) and its timestamp, so a client or auditor can
  always tell what priced a conversion.

---

## Configuration

All settings are environment variables with safe defaults; see [`.env.example`](.env.example).

| Variable                         | Default                                                      | Purpose                                              |
| -------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| `PORT`                           | `3000`                                                       | HTTP port                                            |
| `DATABASE_URL`                   | `postgres://borderless:borderless@localhost:5432/borderless` | Postgres connection                                  |
| `DATABASE_POOL_MAX`              | `10`                                                         | Connection pool size                                 |
| `LOG_LEVEL`                      | `info`                                                       | pino level (`silent` … `trace`)                      |
| `FX_PROVIDER`                    | `live`                                                       | `live` or `static` (offline)                         |
| `FX_API_URL`                     | `https://open.er-api.com/v6/latest/USD`                      | Provider endpoint                                    |
| `FX_CACHE_TTL_SECONDS`           | `300`                                                        | How long a live snapshot is served from memory       |
| `FX_RETRY_AFTER_FAILURE_SECONDS` | `30`                                                         | Back-off before retrying a failed provider           |
| `FX_PROVIDER_TIMEOUT_MS`         | `3000`                                                       | Provider request timeout                             |
| `FX_MAX_STALENESS_SECONDS`       | `86400`                                                      | Oldest stored snapshot still trusted                 |
| `FX_STATIC_FALLBACK`             | `true`                                                       | Allow pricing from the static table as a last resort |

---

## Project layout

```text
src/
  app.ts                  Express app factory (dependencies injected; used by server and tests)
  server.ts               Entrypoint: start HTTP, warm FX cache, graceful shutdown
  container.ts            Composition root: config -> logger, DB pool, FX service
  config.ts               Zod-validated environment
  domain/                 Currencies, money arithmetic, error catalogue
  db/                     Kysely setup, schema types, migrations, migrator, migrate CLI
  fx/                     Provider client, static table, caching/fallback service, routes
  wallets/                Wallet service and routes (incl. deposit/swap/transfer/history endpoints)
  transactions/           Money-movement service (locking + idempotency), serializer, routes
  http/                   Validation helpers, idempotency key + fingerprint, error handler
test/
  unit/                   Money maths, fingerprinting, provider parsing, cross rates
  integration/            HTTP tests against real Postgres: wallets, deposits, swaps,
                          transfers, history, FX fallback
  helpers/                Testcontainers global setup, fake FX provider, test app factory
docs/openapi.yaml         OpenAPI 3 specification (served at /docs)
```

---

## Command reference (npm and Yarn)

This project uses **npm**, and the committed lockfile is `package-lock.json`. The brief mentions
Yarn, so the Yarn equivalents are documented below. Every script lives in `package.json`, so
`yarn <script>` runs exactly the same thing as `npm run <script>`.

| Task                      | npm                                       | Yarn (v1 classic or Berry)          |
| ------------------------- | ----------------------------------------- | ----------------------------------- |
| Install dependencies      | `npm install` / `npm ci`                  | `yarn install`                      |
| Run the full test suite   | `npm test`                                | `yarn test`                         |
| Tests in watch mode       | `npm run test:watch`                      | `yarn test:watch`                   |
| Tests with coverage       | `npm run test:coverage`                   | `yarn test:coverage`                |
| Lint                      | `npm run lint`                            | `yarn lint`                         |
| Format / check formatting | `npm run format` / `npm run format:check` | `yarn format` / `yarn format:check` |
| Type-check                | `npm run typecheck`                       | `yarn typecheck`                    |
| Run migrations (dev)      | `npm run migrate`                         | `yarn migrate`                      |
| Start in watch mode       | `npm run dev`                             | `yarn dev`                          |
| Build                     | `npm run build`                           | `yarn build`                        |
| Start the compiled build  | `npm start`                               | `yarn start`                        |

Notes for Yarn users:

- `yarn install` resolves versions from `package.json` ranges because there is no `yarn.lock`. For
  the exact versions npm locked, run **`yarn import`** first (Yarn v1), which generates a
  `yarn.lock` from `package-lock.json`.
- On Yarn Berry (v2+), set `nodeLinker: node-modules` in `.yarnrc.yml` (or run
  `yarn config set nodeLinker node-modules`) so Vitest, ESLint and Testcontainers find packages
  the usual way.
- The Docker image always builds with `npm ci`, so Compose behaves the same whichever tool you
  use locally.

---

## Assumptions

- **Sandbox, no auth.** Anyone who knows a wallet id can act on it, as the brief allows. In
  production every route would be authenticated and authorised per wallet.
- **Identity.** A wallet needs an email, a phone number or both, and each must be unique. Emails
  are compared case-insensitively. Phones must be in international format and are normalised to
  E.164.
- **Stablecoins track their peg exactly.** cNGN = NGN, USDx = USD, and so on. There is no de-peg
  risk, spread, fee or slippage. Swaps execute at the mid-market rate.
- **Deposits are instant and final.** There is no pending state and no funding source.
  `status` exists on transactions (always `COMPLETED`) so async settlement can be added without a
  breaking API change.
- **Transfers name the sender's source amount.** The receiver gets the converted amount. A
  "receiver gets exactly X" mode would be a small addition.
- **Rates are priced at request time**, just before the DB transaction, with no quote lock.
- **Idempotency keys never expire.** Since they are part of the transaction record, they live as
  long as the transaction does.

## Known limitations

- **FX cache is per process.** With several API replicas, each keeps its own in-memory snapshot
  (they share the Postgres last-known-good copy). That is the point where Redis earns its place: a
  shared cache plus a distributed lock for single-flight refreshes.
- **No quote-then-execute.** A client can preview with `/v1/fx/quote`, but the swap is re-priced at
  execution. Real platforms issue a short-lived, signed quote id that the swap must reference.
- **Ledger is single-entry per wallet.** Swaps and cross-currency transfers create and destroy
  currency against an implicit market maker. A production system would book the other side
  against house/liquidity accounts so every transaction nets to zero per currency.
- **Every coin has 6 decimals.** The `currencies.decimals` column exists, but validation and
  rounding use one global scale.
- **No rate limiting**, no per-wallet or daily limits, no KYC/AML or sanctions screening.
- **History pagination is cursor-only** (no total count, no jump to page N), which is a deliberate
  trade-off for stable pages under concurrent writes.
- **Dev-only audit warnings.** `npm audit` reports moderate advisories in dev dependencies (via
  Testcontainers). The production dependency tree (`npm audit --omit=dev`) is clean.

## What I would do with more time

1. **Double-entry ledger** with house accounts per currency, plus a reconciliation job asserting
   `SUM(ledger_entries) = balances` and zero net per currency.
2. **Firm quotes:** `POST /v1/fx/quotes` returns a rate locked for ~30 s, and swaps and transfers
   reference the quote id.
3. **Fees and spreads** configured per corridor, recorded on the transaction and booked to
   revenue accounts.
4. **Authentication** (API keys or OAuth client credentials) with wallet ownership checks, and
   per-key rate limiting.
5. **Redis** for a shared FX cache and distributed single-flight, once the API runs as multiple
   replicas; a scheduled refresher instead of lazy refresh; and a second live provider before
   falling back to stored rates.
6. **Outbox pattern + webhooks** (BullMQ or RabbitMQ) to notify receivers of incoming transfers
   reliably.
7. **Observability:** Prometheus metrics (latency, FX source mix, lock waits, replay rate) and
   OpenTelemetry traces.
8. **Property-based tests** (fast-check) for money invariants, and load tests (k6) for lock
   contention on hot wallets.
9. Per-currency decimals, transaction limits and compliance hooks.
