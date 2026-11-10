/**
 * Environment configuration, validated once at startup.
 *
 * Every setting has a safe default so `docker compose up` works with no .env file; invalid
 * values fail fast with a readable message instead of surfacing later as odd runtime behaviour.
 */
import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://borderless:borderless@localhost:5432/borderless'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** `live` uses the public FX API with fallbacks; `static` never leaves the process. */
  FX_PROVIDER: z.enum(['live', 'static']).default('live'),
  FX_API_URL: z.url().default('https://open.er-api.com/v6/latest/USD'),
  /** How long a successfully fetched rate snapshot is served from memory. */
  FX_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** How long to wait before retrying the provider after it failed. */
  FX_RETRY_AFTER_FAILURE_SECONDS: z.coerce.number().int().positive().default(30),
  FX_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  /** Last-known-good rates older than this are not used; the static table takes over. */
  FX_MAX_STALENESS_SECONDS: z.coerce.number().int().positive().default(86_400),
  /** When false, the API refuses to price conversions off the hard-coded table. */
  FX_STATIC_FALLBACK: booleanFromEnv.default(true),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return parsed.data;
}
