/**
 * HTTP layer for /v1/transactions: global lookup of a single transaction by id.
 */
import { Router } from 'express';
import { z } from 'zod';
import { parse, uuidSchema } from '../http/validation';
import type { TransactionService } from './transaction.service';
import { serializeTransaction } from './transaction.serializer';

const params = z.object({ transactionId: uuidSchema });

export function transactionRouter(transactions: TransactionService): Router {
  const router = Router();

  router.get('/:transactionId', async (req, res) => {
    const { transactionId } = parse(params, req.params);
    res.json(serializeTransaction(await transactions.get(transactionId)));
  });

  return router;
}
