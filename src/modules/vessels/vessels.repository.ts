import type { VesselSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, lte, ne, sql } from 'drizzle-orm';

import * as schema from '../../db/schema.js';

const { vessels } = schema;

/** Owner and name of a vessel from the FLEET projection. */
export interface VesselOwner {
  readonly mmsi: number;
  readonly orgId: string | null;
  readonly name: string;
}

/**
 * The `vessels` projection of the `FLEET` stream (spec §8.5: services learn
 * mmsi → orgId from it). Writes keep the newest snapshot per vessel.
 */
@Injectable()
export class VesselsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /**
   * Stores a snapshot unless a newer one is stored. A vessel that took over
   * the MMSI of an older (deleted or re-registered) vessel replaces it.
   *
   * @returns `false` when the stored snapshot is newer
   */
  async upsert(snapshot: VesselSnapshotV1): Promise<boolean> {
    const updatedAt = new Date(snapshot.updatedAt);
    return this.db.transaction(async (tx) => {
      await tx
        .delete(vessels)
        .where(
          and(
            eq(vessels.mmsi, snapshot.mmsi),
            ne(vessels.vesselId, snapshot.id),
            lte(vessels.updatedAt, updatedAt),
          ),
        );
      const rows = await tx
        .insert(vessels)
        .values({
          vesselId: snapshot.id,
          mmsi: snapshot.mmsi,
          orgId: snapshot.orgId,
          name: snapshot.name,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: vessels.vesselId,
          set: {
            mmsi: sql`excluded.mmsi`,
            orgId: sql`excluded.org_id`,
            name: sql`excluded.name`,
            updatedAt: sql`excluded.updated_at`,
            projectedAt: sql`now()`,
          },
          setWhere: lte(vessels.updatedAt, updatedAt),
        })
        .returning({ vesselId: vessels.vesselId });
      return rows.length > 0;
    });
  }

  /** Removes a deleted vessel. */
  async delete(vesselId: string): Promise<void> {
    await this.db.delete(vessels).where(eq(vessels.vesselId, vesselId));
  }

  /** Owners of the given vessels (registered ones only). */
  async ownersOf(
    mmsis: readonly number[],
    executor: Database<typeof schema> = this.db,
  ): Promise<Map<number, VesselOwner>> {
    const unique = [...new Set(mmsis)];
    if (unique.length === 0) return new Map();
    const rows = await executor
      .select({ mmsi: vessels.mmsi, orgId: vessels.orgId, name: vessels.name })
      .from(vessels)
      .where(inArray(vessels.mmsi, unique));
    return new Map(rows.map((row) => [row.mmsi, row]));
  }

  /** Owner organization of one vessel, `null` when unknown. */
  async orgOf(mmsi: number): Promise<string | null> {
    const owners = await this.ownersOf([mmsi]);
    return owners.get(mmsi)?.orgId ?? null;
  }
}
