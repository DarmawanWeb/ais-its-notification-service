import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  ALERT_DOMAINS,
  ALERT_SEVERITIES,
  KNOWN_ALERT_TYPES,
  type Locale,
} from '@darmawanweb/ais-its-contracts/domain';
import { REALTIME_SERVER_EVENTS } from '@darmawanweb/ais-its-contracts/realtime';
import {
  ConflictError,
  DomainError,
  ValidationFailedError,
} from '@darmawanweb/ais-its-nest';
import {
  type AuditRequest,
  AuditService,
} from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { cursorPage } from '@darmawanweb/ais-its-nest/http';
import { Injectable, Logger } from '@nestjs/common';

import { type AlertAction, transitionAlert } from '../../domain/alert-inbox.js';
import { csvLine } from '../../domain/csv.js';
import { AlertBroadcaster } from '../realtime/alert-broadcaster.js';
import { VesselsRepository } from '../vessels/vessels.repository.js';
import {
  type AlertCursor,
  type AlertFilter,
  alertMmsis,
  alertRooms,
  alertScopeOf,
  type AlertSummary,
  type InboxAlert,
  toRealtimeAlert,
} from './alert.js';
import { exportHeader, exportRow } from './alert-export.js';
import { assembleSeries } from './alert-series.js';
import {
  type AlertOccurrenceRow,
  AlertsRepository,
  type OccurrenceCursor,
} from './alerts.repository.js';
import {
  type AlertSeries,
  MAX_SERIES_BUCKETS,
  type SeriesBucket,
} from './dto/alert-series.dto.js';
import type { SeriesGroupBy } from './alerts.repository.js';

/** Rows per page of the CSV export query. */
const EXPORT_PAGE_SIZE = 1_000;

/** Nominal length of a series bucket, ms (local days are 23–25 h where the zone shifts its clock). */
const BUCKET_MS: Record<SeriesBucket, number> = {
  '1h': 3_600_000,
  '1d': 86_400_000,
};

/** Default period of a series without `from`: 24 hours of `1h` or 7 days of `1d` buckets. */
const SERIES_DEFAULT_MS: Record<SeriesBucket, number> = {
  '1h': 86_400_000,
  '1d': 7 * 86_400_000,
};

/** A CSV export: the capped row count and the lines (header first). */
export interface AlertExport {
  /** More rows matched than the export carries (`ALERT_EXPORT_MAX_ROWS`). */
  readonly truncated: boolean;
  readonly lines: AsyncIterable<string>;
}

/** Input of {@link AlertsService.series}. */
export interface AlertSeriesInput {
  readonly filter: Omit<AlertFilter, 'from'> & {
    readonly from?: Date | undefined;
  };
  readonly bucket: SeriesBucket;
  readonly groupBy: SeriesGroupBy;
  readonly timeZone: string;
}

/** Attempts of an action that races with a merge or another action. */
const ACTION_ATTEMPTS = 3;

