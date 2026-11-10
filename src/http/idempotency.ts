/**
 * Idempotency-Key handling for money-moving endpoints.
 *
 * Storage and enforcement live in TransactionService: the key is a unique column on the
 * transaction itself, so "the money moved" and "the key was consumed" commit atomically.
 * There is no separate idempotency table that could disagree with the ledger.
 */
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { Errors } from '../domain/errors';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;

export function requireIdempotencyKey(req: Request): string {
  const key = req.header(IDEMPOTENCY_HEADER)?.trim();
  if (!key || !KEY_PATTERN.test(key)) {
    throw Errors.idempotencyKeyMissing();
  }
  return key;
}

/**
 * Fingerprint of the *normalised* request (validated, amounts in canonical form), so that a
 * retry with "100" and "100.000000" counts as the same request while a changed amount,
 * currency or recipient does not.
 */
export function fingerprint(operation: string, payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stableStringify({ operation, ...payload }))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
