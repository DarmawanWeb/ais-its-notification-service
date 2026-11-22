import type { AddressInfo } from 'node:net';

import { ACCESS_TOKEN_KEY_RESOLVER } from '@darmawanweb/ais-its-nest/auth';
import { PG_POOL } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import {
  buildTestApp,
  createTestConfig,
  createTestJwtIssuer,
  type TestJwtIssuer,
  type TestTokenClaims,
} from '@darmawanweb/ais-its-nest/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { inject } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { type Config, configSchema } from '../../src/config.js';
import { useRealtimeAdapter } from '../../src/modules/realtime/realtime.adapter.js';
import { OPENAPI } from '../../src/openapi.options.js';
import { SERVICE } from '../../src/service.js';

/** The real application on the shared containers, with a test token issuer. */
export interface TestService {
  readonly app: NestFastifyApplication;
  readonly config: Config;
  readonly jwt: TestJwtIssuer;
  readonly pool: Pool;
  readonly publisher: EventPublisher;
  /** `http://127.0.0.1:<port>` when started with `listen: true`. */
  readonly url: string;
  /** `Authorization` header with a freshly signed access token. */
  authorization(claims?: TestTokenClaims): Promise<{ authorization: string }>;
}

/** Options of {@link startTestService}. */
export interface TestServiceOptions {
  /** Extra environment (over the container endpoints). */
  readonly env?: Readonly<Record<string, string>>;
  /** Listen on a random local port (socket.io clients need a real server). */
  readonly listen?: boolean;
}

/**
 * Builds and initializes the AppModule as `bootstrapService()` does (hooks
 * run: migrations apply, streams and consumers start, the socket.io gateway
 * attaches at `/ws`); use `app.inject()` or, with `listen`, real HTTP and
 * socket.io clients. Close it with `app.close()`.
 *
 * Durable consumer names are the production ones: test files run one after
 * another on the shared NATS server, so each continues where the previous
 * one left off (the `NOTIFY` work queue allows one consumer only).
 */
export async function startTestService(
  options: TestServiceOptions = {},
): Promise<TestService> {
  const infra = inject('infra');
  const jwt = await createTestJwtIssuer();
  const config = createTestConfig(configSchema, {
    SERVICE_NAME: SERVICE.name,
    DATABASE_URL: infra.databaseUrl,
    DATABASE_SCHEMA: SERVICE.schema,
    DB_MIGRATE_ON_BOOT: 'true',
    NATS_URL: infra.natsUrl,
    SMTP_URL: infra.smtpUrl,
    PUBLIC_BASE_URL: 'http://localhost:8000',
    ...options.env,
  });
  const app = await buildTestApp(AppModule, {
    config,
    openapi: OPENAPI,
    configure: useRealtimeAdapter,
    overrides: [
      { provide: ACCESS_TOKEN_KEY_RESOLVER, useValue: jwt.keyResolver },
    ],
  });
  let url = '';
  if (options.listen === true) {
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  }
  return {
    app,
    config,
    jwt,
    pool: app.get<unknown, Pool>(PG_POOL),
    publisher: app.get(EventPublisher),
    url,
    authorization: async (claims) => ({
      authorization: `Bearer ${await jwt.sign(claims)}`,
    }),
  };
}
