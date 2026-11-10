/**
 * HTTP layer for /v1/wallets: wallet creation and lookup, plus the wallet-scoped money
 * movement (deposits, swaps, transfers) and history endpoints.
 *
 * Handlers are deliberately thin: parse and validate, call a service, serialise. All
 * business rules live in the services so they can be reasoned about (and tested) on their own.
 */
import { Router } from 'express';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import { REPLAYED_HEADER, requireIdempotencyKey } from '../http/idempotency';
import {
  amountSchema,
  currencySchema,
  parse,
  uuidSchema,
  walletIdParams,
} from '../http/validation';
import type { OperationResult, TransactionService } from '../transactions/transaction.service';
import {
  decodeCursor,
  encodeCursor,
  serializeTransaction,
} from '../transactions/transaction.serializer';
import type { Response } from 'express';
import type { WalletService } from './wallet.service';

const phoneSchema = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    const phone = parsePhoneNumberFromString(raw);
    if (!phone?.isValid()) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a valid phone number in international format, e.g. +2348031234567',
      });
      return z.NEVER;
    }
    return phone.number; // E.164, so "+234 803 123 4567" and "+2348031234567" are one wallet
  });

const createWalletBody = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email({ error: () => 'must be a valid email' })),
    phone: phoneSchema,
  })
  .partial()
  .strict()
  .refine((body) => body.email !== undefined || body.phone !== undefined, {
    message: 'provide an email or a phone number',
  });

const depositBody = z.object({ currency: currencySchema, amount: amountSchema }).strict();

const swapBody = z
  .object({ fromCurrency: currencySchema, toCurrency: currencySchema, amount: amountSchema })
  .strict();

const transferBody = z
  .object({
    toWalletId: uuidSchema,
    sourceCurrency: currencySchema,
    /** Defaults to the source currency (no conversion). */
    destinationCurrency: currencySchema.optional(),
    amount: amountSchema,
  })
  .strict();

const TRANSACTION_TYPES = ['DEPOSIT', 'SWAP', 'TRANSFER'] as const;

/** History filters. `type` accepts one value or a comma-separated list, case-insensitive. */
const listQuery = z.object({
  type: z
    .string()
    .transform((raw) => raw.split(',').map((t) => t.trim().toUpperCase()))
    .pipe(
      z.array(
        z.enum(TRANSACTION_TYPES, {
          error: () => `must be one of ${TRANSACTION_TYPES.join(', ')}`,
        }),
      ),
    )
    .optional(),
  currency: currencySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .transform((raw, ctx) => {
      const id = decodeCursor(raw);
      if (!id || !uuidSchema.safeParse(id).success) {
        ctx.addIssue({ code: 'custom', message: 'is not a valid cursor' });
        return z.NEVER;
      }
      return id;
    })
    .optional(),
});

/**
 * Money-moving endpoints answer 201 for both first execution and replays, so a client
 * retrying after a timeout sees exactly what it would have seen the first time.
 * `Idempotent-Replayed` tells the two apart for anyone who cares.
 */
function sendOperation(res: Response, result: OperationResult): void {
  res
    .status(201)
    .setHeader(REPLAYED_HEADER, String(result.replayed))
    .location(`/v1/transactions/${result.transaction.id}`)
    .json(serializeTransaction(result.transaction));
}

export function walletRouter(wallets: WalletService, transactions: TransactionService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const body = parse(createWalletBody, req.body ?? {});
    const wallet = await wallets.create(body);
    res
      .status(201)
      .location(`/v1/wallets/${wallet.id}`)
      .json(await wallets.view(wallet));
  });

  router.get('/:walletId', async (req, res) => {
    const { walletId } = parse(walletIdParams, req.params);
    res.json(await wallets.view(await wallets.get(walletId)));
  });

  router.get('/:walletId/balances', async (req, res) => {
    const { walletId } = parse(walletIdParams, req.params);
    res.json(await wallets.balances(walletId));
  });

  router.post('/:walletId/deposits', async (req, res) => {
    const { walletId } = parse(walletIdParams, req.params);
    const key = requireIdempotencyKey(req);
    const body = parse(depositBody, req.body);
    sendOperation(res, await transactions.deposit({ walletId, ...body }, { key }));
  });

  router.post('/:walletId/swaps', async (req, res) => {
    const { walletId } = parse(walletIdParams, req.params);
    const key = requireIdempotencyKey(req);
    const body = parse(swapBody, req.body);
    sendOperation(res, await transactions.swap({ walletId, ...body }, { key }));
  });

  router.post('/:walletId/transfers', async (req, res) => {
    const { walletId } = parse(walletIdParams, req.params);
    const key = requireIdempotencyKey(req);
    const body = parse(transferBody, req.body);
    const result = await transactions.transfer(
      {
        walletId,
        toWalletId: body.toWalletId,
        sourceCurrency: body.sourceCurrency,
        destinationCurrency: body.destinationCurrency ?? body.sourceCurrency,
        amount: body.amount,
      },
      { key },
    );
    sendOperation(res, result);
  });

  router.get('/:walletId/transactions', async (req, res) => {
    const { walletId } = parse(walletIdParams, req.params);
    const query = parse(listQuery, req.query);
    const { rows, hasMore } = await transactions.list({
      walletId,
      types: query.type,
      currency: query.currency,
      limit: query.limit,
      cursor: query.cursor,
    });
    const last = rows.at(-1);
    res.json({
      data: rows.map((row) => serializeTransaction(row, walletId)),
      pagination: {
        limit: query.limit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.id) : null,
      },
    });
  });

  return router;
}
