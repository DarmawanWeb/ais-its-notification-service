import {
  type RealtimeAlert,
  RealtimeAlertSchema,
  REALTIME_SERVER_EVENTS,
} from '@darmawanweb/ais-its-contracts/realtime';
import type { CoreSubscriptionDefinition } from '@darmawanweb/ais-its-contracts/events';
import { CoreSubscriptionHandler, type Msg, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';
import * as z from 'zod';

import { type AlertEvent, RealtimeHub } from './realtime-hub.service.js';

/**
 * Core NATS subject on which alert pushes are fanned out to every instance:
 * the durable `notification-alerts` consumer (and the REST ack/resolve)
 * changes an alert on one instance, but the clients are spread over all of
 * them. Internal to this service (no JetStream stream covers it).
 */
export const REALTIME_FANOUT_SUBSCRIPTION: CoreSubscriptionDefinition = {
  name: 'notification-realtime-fanout',
  subject: 'aisits.notification.realtime.v1',
  service: 'notification',
  description: 'alert:raised / alert:updated pushes fanned out to every notification instance',
};

/** A fanned-out alert push (validated on both ends with the contracts schema). */
const FanoutMessageSchema = z.object({
  event: z.enum([REALTIME_SERVER_EVENTS.ALERT_RAISED, REALTIME_SERVER_EVENTS.ALERT_UPDATED]),
  rooms: z.array(z.string().min(1).max(128)).min(1).max(16),
  alert: RealtimeAlertSchema,
});

/**
 * Pushes `alert:raised` / `alert:updated` (spec §9) to the `authority` room
 * and the owner organization rooms on every instance, through core NATS.
 */
@Injectable()
export class AlertBroadcaster {
  private readonly logger = new Logger(AlertBroadcaster.name);

  constructor(
    private readonly nats: NatsClient,
    private readonly hub: RealtimeHub,
  ) {}

  /**
   * Publishes a push after the change was committed. Best effort: a push that
   * cannot be published is delivered to this instance's clients only (the
   * inbox stays the source of truth).
   */
  publish(event: AlertEvent, alert: RealtimeAlert, rooms: readonly string[]): void {
    const message = FanoutMessageSchema.parse({ event, alert, rooms });
    try {
      this.nats.connection.publish(REALTIME_FANOUT_SUBSCRIPTION.subject, JSON.stringify(message));
    } catch (error) {
      this.logger.warn({ err: error, alertId: alert.id }, 'Alert push not fanned out; local clients only');
      this.hub.emitAlert(event, alert, rooms);
    }
  }

  @CoreSubscriptionHandler({ subscription: REALTIME_FANOUT_SUBSCRIPTION, queue: false })
  onFanout(message: Msg): void {
    const parsed = FanoutMessageSchema.safeParse(message.json<unknown>());
    if (!parsed.success) {
      this.logger.warn({ issues: parsed.error.issues }, 'Ignored an invalid alert push');
      return;
    }
    this.hub.emitAlert(parsed.data.event, parsed.data.alert, parsed.data.rooms);
  }
}
