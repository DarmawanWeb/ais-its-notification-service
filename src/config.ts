import {
  type AppConfig,
  defineConfig,
  envBoolean,
  envInteger,
  envUrl,
  ServiceNameSchema,
  SqlIdentifierSchema,
} from '@darmawanweb/ais-its-nest';
import {
  REALTIME_ALL_TILES_BATCH_INTERVAL_MS,
  REALTIME_TILE_BATCH_INTERVAL_MS,
} from '@darmawanweb/ais-its-contracts/realtime';
import * as z from 'zod';

import { SERVICE } from './service.js';

/** Default sender of every e-mail (spec §13.9). */
export const DEFAULT_SMTP_FROM =
  'AIS Maritime Intelligence <no-reply@ais-its.local>';

/**
 * Environment of the service: the platform base variables (spec §4) with this
 * service's defaults, plus its own variables (spec §13.9). Add a variable here
 * and to `.env.example`; `loadConfig()` refuses to start on invalid values and
 * prints every problem.
 */
export const configSchema = defineConfig({
  SERVICE_NAME: ServiceNameSchema.default(SERVICE.name),
  SERVICE_VERSION: z.string().min(1).default(SERVICE.version),
  PORT: envInteger(0, 65_535).default(SERVICE.port),
  DATABASE_SCHEMA: SqlIdentifierSchema.default(SERVICE.schema),

  // --- E-mail (NOTIFY consumer, alert e-mails) -----------------------------
  /** SMTP server, e.g. `smtp://localhost:1025` (Mailpit) or `smtps://user:pass@host:465`. */
  SMTP_URL: envUrl(['smtp', 'smtps']).default('smtp://localhost:1025'),
  /** `From` header of every e-mail. */
  SMTP_FROM: z.string().min(3).max(320).default(DEFAULT_SMTP_FROM),
  /** Connection, greeting and socket timeout of one SMTP attempt, ms. */
  SMTP_TIMEOUT_MS: envInteger(1_000, 300_000).default(30_000),

  // --- Telegram (Bot API) ---------------------------------------------------
  /** Bot token; the Telegram channel is unavailable while it is unset. */
  TELEGRAM_BOT_TOKEN: z.string().min(1).max(256).optional(),
  /** Bot API base URL (a fake API in tests). */
  TELEGRAM_API_BASE: envUrl(['http', 'https']).default(
    'https://api.telegram.org',
  ),
  TELEGRAM_TIMEOUT_MS: envInteger(100, 120_000).default(10_000),

  // --- Webhooks -------------------------------------------------------------
  /** HMAC-SHA256 key of `X-AIS-ITS-Signature`; the webhook channel is unavailable while it is unset. */
  WEBHOOK_SIGNING_SECRET: z.string().min(16).max(1_024).optional(),
  WEBHOOK_TIMEOUT_MS: envInteger(100, 120_000).default(10_000),
  /**
   * Allow webhook targets on loopback, private and link-local addresses
   * (SSRF guard). Keep `false` in production; local development and tests
   * enable it.
   */
  WEBHOOK_ALLOW_PRIVATE_TARGETS: envBoolean().default(false),

  // --- Alert deliveries -----------------------------------------------------
  /** Attempts of one delivery before it is marked `failed`. */
  DELIVERY_MAX_ATTEMPTS: envInteger(1, 50).default(6),
  /** First retry delay; doubles per attempt (`base × 2^(attempt − 1)`), ms. */
  DELIVERY_RETRY_BASE_MS: envInteger(10, 86_400_000).default(30_000),
  /** Upper bound of a retry delay, ms. */
  DELIVERY_RETRY_MAX_MS: envInteger(10, 86_400_000).default(3_600_000),
  /** How often due deliveries are polled (new alerts also wake the worker), ms. */
  DELIVERY_POLL_INTERVAL_MS: envInteger(50, 60_000).default(1_000),
  /** Deliveries claimed per poll. */
  DELIVERY_BATCH_SIZE: envInteger(1, 500).default(20),
  /** Lease of a claimed delivery: after it, a crashed attempt is retried by any instance, ms. */
  DELIVERY_LEASE_MS: envInteger(1_000, 3_600_000).default(120_000),

  // --- Realtime gateway (spec §9) --------------------------------------------
  /** Batch interval of `positions` / `safety:states` for tile rooms, ms. */
  REALTIME_TILE_BATCH_INTERVAL_MS: envInteger(50, 60_000).default(
    REALTIME_TILE_BATCH_INTERVAL_MS,
  ),
  /** Batch interval of the `tile:all` room, ms. */
  REALTIME_ALL_TILES_BATCH_INTERVAL_MS: envInteger(50, 300_000).default(
    REALTIME_ALL_TILES_BATCH_INTERVAL_MS,
  ),
  /** Vessels whose latest position / safety state is kept in memory (LRU). */
  REALTIME_MAX_VESSELS: envInteger(100, 5_000_000).default(200_000),
  /** `vessel:<mmsi>` rooms one connection may join. */
  REALTIME_MAX_VESSEL_SUBSCRIPTIONS: envInteger(1, 10_000).default(100),
  /**
   * Close the transport of a connection when its access token expires, so
   * the client reconnects and authenticates with a fresh token.
   */
  REALTIME_REAUTH_ON_TOKEN_EXPIRY: envBoolean().default(true),

  // --- Housekeeping -----------------------------------------------------------
  /** Processed event ids kept for redelivery detection (≥ the ALERTS max age of 90 d), days. */
  IDEMPOTENCY_RETENTION_DAYS: envInteger(1, 3_650).default(90),
  /** Finished deliveries and e-mail log rows kept, days. */
  NOTIFICATION_LOG_RETENTION_DAYS: envInteger(1, 3_650).default(180),
});

/** Validated configuration; inject it with `@InjectConfig() config: Config`. */
export type Config = AppConfig<typeof configSchema>;
