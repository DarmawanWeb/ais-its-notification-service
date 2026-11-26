import type { CorsFeatureOptions } from '@darmawanweb/ais-its-nest/http';

import { TRUNCATED_HEADER } from './modules/alerts/alerts.controller.js';

/**
 * CORS of the service, used by `server.ts` and the tests: besides the kit's
 * defaults (`X-Request-Id`, `Retry-After`, `WWW-Authenticate`, `ETag`,
 * `Location`), cross-origin browser clients may read the file name
 * (`Content-Disposition`), the header language (`Content-Language`) and
 * `X-Truncated` of `GET /alerts/export.csv`.
 */
export const NOTIFICATION_CORS: CorsFeatureOptions = {
  exposedHeaders: ['Content-Disposition', 'Content-Language', TRUNCATED_HEADER],
};