/**
 * Use cases of the alert inbox over REST (spec §13.9): reads scoped by
 * tenancy (spec §8.5), acknowledge and resolve with the audit trail and an
 * `alert:updated` push.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly alerts: AlertsRepository,
    private readonly vessels: VesselsRepository,
    private readonly broadcaster: AlertBroadcaster,
    private readonly audit: AuditService,
  ) {}

  /** One page of the visible alerts, newest first. */
  async list(
    filter: AlertFilter,
    after: AlertCursor | undefined,
    limit: number,
    principal: Principal,
  ): Promise<CursorPage<InboxAlert>> {
    const rows = await this.alerts.list(
      filter,
      alertScopeOf(principal),
      after,
      limit + 1,
    );
    return cursorPage(rows, limit, (row) => ({
      occurredAt: row.occurredAt.toISOString(),
      id: row.id,
    }));
  }

  /** A visible alert, else `404 ALERT_NOT_FOUND` (also for alerts of other tenants). */
  async get(id: string, principal: Principal): Promise<InboxAlert> {
    const alert = await this.alerts.findById(id, alertScopeOf(principal));
    if (alert === undefined) throw alertNotFound(id);
    return alert;
  }

  /** Open alert counts visible to the principal. */
  summary(principal: Principal): Promise<AlertSummary> {
    return this.alerts.summary(alertScopeOf(principal));
  }

  /**
   * The occurrence history of a visible alert, newest first (`404
   * ALERT_NOT_FOUND` like `get`). Alerts stored before 0.2.0 have none.
   */
  async occurrences(
    id: string,
    after: OccurrenceCursor | undefined,
    limit: number,
    principal: Principal,
  ): Promise<CursorPage<AlertOccurrenceRow>> {
    const alert = await this.get(id, principal);
    const rows = await this.alerts.listOccurrences(alert, after, limit + 1);
    return cursorPage(rows, limit, (row) => ({
      occurredAt: row.occurredAt.toISOString(),
      eventId: row.eventId,
    }));
  }

  /** Unread open alerts of the principal in its active organization, and its read mark. */
  async unread(
    principal: Principal,
  ): Promise<{ unread: number; readUpTo: Date | undefined }> {
    const readUpTo = await this.alerts.findReadMark(
      principal.id,
      principal.orgId,
    );
    const unread = await this.alerts.countUnread(
      alertScopeOf(principal),
      readUpTo,
    );
    return { unread, readUpTo };
  }

  /**
   * Moves the principal's read mark in its active organization forward to
   * `upTo` (at most now; never backwards).
   */
  async markRead(
    upTo: Date | undefined,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<{ unread: number; readUpTo: Date | undefined }> {
    const until = upTo === undefined || upTo > now ? now : upTo;
    const readUpTo = await this.alerts.advanceReadMark(
      principal.id,
      principal.orgId,
      until,
    );
    const unread = await this.alerts.countUnread(
      alertScopeOf(principal),
      readUpTo,
    );
    return { unread, readUpTo };
  }

  /**
   * Visible alerts per bucket of their first occurrence and `groupBy` value,
   * every local hour or day from the one containing `from` to the one
   * containing `to`, the first and last clipped to the range
   * ({@link assembleSeries}).
   *
   * @throws {ValidationFailedError} for an unknown time zone or more than {@link MAX_SERIES_BUCKETS} buckets (counted after clipping)
   */
  async series(
    input: AlertSeriesInput,
    principal: Principal,
  ): Promise<AlertSeries> {
    const timeZone = await this.alerts.timeZoneName(input.timeZone);
    if (timeZone === undefined) {
      throw new ValidationFailedError([
        {
          field: 'tz',
          message: `Unknown time zone ${input.timeZone}`,
          code: 'isTimeZone',
        },
      ]);
    }
    const { to } = input.filter;
    const from =
      input.filter.from ??
      new Date(to.getTime() - SERIES_DEFAULT_MS[input.bucket]);
    if (from > to) {
      throw new ValidationFailedError([
        {
          field: 'from',
          message: 'from must not be after to',
          code: 'timeRange',
        },
      ]);
    }
    // Bounds the query's grid: a longer range never fits in the bucket cap
    // (not even with 25-hour days); the exact count is checked below.
    if (
      to.getTime() - from.getTime() >
      (MAX_SERIES_BUCKETS + 1) * BUCKET_MS[input.bucket]
    ) {
      throw tooManyBuckets(input.bucket);
    }
    const rows = await this.alerts.series(
      { ...input.filter, from },
      alertScopeOf(principal),
      input.bucket === '1h' ? 'hour' : 'day',
      timeZone,
      input.groupBy,
    );
    const keys = new Set<string>(registryKeys(input.groupBy));
    for (const row of rows) if (row.key !== null) keys.add(row.key);
    const buckets = assembleSeries(rows, [...keys], from, to);
    if (buckets.length > MAX_SERIES_BUCKETS) throw tooManyBuckets(input.bucket);
    return {
      from,
      to,
      bucket: input.bucket,
      groupBy: input.groupBy,
      timeZone,
      keys: [...keys],
      buckets,
    };
  }

  /**
   * The visible alerts matching `filter` as CSV (newest first, header in
   * `locale`), at most `maxRows`, read page by page while the client
   * consumes the stream.
   */
  async exportCsv(
    filter: AlertFilter,
    locale: Locale,
    maxRows: number,
    principal: Principal,
  ): Promise<AlertExport> {
    const scope = alertScopeOf(principal);
    const matched = await this.alerts.countUpTo(filter, scope, maxRows + 1);
    const alerts = this.alerts;
    async function* lines(): AsyncGenerator<string> {
      yield csvLine(exportHeader(locale));
      let after: AlertCursor | undefined;
      let remaining = maxRows;
      while (remaining > 0) {
        const page = await alerts.list(
          filter,
          scope,
          after,
          Math.min(EXPORT_PAGE_SIZE, remaining),
        );
        for (const alert of page) yield csvLine(exportRow(alert));
        remaining -= page.length;
        const last = page.at(-1);
        if (last === undefined || page.length < EXPORT_PAGE_SIZE) return;
        after = { occurredAt: last.occurredAt.toISOString(), id: last.id };
      }
    }
    return { truncated: matched > maxRows, lines: lines() };
  }

  /** `POST /alerts/:id/ack`: open → acknowledged (idempotent). */
  acknowledge(
    id: string,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<InboxAlert> {
    return this.act(id, 'acknowledge', principal, request);
  }

  /** `POST /alerts/:id/resolve`: open / acknowledged → resolved (idempotent). */
  resolve(
    id: string,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<InboxAlert> {
    return this.act(id, 'resolve', principal, request);
  }

  private async act(
    id: string,
    action: AlertAction,
    principal: Principal,
    request: AuditRequest | undefined,
  ): Promise<InboxAlert> {
    for (let attempt = 1; ; attempt += 1) {
      const current = await this.get(id, principal);
      const transition = transitionAlert(
        current,
        action,
        principal.id,
        new Date(),
      );
      if ('rejected' in transition) {
        throw new ConflictError(
          `Alert ${id} is resolved and cannot be acknowledged`,
          {
            code: transition.rejected,
            extra: { id, status: current.status },
          },
        );
      }
      if (!transition.changed) return current;
      const updated = await this.alerts.updateLifecycle(
        current,
        transition.lifecycle,
      );
      if (updated !== undefined) {
        await this.afterChange(updated, action, principal, request);
        return updated;
      }
      // The status changed meanwhile (a merge reopened it, another user acted): re-read.
      if (attempt >= ACTION_ATTEMPTS) {
        throw new ConflictError(`Alert ${id} changed concurrently, retry`, {
          code: 'CONFLICT',
        });
      }
    }
  }

  private async afterChange(
    alert: InboxAlert,
    action: AlertAction,
    principal: Principal,
    request: AuditRequest | undefined,
  ): Promise<void> {
    await this.audit.record(
      {
        action:
          action === 'acknowledge' ? 'alert.acknowledge' : 'alert.resolve',
        targetType: 'alert',
        targetId: alert.id,
        orgId: alert.orgId,
        meta: { type: alert.type, mmsi: alert.mmsi, status: alert.status },
      },
      principal,
      request,
    );
    try {
      // The current owners only (as the alert is read over REST), not the owner at ingest time.
      const owners = await this.vessels.ownersOf(alertMmsis(alert));
      this.broadcaster.publish(
        REALTIME_SERVER_EVENTS.ALERT_UPDATED,
        toRealtimeAlert(alert),
        alertRooms([...owners.values()].map((owner) => owner.orgId)),
      );
    } catch (error) {
      this.logger.warn({ err: error, alertId: alert.id }, 'Alert push failed');
    }
  }
}

/** Registry values of a series dimension (counted even when 0). */
function registryKeys(groupBy: SeriesGroupBy): readonly string[] {
  switch (groupBy) {
    case 'severity':
      return ALERT_SEVERITIES;
    case 'domain':
      return ALERT_DOMAINS;
    case 'type':
      return KNOWN_ALERT_TYPES;
  }
}

/** `400 VALIDATION_FAILED`: the range spans more than {@link MAX_SERIES_BUCKETS} buckets. */
function tooManyBuckets(bucket: SeriesBucket): ValidationFailedError {
  return new ValidationFailedError([
    {
      field: 'from',
      message: `At most ${MAX_SERIES_BUCKETS} buckets of ${bucket} per request`,
      code: 'maxBuckets',
    },
  ]);
}

function alertNotFound(id: string): DomainError {
  return new DomainError('ALERT_NOT_FOUND', {
    detail: `No alert with id ${id}`,
    extra: { id },
  });
}
