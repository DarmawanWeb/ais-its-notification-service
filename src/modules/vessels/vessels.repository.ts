import type { VesselSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';

import { isUniqueViolation } from '../../db/errors.js';
import * as schema from '../../db/schema.js';

const { vessels } = schema;

/** Owner and name of a vessel from the FLEET projection. */
export interface VesselOwner {
  readonly mmsi: number;
  readonly orgId: string | null;
  readonly name: string;
}

/** A `fleet.vessel.deleted.v1` payload. */
export interface DeletedVessel {
  readonly id: string;
  readonly mmsi: number;
  readonly orgId: string | null;
}

/**
 * The `vessels` projection of the `FLEET` stream (spec §8.5: services learn
 * mmsi → orgId from it). Writes keep the newest snapshot per vessel; deleted
 * vessels stay as tombstones (`deleted_at`) that ignore every later snapshot,
 * so a redelivered older upsert cannot bring a deleted vessel back. Reads see
 * live vessels only.
 */
@Injectable()
export class VesselsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /**
   * Stores a snapshot unless a newer one is stored or the vessel was deleted
   * (fleet never reuses vessel ids). A vessel that took over the MMSI of an
   * older (deleted or re-registered) vessel replaces it; a stale snapshot
   * whose MMSI belongs to a newer vessel by now is ignored (fleet keeps MMSIs
   * unique, so the newer vessel wins).
   *
   * @returns `false` when the snapshot is older than the stored state or the vessel is deleted
   */
  async upsert(snapshot: VesselSnapshotV1): Promise<boolean> {
    try {
      return await this.write(snapshot);
    } catch (error) {
      if (isUniqueViolation(error, 'vessels_mmsi_key')) return false;
      throw error;
    }
  }

  private write(snapshot: VesselSnapshotV1): Promise<boolean> {
    const updatedAt = new Date(snapshot.updatedAt);
    return this.db.transaction(async (tx) => {
      const [own] = await tx
        .select({ deletedAt: vessels.deletedAt })
        .from(vessels)
        .where(eq(vessels.vesselId, snapshot.id))
        .for('update');
      if (own !== undefined && own.deletedAt !== null) return false;
      await tx
        .delete(vessels)
        .where(
          and(
            eq(vessels.mmsi, snapshot.mmsi),
            ne(vessels.vesselId, snapshot.id),
            lte(vessels.updatedAt, updatedAt),
            isNull(vessels.deletedAt),
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
          // A tombstone written concurrently (after the check above) also wins.
          setWhere: sql`${vessels.updatedAt} <= ${updatedAt} AND ${vessels.deletedAt} IS NULL`,
        })
        .returning({ vesselId: vessels.vesselId });
      return rows.length > 0;
    });
  }

  /**
   * Tombstones a deleted vessel (`deleted_at` = the deletion's envelope
   * time). Repeatable; a deletion that arrives before any snapshot of the
   * vessel stores the tombstone alone.
   */
  async markDeleted(vessel: DeletedVessel, deletedAt: Date): Promise<void> {
    await this.db
      .insert(vessels)
      .values({
        vesselId: vessel.id,
        mmsi: vessel.mmsi,
        orgId: vessel.orgId,
        name: '',
        updatedAt: deletedAt,
        deletedAt,
      })
      .onConflictDoUpdate({
        target: vessels.vesselId,
        set: {
          deletedAt: sql`coalesce(${vessels.deletedAt}, excluded.deleted_at)`,
          projectedAt: sql`now()`,
        },
      });
  }

  /** Owners of the given vessels (live registered ones only). */
  async ownersOf(
    mmsis: readonly number[],
    executor: Database<typeof schema> = this.db,
  ): Promise<Map<number, VesselOwner>> {
    const unique = [...new Set(mmsis)];
    if (unique.length === 0) return new Map();
    const rows = await executor
      .select({ mmsi: vessels.mmsi, orgId: vessels.orgId, name: vessels.name })
      .from(vessels)
      .where(and(inArray(vessels.mmsi, unique), isNull(vessels.deletedAt)));
    return new Map(rows.map((row) => [row.mmsi, row]));
  }

  /** Owner organization of one vessel, `null` when unknown. */
  async orgOf(mmsi: number): Promise<string | null> {
    const owners = await this.ownersOf([mmsi]);
    return owners.get(mmsi)?.orgId ?? null;
  }
}
