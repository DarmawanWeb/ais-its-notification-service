import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import { REALTIME_SERVER_EVENTS } from '@darmawanweb/ais-its-contracts/realtime';
import { ConflictError, DomainError } from '@darmawanweb/ais-its-nest';
import {
  type AuditRequest,
  AuditService,
} from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { cursorPage } from '@darmawanweb/ais-its-nest/http';
import { Injectable, Logger } from '@nestjs/common';

import { type AlertAction, transitionAlert } from '../../domain/alert-inbox.js';
import { AlertBroadcaster } from '../realtime/alert-broadcaster.js';
import { VesselsRepository } from '../vessels/vessels.repository.js';
import {
  type AlertCursor,
  type AlertFilter,
  alertRooms,
  alertScopeOf,
  type AlertSummary,
  type InboxAlert,
  toRealtimeAlert,
} from './alert.js';
import { AlertsRepository } from './alerts.repository.js';

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
      const mmsis =
        alert.relatedMmsi === null
          ? [alert.mmsi]
          : [alert.mmsi, alert.relatedMmsi];
      const owners = await this.vessels.ownersOf(mmsis);
      this.broadcaster.publish(
        REALTIME_SERVER_EVENTS.ALERT_UPDATED,
        toRealtimeAlert(alert),
        alertRooms([
          alert.orgId,
          ...[...owners.values()].map((owner) => owner.orgId),
        ]),
      );
    } catch (error) {
      this.logger.warn({ err: error, alertId: alert.id }, 'Alert push failed');
    }
  }
}

function alertNotFound(id: string): DomainError {
  return new DomainError('ALERT_NOT_FOUND', {
    detail: `No alert with id ${id}`,
    extra: { id },
  });
}
