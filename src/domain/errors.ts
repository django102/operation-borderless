/**
 * Every error a client can receive, in one place, so codes, statuses and messages stay
 * consistent. Status code conventions:
 *   400  the request itself is malformed or nonsensical (bad input, same-currency swap)
 *   404  a referenced wallet/transaction does not exist
 *   409  conflicts with existing state (duplicate wallet)
 *   422  well-formed but refused by a business rule (insufficient funds, key reuse)
 *   503  a dependency (FX) cannot be trusted right now
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (details: unknown) =>
    new AppError(400, 'VALIDATION_ERROR', 'The request is invalid.', details),
  idempotencyKeyMissing: () =>
    new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'An Idempotency-Key header (1-255 characters of [A-Za-z0-9_.:-]) is required for this operation.',
    ),
  idempotencyKeyReused: () =>
    new AppError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request.',
    ),
  walletNotFound: (walletId: string) =>
    new AppError(404, 'WALLET_NOT_FOUND', `Wallet ${walletId} does not exist.`),
  transactionNotFound: (transactionId: string) =>
    new AppError(404, 'TRANSACTION_NOT_FOUND', `Transaction ${transactionId} does not exist.`),
  walletExists: (field: 'email' | 'phone') =>
    new AppError(409, 'WALLET_ALREADY_EXISTS', `A wallet with this ${field} already exists.`, {
      field,
    }),
  insufficientFunds: (currency: string, available: string, required: string) =>
    new AppError(422, 'INSUFFICIENT_FUNDS', `Insufficient ${currency} balance.`, {
      currency,
      available,
      required,
    }),
  sameCurrencySwap: () =>
    new AppError(400, 'SAME_CURRENCY_SWAP', 'A swap needs two different currencies.'),
  selfTransfer: () =>
    new AppError(
      400,
      'SELF_TRANSFER',
      'A wallet cannot transfer to itself. Use a swap to change currency.',
    ),
  amountTooSmall: () =>
    new AppError(
      422,
      'AMOUNT_TOO_SMALL',
      'The converted amount rounds down to zero at the current rate.',
    ),
  fxUnavailable: () =>
    new AppError(503, 'FX_UNAVAILABLE', 'FX rates are temporarily unavailable. Try again later.'),
  notFound: () => new AppError(404, 'NOT_FOUND', 'Route not found.'),
};
