/**
 * HTTP layer for /v1/fx: the rate board and a read-only quote endpoint.
 */
import { Router } from 'express';
import { z } from 'zod';
import { REPORTING_CURRENCY } from '../domain/currency';
import { convert, formatAmount } from '../domain/money';
import { amountSchema, currencySchema, parse } from '../http/validation';
import { FxService, serializeRate } from './fx-service';

const quoteQuery = z.object({
  from: currencySchema,
  to: currencySchema,
  amount: amountSchema,
});

export function fxRouter(fx: FxService): Router {
  const router = Router();

  /** Every ordered pair of supported stablecoins, with when each rate was refreshed. */
  router.get('/rates', async (_req, res) => {
    const snapshot = await fx.getSnapshot();
    res.json({
      base: REPORTING_CURRENCY,
      source: snapshot.source,
      provider: snapshot.provider,
      refreshedAt: snapshot.refreshedAt.toISOString(),
      rates: FxService.allPairs(snapshot).map(serializeRate),
    });
  });

  /** Read-only price check: what `amount` of `from` would buy in `to` right now. */
  router.get('/quote', async (req, res) => {
    const query = parse(quoteQuery, req.query);
    const rate = await fx.getRate(query.from, query.to);
    res.json({
      ...serializeRate(rate),
      sourceAmount: formatAmount(query.amount),
      destinationAmount: formatAmount(convert(query.amount, rate.rate)),
    });
  });

  return router;
}
