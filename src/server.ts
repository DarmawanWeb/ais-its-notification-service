import 'reflect-metadata';

import { bootstrapService, loadConfig } from '@darmawanweb/ais-its-nest';

import { AppModule } from './app.module.js';
import { configSchema } from './config.js';
import { NOTIFICATION_CORS } from './cors.js';
import { useRealtimeAdapter } from './modules/realtime/realtime.adapter.js';
import { OPENAPI } from './openapi.options.js';

// Connect, migrate and ensure streams (onModuleInit) → restore state and start
// consumers (onApplicationBootstrap) → listen on HOST:PORT, with the socket.io
// gateway on the same server (path /ws). SIGTERM turns readiness to 503,
// disconnects realtime clients, drains consumers and NATS, then closes the pool.
await bootstrapService({
  appModule: AppModule,
  config: loadConfig(configSchema),
  openapi: OPENAPI,
  cors: NOTIFICATION_CORS,
  configure: useRealtimeAdapter,
});
