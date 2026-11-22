// Drizzle definitions of the "notify" schema (docs/PLATFORM_SPEC.md §6).
// The SQL files in migrations/ create the tables; these definitions MUST
// mirror them and only type the queries.
import type { NotificationChannel } from '@darmawanweb/ais-its-contracts/domain';
import * as pg from 'drizzle-orm/pg-core';

/** The service's PostgreSQL schema, owned by the role `notify_svc`. */
export const serviceSchema = pg.pgSchema('notify');

const timestamptz = (name: string) =>
  pg.timestamp(name, { withTimezone: true });

/** Projection of the `FLEET` stream: mmsi → owner organization (`0001_init.sql`). */
export const vessels = serviceSchema.table(
  'vessels',
  {
    vesselId: pg.uuid('vessel_id').primaryKey(),
    mmsi: pg.integer('mmsi').notNull(),
    orgId: pg.uuid('org_id'),
    name: pg.text('name').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    projectedAt: timestamptz('projected_at').notNull().defaultNow(),
  },
  (table) => [
    pg.unique('vessels_mmsi_key').on(table.mmsi),
    pg.index('vessels_org_idx').on(table.orgId),
  ],
);

/** Alert inbox, a hypertable on `occurred_at` (`0001_init.sql`). */
export const alerts = serviceSchema.table(
  'alerts',
  {
    id: pg.uuid('id').notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
    type: pg.text('type').notNull(),
    domain: pg.text('domain').$type<'safety' | 'surveillance'>().notNull(),
    severity: pg
      .text('severity')
      .$type<'info' | 'warning' | 'critical'>()
      .notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    relatedMmsi: pg.integer('related_mmsi'),
    orgId: pg.uuid('org_id'),
    title: pg.text('title').notNull(),
    message: pg.text('message').notNull(),
    lat: pg.doublePrecision('lat'),
    lon: pg.doublePrecision('lon'),
    zoneId: pg.uuid('zone_id'),
    methodId: pg.text('method_id').notNull(),
    dedupKey: pg.text('dedup_key').notNull(),
    data: pg.jsonb('data').$type<Record<string, unknown>>().notNull(),
    source: pg.text('source').notNull(),
    status: pg
      .text('status')
      .$type<'open' | 'acknowledged' | 'resolved'>()
      .notNull()
      .default('open'),
    acknowledgedBy: pg.uuid('acknowledged_by'),
    acknowledgedAt: timestamptz('acknowledged_at'),
    resolvedBy: pg.uuid('resolved_by'),
    resolvedAt: timestamptz('resolved_at'),
    occurrences: pg.integer('occurrences').notNull().default(1),
    lastOccurredAt: timestamptz('last_occurred_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [pg.primaryKey({ columns: [table.id, table.occurredAt] })],
);

/** One channel of an alert rule (`alert_rules.channels`). */
export interface RuleChannelRecord {
  readonly type: NotificationChannel;
  readonly target: string;
}

/** Alert rules of an organization (`0001_init.sql`). */
export const alertRules = serviceSchema.table(
  'alert_rules',
  {
    id: pg.uuid('id').primaryKey(),
    orgId: pg.uuid('org_id').notNull(),
    createdBy: pg.uuid('created_by').notNull(),
    name: pg.text('name').notNull(),
    scope: pg.text('scope').$type<'org' | 'all'>().notNull().default('org'),
    types: pg.text('types').array().notNull().default([]),
    domains: pg
      .text('domains')
      .array()
      .$type<('safety' | 'surveillance')[]>()
      .notNull()
      .default([]),
    minSeverity: pg
      .text('min_severity')
      .$type<'info' | 'warning' | 'critical'>()
      .notNull()
      .default('info'),
    mmsi: pg.integer('mmsi').array().notNull().default([]),
    zoneIds: pg.uuid('zone_ids').array().notNull().default([]),
    channels: pg.jsonb('channels').$type<RuleChannelRecord[]>().notNull(),
    locale: pg.text('locale').$type<'id' | 'en'>().notNull().default('id'),
    quietMinutes: pg.integer('quiet_minutes').notNull().default(0),
    enabled: pg.boolean('enabled').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [pg.index('alert_rules_org_idx').on(table.orgId, table.createdAt)],
);

/** Delivery states (`deliveries.status`). */
export type DeliveryStatus =
  'pending' | 'sending' | 'queued' | 'sent' | 'failed';

/** Notifications of alerts through the channels of rules (`0001_init.sql`). */
export const deliveries = serviceSchema.table(
  'deliveries',
  {
    id: pg.uuid('id').primaryKey(),
    alertId: pg.uuid('alert_id').notNull(),
    ruleId: pg
      .uuid('rule_id')
      .notNull()
      .references(() => alertRules.id, { onDelete: 'cascade' }),
    channel: pg.text('channel').$type<NotificationChannel>().notNull(),
    target: pg.text('target').notNull(),
    severity: pg
      .text('severity')
      .$type<'info' | 'warning' | 'critical'>()
      .notNull(),
    status: pg
      .text('status')
      .$type<DeliveryStatus>()
      .notNull()
      .default('pending'),
    attempts: pg.integer('attempts').notNull().default(0),
    error: pg.text('error'),
    payload: pg.jsonb('payload').$type<Record<string, unknown>>().notNull(),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    leaseUntil: timestamptz('lease_until'),
    lastAttemptAt: timestamptz('last_attempt_at'),
    sentAt: timestamptz('sent_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    pg
      .index('deliveries_rule_alert_idx')
      .on(table.ruleId, table.alertId, table.createdAt),
    pg.index('deliveries_alert_idx').on(table.alertId),
  ],
);

/** E-mail states (`email_log.status`). */
export type EmailStatus = 'retrying' | 'sent' | 'failed';

/** Transactional e-mails, one row per request envelope (`0001_init.sql`). */
export const emailLog = serviceSchema.table(
  'email_log',
  {
    id: pg.uuid('id').primaryKey(),
    toAddress: pg.text('to_address').notNull(),
    template: pg.text('template').notNull(),
    locale: pg.text('locale').$type<'id' | 'en'>().notNull(),
    subject: pg.text('subject'),
    source: pg.text('source').notNull(),
    deliveryId: pg.uuid('delivery_id'),
    status: pg.text('status').$type<EmailStatus>().notNull(),
    attempts: pg.integer('attempts').notNull().default(0),
    error: pg.text('error'),
    messageId: pg.text('message_id'),
    sentAt: timestamptz('sent_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [pg.index('email_log_created_idx').on(table.createdAt)],
);
