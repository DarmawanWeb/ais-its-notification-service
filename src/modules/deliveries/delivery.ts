import { LocaleSchema } from '@darmawanweb/ais-its-contracts/domain';
import { RealtimeAlertSchema } from '@darmawanweb/ais-its-contracts/realtime';
import * as z from 'zod';

import type { DeliveryStatus } from '../../db/schema.js';

/** Why a delivery was planned. */
export const DELIVERY_REASONS = ['raised', 'escalated', 'recurred'] as const;

/** Why a delivery was planned: a new alert, a higher severity, or a new occurrence. */
export type DeliveryReason = (typeof DELIVERY_REASONS)[number];

/**
 * What a delivery sends (`deliveries.payload`): the alert as pushed to
 * clients when the delivery was planned, with the names the texts need.
 */
export const DeliveryPayloadSchema = z.object({
  reason: z.enum(DELIVERY_REASONS),
  alert: RealtimeAlertSchema,
  ruleName: z.string().min(1),
  vesselName: z.string().nullable(),
  locale: LocaleSchema,
  link: z.url(),
});

/** What a delivery sends. */
export type DeliveryPayload = z.output<typeof DeliveryPayloadSchema>;

/** A delivery (`deliveries` row). */
export interface Delivery {
  readonly id: string;
  readonly alertId: string;
  readonly ruleId: string;
  readonly channel: 'email' | 'telegram' | 'webhook';
  readonly target: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly error: string | null;
  readonly payload: Record<string, unknown>;
  readonly nextAttemptAt: Date;
  readonly leaseUntil: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Filters of `GET /notifications/deliveries`. */
export interface DeliveryFilter {
  readonly ruleId?: string | undefined;
  readonly alertId?: string | undefined;
  readonly status?: DeliveryStatus | undefined;
}

/** Position of a delivery in the list order (cursor). */
export interface DeliveryCursor {
  readonly createdAt: string;
  readonly id: string;
}
