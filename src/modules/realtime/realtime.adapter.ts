import { REALTIME_PATH } from '@darmawanweb/ais-its-contracts/realtime';
import { APP_CONFIG } from '@darmawanweb/ais-its-nest';
import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';

import type { Config } from '../../config.js';

/** Largest client → server message, bytes (viewports and subscriptions are tiny). */
const MAX_MESSAGE_BYTES = 16 * 1024;

/**
 * socket.io adapter of the gateway: attaches to the service's HTTP server
 * (same port as the REST API, path `/ws`) with the CORS origins of
 * `CORS_ORIGINS` and small message limits.
 */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly corsOrigins: readonly string[],
  ) {
    super(app);
  }

  override createIOServer(
    port: number | undefined,
    options?: ServerOptions,
  ): Server {
    const settings: Partial<ServerOptions> = {
      ...options,
      path: REALTIME_PATH,
      serveClient: false,
      maxHttpBufferSize: MAX_MESSAGE_BYTES,
      cors: { origin: [...this.corsOrigins], credentials: true },
    };
    // Nest declares the full ServerOptions; socket.io itself takes a partial one.
    return super.createIOServer(port, settings as ServerOptions);
  }
}

/**
 * Installs the realtime adapter on an application (`bootstrapService` /
 * `buildTestApp` option `configure`), before it is initialized.
 */
export function useRealtimeAdapter(app: INestApplication): void {
  const config = app.get<Config>(APP_CONFIG);
  app.useWebSocketAdapter(new RealtimeIoAdapter(app, config.CORS_ORIGINS));
}
