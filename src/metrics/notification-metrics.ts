import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Injectable } from '@nestjs/common';
import type { Counter, Gauge } from 'prom-client';

/**
 * Domain metrics of the service (spec §13.9, §10), prefix `aisits_`:
 * `aisits_notifications_sent_total{channel,outcome}`, `aisits_ws_connections`,
 * plus alert ingestion, e-mail and realtime counters.
 */
@Injectable()
export class NotificationMetrics {
  /** Notifications handed to a channel (`outcome`: sent, queued, retry, failed). */
  readonly notificationsSent: Counter<'channel' | 'outcome'>;
  /** Alerts consumed from ALERTS (`outcome`: raised, merged, escalated, duplicate). */
  readonly alertsIngested: Counter<'outcome'>;
  /** Transactional e-mails (`outcome`: sent, retry, failed, duplicate). */
  readonly emails: Counter<'template' | 'outcome'>;
  /** Open socket.io connections of this instance. */
  readonly wsConnections: Gauge;
  /** socket.io handshakes (`outcome`: accepted, rejected, unavailable). */
  readonly wsHandshakes: Counter<'outcome'>;
  /** Messages emitted to rooms (`event`: positions, safety:states, vessel:position, …). */
  readonly wsMessages: Counter<'event'>;

  constructor(metrics: MetricsService) {
    this.notificationsSent = metrics.counter({
      name: 'notifications_sent_total',
      help: 'Alert and test notifications handed to a channel, by channel and outcome',
      labelNames: ['channel', 'outcome'],
    });
    this.alertsIngested = metrics.counter({
      name: 'alerts_ingested_total',
      help: 'alert.raised.v1 events consumed into the inbox, by outcome',
      labelNames: ['outcome'],
    });
    this.emails = metrics.counter({
      name: 'emails_total',
      help: 'Transactional e-mails by template and outcome',
      labelNames: ['template', 'outcome'],
    });
    this.wsConnections = metrics.gauge({
      name: 'ws_connections',
      help: 'Open realtime (socket.io) connections of this instance',
    });
    this.wsHandshakes = metrics.counter({
      name: 'ws_handshakes_total',
      help: 'Realtime handshakes by outcome',
      labelNames: ['outcome'],
    });
    this.wsMessages = metrics.counter({
      name: 'ws_messages_total',
      help: 'Realtime messages emitted to rooms, by event',
      labelNames: ['event'],
    });
  }
}
