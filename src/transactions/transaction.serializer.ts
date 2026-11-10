import { formatAmount, formatRate, toMoney } from '../domain/money';
import type { TransactionRow } from '../db/schema';

/**
 * Public representation of a transaction. When `perspectiveWalletId` is given (wallet history
 * endpoint), transfers carry a `direction` relative to that wallet.
 */
export function serializeTransaction(row: TransactionRow, perspectiveWalletId?: string) {
  const isTransfer = row.type === 'TRANSFER';
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    walletId: row.wallet_id,
    ...(isTransfer
      ? {
          senderWalletId: row.wallet_id,
          receiverWalletId: row.counterparty_wallet_id,
          ...(perspectiveWalletId
            ? { direction: perspectiveWalletId === row.wallet_id ? 'SENT' : 'RECEIVED' }
            : {}),
        }
      : {}),
    source: { currency: row.source_currency, amount: formatAmount(toMoney(row.source_amount)) },
    destination: {
      currency: row.destination_currency,
      amount: formatAmount(toMoney(row.destination_amount)),
    },
    fx: {
      rate: formatRate(toMoney(row.fx_rate)),
      source: row.fx_rate_source,
      asOf: row.fx_rate_as_of.toISOString(),
    },
    createdAt: row.created_at.toISOString(),
  };
}

export function encodeCursor(transactionId: string): string {
  return Buffer.from(JSON.stringify({ id: transactionId })).toString('base64url');
}

export function decodeCursor(cursor: string): string | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof decoded === 'object' && decoded !== null && 'id' in decoded) {
      const { id } = decoded;
      return typeof id === 'string' ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}
