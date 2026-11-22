import type { OpenApiOptions } from '@darmawanweb/ais-its-nest';

import { SERVICE } from './service.js';

/** OpenAPI document of the service (`/docs`, `/openapi.json`, `pnpm openapi`). */
export const OPENAPI: OpenApiOptions = {
  title: `AIS Maritime Intelligence — ${SERVICE.title}`,
  version: SERVICE.version,
  description:
    `${SERVICE.description}. Realtime: socket.io at path /ws on the same origin ` +
    '(handshake auth { token }, events of @darmawanweb/ais-its-contracts/realtime).',
  tags: [
    {
      name: 'alerts',
      description: 'Alert inbox of safety and surveillance alerts',
    },
    {
      name: 'alert-rules',
      description: 'Alert rules and their delivery channels',
    },
    {
      name: 'notifications',
      description: 'Test notifications and the delivery log',
    },
    {
      name: 'methodology',
      description: 'Methods of the methodology catalog implemented here',
    },
  ],
};
