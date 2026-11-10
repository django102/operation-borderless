/**
 * Translates thrown errors into the API's error envelope:
 *   { "error": { "code": "MACHINE_READABLE", "message": "Human readable", "details"?: ... } }
 *
 * Domain errors (AppError) map to their own status. Anything unexpected is logged with the
 * request id and returned as a generic 500, so internals never leak to clients.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, Errors } from '../domain/errors';

export const notFoundHandler: RequestHandler = () => {
  throw Errors.notFound();
};

interface BodyParserError {
  type: string;
  status?: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return typeof error === 'object' && error !== null && 'type' in error && 'status' in error;
}

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  if (isBodyParserError(error)) {
    if (error.type === 'entity.parse.failed') {
      res
        .status(400)
        .json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
      return;
    }
    if (error.type === 'entity.too.large') {
      res
        .status(413)
        .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
      return;
    }
  }

  req.log.error({ err: error }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
  });
};
