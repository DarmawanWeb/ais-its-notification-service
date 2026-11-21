import type { Database, PoolClient } from '@darmawanweb/ais-its-nest/db';
import { drizzle } from 'drizzle-orm/node-postgres';

import * as schema from './schema.js';

/**
 * The drizzle database of one transaction: wraps the client handed out by
 * `withTransaction()` / `withIdempotency()` so repositories run their typed
 * queries inside that transaction.
 */
export function transactionDatabase(client: PoolClient): Database<typeof schema> {
  return drizzle({ client, schema });
}
