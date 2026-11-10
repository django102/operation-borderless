/**
 * Request validation built on Zod. Schemas both validate and normalise (trim, lower-case,
 * E.164 phones, Decimal amounts), so handlers only ever see clean, typed input.
 */
import { z } from 'zod';
import { CURRENCIES } from '../domain/currency';
import { Errors } from '../domain/errors';
import { parseAmount } from '../domain/money';

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Errors.validation(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export const currencySchema = z.enum(CURRENCIES, {
  error: () => `must be one of ${CURRENCIES.join(', ')}`,
});

/**
 * Amounts should be sent as decimal strings ("100.50"). Plain JSON numbers are tolerated for
 * convenience, but they are converted through their string form and held to the same rules.
 */
export const amountSchema = z
  .union([z.string(), z.number()], { error: () => 'must be a decimal string such as "100.50"' })
  .transform((raw, ctx) => {
    const result = parseAmount(String(raw));
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.reason });
      return z.NEVER;
    }
    return result.value;
  });

export const uuidSchema = z.uuid({ error: () => 'must be a valid UUID' });

export const walletIdParams = z.object({ walletId: uuidSchema });
