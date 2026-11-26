import { subjects } from '@darmawanweb/ais-its-contracts/events';
import {
  type RealtimeAlert,
  type RealtimeAlertFanout,
  RealtimeAlertFanoutSchema,
} from '@darmawanweb/ais-its-contracts/realtime';
import {
  CoreSubscriptionHandler,
  type Msg,
  NatsClient,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { type AlertEvent, RealtimeHub } from './realtime-hub.service.js';

/**
 * Pushes `alert:raised` / `alert:updated` (spec §9) to the `authority` room
 * and the owner organization rooms on every instance, through the contracts
 * core subscription `notification-realtime-fanout`
 * (`aisits.notification.realtime.v1`, `delivery: 'fanout'`): the durable
 * `notification-alerts` consumer and the REST ack/resolve change an alert on
 * one instance, while the socket clients are spread over all of them.
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
   *
   * @throws {ZodError} when the push does not fit `RealtimeAlertFanoutSchema` (a programming error)
   */
  publish(
    event: AlertEvent,
    alert: RealtimeAlert,
    rooms: readonly string[],
  ): void {
    const message = RealtimeAlertFanoutSchema.parse({ event, alert, rooms });
    try {
      this.nats.connection.publish(
        subjects.notificationRealtime(),
        JSON.stringify(message),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, alertId: alert.id },
        'Alert push not fanned out; local clients only',
      );
      this.hub.emitAlert(event, alert, rooms);
    }
  }

  /**
   * Every instance (this one included) emits the push to its own clients.
   * The kit subscribes without a queue group (the contracts definition's
   * `delivery: 'fanout'`) and validates the payload against
   * `CORE_SUBSCRIPTION_PAYLOADS` (invalid messages are dropped and counted as
   * `aisits_core_messages_total{outcome="invalid"}`).
   */
  @CoreSubscriptionHandler({ subscription: 'notification-realtime-fanout' })
  onFanout(_message: Msg, payload: RealtimeAlertFanout): void {
    this.hub.emitAlert(payload.event, payload.alert, payload.rooms);
  }
}
