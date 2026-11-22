import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { verifyWebhookSignature } from '../src/domain/webhook-signature.js';
import {
  alertRaised,
  raiseAlert,
  registerVessel,
  storedAlert,
  uniqueMmsi,
} from './support/fixtures.js';
import {
  type FakeServer,
  MailpitClient,
  type SlowServer,
  startFakeServer,
  startSlowServer,
  TELEGRAM_OK,
  telegramMessages,
} from './support/receivers.js';
import { startTestService, type TestService } from './support/test-service.js';

const WEBHOOK_SECRET = 'whsec-integration-secret-0123456789';
const BOT_TOKEN = '123456:TEST-integration-token';

const DeliveryPageSchema = z.object({
  data: z.array(
    z.object({
      id: z.uuid(),
      alertId: z.uuid(),
      ruleId: z.uuid(),
      channel: z.enum(['email', 'telegram', 'webhook']),
      target: z.string(),
      status: z.string(),
      attempts: z.number(),
      error: z.string().nullable(),
    }),
  ),
  page: z.object({ nextCursor: z.string().nullable(), limit: z.number() }),
});
type DeliveryRow = z.output<typeof DeliveryPageSchema>['data'][number];

const WebhookBodySchema = z.object({
  deliveryId: z.uuid(),
  event: z.string(),
  rule: z.object({ id: z.uuid(), name: z.string() }),
  vessel: z.object({ mmsi: z.number(), name: z.string().nullable() }),
  alert: z.object({
    id: z.uuid(),
    severity: z.string(),
    occurrences: z.number(),
  }),
  text: z.string(),
});

describe('alert inbox and deliveries', () => {
  const orgA = newId();
  const mailbox = `ops-${newId()}@example.com`;
  let service: TestService;
  let webhook: FakeServer;
  let telegram: FakeServer;
  let mailpit: MailpitClient;
  let vessel: number;

  /** Deliveries of an alert as the organization's fleet manager sees them. */
  async function deliveriesOf(alertId: string): Promise<DeliveryRow[]> {
    const response = await service.app.inject({
      method: 'GET',
      url: `/api/v2/notifications/deliveries?alertId=${alertId}`,
      headers: await service.authorization({
        roles: ['fleet_manager'],
        orgId: orgA,
      }),
    });
    expect(response.statusCode).toBe(200);
    return DeliveryPageSchema.parse(response.json()).data;
  }

  async function createRule(
    claims: { roles: ('fleet_manager' | 'authority')[]; orgId: string },
    body: Record<string, unknown>,
  ): Promise<string> {
    const response = await service.app.inject({
      method: 'POST',
      url: '/api/v2/alert-rules',
      headers: await service.authorization(claims),
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return z.object({ id: z.uuid() }).parse(response.json()).id;
  }

  beforeAll(async () => {
    // The webhook fails once (HTTP 503) and then accepts: the delivery is retried.
    webhook = await startFakeServer((index) => ({
      status: index === 0 ? 503 : 204,
    }));
    telegram = await startFakeServer((_, request) =>
      request.rawBody.includes('"chat_id":"-400"')
        ? {
            status: 400,
            body: { ok: false, description: 'Bad Request: chat not found' },
          }
        : TELEGRAM_OK,
    );
    mailpit = new MailpitClient(inject('infra').mailpitUrl);
    service = await startTestService({
      env: {
        WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
        WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_API_BASE: telegram.url,
        DELIVERY_RETRY_BASE_MS: '200',
        DELIVERY_POLL_INTERVAL_MS: '100',
        // A total deadline per webhook attempt (slow receivers below).
        WEBHOOK_TIMEOUT_MS: '3000',
      },
    });
    vessel = uniqueMmsi();
    await registerVessel(service, {
      mmsi: vessel,
      orgId: orgA,
      name: 'KM Bahari Satu',
    });
    await createRule(
      { roles: ['fleet_manager'], orgId: orgA },
      {
        name: 'Pipeline warnings',
        types: ['ews'],
        minSeverity: 'warning',
        quietMinutes: 60,
        channels: [
          { type: 'email', target: mailbox },
          { type: 'telegram', target: '-100123' },
          { type: 'webhook', target: `${webhook.url}/hook` },
        ],
      },
    );
  });

  afterAll(async () => {
    await service.app.close();
    await webhook.close();
    await telegram.close();
  });

  it('stores an alert and delivers it by e-mail, Telegram and a signed webhook', async () => {
    const alert = alertRaised(vessel);
    await raiseAlert(service, alert);

    const stored = await storedAlert(service, alert.dedupKey);
    expect(stored).toMatchObject({
      id: alert.id,
      status: 'open',
      occurrences: 1,
      orgId: orgA,
    });

    const deliveries = await waitFor(
      async () => {
        const rows = await deliveriesOf(alert.id);
        return rows.length === 3 && rows.every((row) => row.status === 'sent')
          ? rows
          : undefined;
      },
      { timeoutMs: 30_000 },
    );
    const byChannel = new Map(deliveries.map((row) => [row.channel, row]));
    // The webhook answered 503 first: one retry after the backoff.
    expect(byChannel.get('webhook')?.attempts).toBe(2);
    expect(byChannel.get('telegram')?.attempts).toBe(1);

    // E-mail: rendered in the rule's language (default id) and sent over SMTP.
    const [mail] = await waitFor(async () => {
      const messages = await mailpit.messagesTo(mailbox);
      return messages.length > 0 ? messages : undefined;
    });
    expect(mail?.Subject).toBe(
      `[Peringatan] Peringatan dini pipa bawah laut — KM Bahari Satu (${vessel})`,
    );
    expect(mail?.From.Address).toBe('no-reply@ais-its.local');
    expect(mail?.Text).toContain(
      `http://localhost:8000/alerts?alert=${alert.id}`,
    );

    // Telegram: Bot API sendMessage with the configured token, HTML parse mode.
    const [message] = telegramMessages(telegram);
    expect(message).toMatchObject({
      token: BOT_TOKEN,
      chatId: '-100123',
      parseMode: 'HTML',
    });
    expect(message?.text).toContain('KM Bahari Satu');

    // Webhook: both attempts signed over "<timestamp>.<raw body>".
    expect(webhook.requests).toHaveLength(2);
    for (const request of webhook.requests) {
      const timestamp = String(request.headers['x-ais-its-timestamp']);
      const signature = String(request.headers['x-ais-its-signature']);
      expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(
        verifyWebhookSignature(
          WEBHOOK_SECRET,
          timestamp,
          request.rawBody,
          signature,
        ),
      ).toBe(true);
      expect(request.headers['x-ais-its-delivery']).toBe(
        byChannel.get('webhook')?.id,
      );
    }
    const body = WebhookBodySchema.parse(
      JSON.parse(webhook.requests[1]?.rawBody ?? ''),
    );
    expect(body).toMatchObject({
      event: 'alert.raised',
      vessel: { mmsi: vessel, name: 'KM Bahari Satu' },
      alert: { id: alert.id, severity: 'warning', occurrences: 1 },
    });
  });

  it('merges occurrences of a dedup key; the quiet period holds repeats but not escalations', async () => {
    const first = alertRaised(vessel, { dedupKey: `ews:${vessel}:merge` });
    await raiseAlert(service, first);
    await storedAlert(service, first.dedupKey);
    await waitFor(async () => (await deliveriesOf(first.id)).length === 3);

    // A repeat within the quiet period: merged, not notified again.
    await raiseAlert(
      service,
      alertRaised(vessel, { dedupKey: first.dedupKey }),
    );
    const merged = await storedAlert(
      service,
      first.dedupKey,
      (row) => row.occurrences === 2,
    );
    expect(merged).toMatchObject({ id: first.id, severity: 'warning' });
    expect(await deliveriesOf(first.id)).toHaveLength(3);

    // An escalation notifies at once.
    await raiseAlert(
      service,
      alertRaised(vessel, {
        dedupKey: first.dedupKey,
        severity: 'critical',
        title: 'Anchored 420 m from the pipeline',
      }),
    );
    const escalated = await storedAlert(
      service,
      first.dedupKey,
      (row) => row.occurrences === 3,
    );
    expect(escalated).toMatchObject({
      id: first.id,
      severity: 'critical',
      title: 'Anchored 420 m from the pipeline',
    });
    const deliveries = await waitFor(async () => {
      const rows = await deliveriesOf(first.id);
      return rows.length === 6 ? rows : undefined;
    });
    expect(deliveries.filter((row) => row.channel === 'webhook')).toHaveLength(
      2,
    );
    const lastWebhook = await waitFor(() =>
      webhook.requests
        .map((request) => WebhookBodySchema.parse(JSON.parse(request.rawBody)))
        .find(
          (sent) =>
            sent.alert.id === first.id && sent.event === 'alert.escalated',
        ),
    );
    expect(lastWebhook.alert).toMatchObject({
      severity: 'critical',
      occurrences: 3,
    });
  });

  it('ignores a redelivered envelope (idempotent consumer)', async () => {
    const alert = alertRaised(vessel, {
      dedupKey: `ews:${vessel}:redelivered`,
    });
    await raiseAlert(service, alert);
    await storedAlert(service, alert.dedupKey);
    // The same envelope again (outside JetStream's dedup: a new message id).
    await service.publisher.publishEvent(EVENT_TYPES.ALERT_RAISED, alert, {
      id: alert.id,
      msgId: newId(),
    });
    const marker = alertRaised(vessel, { dedupKey: `ews:${vessel}:marker` });
    await raiseAlert(service, marker);
    await storedAlert(service, marker.dedupKey);

    expect(await storedAlert(service, alert.dedupKey)).toMatchObject({
      occurrences: 1,
    });
  });

  it('matches authority rules for every vessel and never rules of other organizations', async () => {
    const otherOrgRule = await createRule(
      { roles: ['fleet_manager'], orgId: newId() },
      { name: 'Other fleet', channels: [{ type: 'telegram', target: '-200' }] },
    );
    const authorityOrg = newId();
    const authorityRule = await createRule(
      { roles: ['authority'], orgId: authorityOrg },
      {
        name: 'Harbour master',
        domains: ['surveillance'],
        channels: [
          { type: 'telegram', target: '-300' },
          { type: 'telegram', target: '-400' },
        ],
      },
    );
    try {
      const alert = alertRaised(vessel, {
        type: 'geofence',
        domain: 'surveillance',
        dedupKey: `geofence:${vessel}:zone`,
        methodId: 'geo.geofence_enter',
      });
      await raiseAlert(service, alert);
      await storedAlert(service, alert.dedupKey);

      const rows = await waitFor(async () => {
        const { rows: found } = await service.pool.query<{
          rule_id: string;
          target: string;
          status: string;
          attempts: number;
          error: string | null;
        }>(
          'SELECT rule_id, target, status, attempts, error FROM deliveries WHERE alert_id = $1',
          [alert.id],
        );
        return found.length === 2 &&
          found.every((row) => row.status === 'sent' || row.status === 'failed')
          ? found
          : undefined;
      });
      expect(rows.every((row) => row.rule_id === authorityRule)).toBe(true);
      expect(rows.some((row) => row.rule_id === otherOrgRule)).toBe(false);
      // The Bot API refused chat -400 (HTTP 400): permanent, not retried.
      expect(rows.find((row) => row.target === '-400')).toMatchObject({
        status: 'failed',
        attempts: 1,
        error:
          'Telegram refused the message (400: Bad Request: chat not found)',
      });
      expect(rows.find((row) => row.target === '-300')?.status).toBe('sent');
    } finally {
      await service.pool.query(
        'UPDATE alert_rules SET enabled = false WHERE id = $1',
        [authorityRule],
      );
    }
  });
  it('merges into an unresolved alert whose chunk is compressed, and resolves it', async () => {
    const longAgo = new Date(Date.now() - 120 * 86_400_000);
    const first = alertRaised(vessel, {
      dedupKey: `ews:${vessel}:compressed`,
      occurredAt: longAgo.toISOString(),
    });
    await raiseAlert(service, first);
    await storedAlert(service, first.dedupKey);
    await service.pool.query(
      `SELECT compress_chunk(c, if_not_compressed => true)
         FROM show_chunks('alerts', older_than => interval '90 days') c`,
    );
    const { rows: chunks } = await service.pool.query<{
      is_compressed: boolean;
    }>(
      `SELECT is_compressed FROM timescaledb_information.chunks
        WHERE hypertable_name = 'alerts'
          AND $1::timestamptz >= range_start AND $1::timestamptz < range_end`,
      [longAgo],
    );
    expect(chunks).toEqual([{ is_compressed: true }]);

    // Locking compressed tuples is not supported: the merge must not need it.
    await raiseAlert(
      service,
      alertRaised(vessel, {
        dedupKey: first.dedupKey,
        severity: 'critical',
        title: 'Anchored 420 m from the pipeline',
      }),
    );
    const merged = await storedAlert(
      service,
      first.dedupKey,
      (row) => row.occurrences === 2,
    );
    expect(merged).toMatchObject({
      id: first.id,
      severity: 'critical',
      status: 'open',
      title: 'Anchored 420 m from the pipeline',
    });
    // The escalation is notified on every channel of the rule.
    await waitFor(async () => (await deliveriesOf(first.id)).length === 6);

    const resolved = await service.app.inject({
      method: 'POST',
      url: `/api/v2/alerts/${first.id}/resolve`,
      headers: await service.authorization({
        roles: ['fleet_manager'],
        orgId: orgA,
      }),
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    const again = alertRaised(vessel, { dedupKey: first.dedupKey });
    await raiseAlert(service, again);
    expect(
      await storedAlert(service, first.dedupKey, (row) => row.id === again.id),
    ).toMatchObject({ status: 'open', occurrences: 1 });
  });

  it('applies an occurrence again when its alert is resolved during the merge', async () => {
    const first = alertRaised(vessel, { dedupKey: `ews:${vessel}:race` });
    await raiseAlert(service, first);
    await storedAlert(service, first.dedupKey);
    const second = alertRaised(vessel, { dedupKey: first.dedupKey });

    const client = await service.pool.connect();
    try {
      // A resolve as POST /alerts/:id/resolve writes it, not committed yet.
      await client.query('BEGIN');
      await client.query(
        `UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = $1`,
        [first.id],
      );
      await client.query('DELETE FROM open_alerts WHERE dedup_key = $1', [
        first.dedupKey,
      ]);
      await raiseAlert(service, second);
      // The merge read the open alert and waits for the resolve's row lock.
      await waitFor(async () => {
        const { rowCount } = await service.pool.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE 'update "notify"."alerts"%'`,
        );
        return (rowCount ?? 0) > 0;
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // The status changed under the merge: the occurrence starts a new alert.
    expect(
      await storedAlert(service, first.dedupKey, (row) => row.id === second.id),
    ).toMatchObject({ status: 'open', occurrences: 1 });
    const { rows } = await service.pool.query<{
      status: string;
      occurrences: number;
    }>('SELECT status, occurrences FROM alerts WHERE id = $1', [first.id]);
    expect(rows).toEqual([{ status: 'resolved', occurrences: 1 }]);
  });

  it('keeps delivering to other tenants while webhook receivers are slow', async () => {
    const stalling: SlowServer = await startSlowServer('stall');
    const dripping: SlowServer = await startSlowServer('drip');
    const orgC = newId();
    const orgD = newId();
    const vesselC = uniqueMmsi();
    const vesselD = uniqueMmsi();
    try {
      await registerVessel(service, { mmsi: vesselC, orgId: orgC });
      await registerVessel(service, { mmsi: vesselD, orgId: orgD });
      await createRule(
        { roles: ['fleet_manager'], orgId: orgC },
        {
          name: 'Slow receivers',
          channels: [
            { type: 'webhook', target: `${stalling.url}/hook` },
            { type: 'webhook', target: `${dripping.url}/hook` },
          ],
        },
      );
      await createRule(
        { roles: ['fleet_manager'], orgId: orgD },
        {
          name: 'Normal receiver',
          channels: [{ type: 'webhook', target: `${webhook.url}/org-d` }],
        },
      );
      const statusOf = async (alertId: string) => {
        const { rows } = await service.pool.query<{
          target: string;
          status: string;
          attempts: number;
          error: string | null;
        }>(
          'SELECT target, status, attempts, error FROM deliveries WHERE alert_id = $1',
          [alertId],
        );
        return rows;
      };

      const alertC = alertRaised(vesselC, { dedupKey: `ews:${vesselC}:slow` });
      await raiseAlert(service, alertC);
      await waitFor(() => stalling.received() === 1);

      // Org D is served while org C's stalled attempt holds its slot.
      const alertD = alertRaised(vesselD, { dedupKey: `ews:${vesselD}:slow` });
      await raiseAlert(service, alertD);
      await waitFor(async () => {
        const rows = await statusOf(alertD.id);
        return rows.length === 1 && rows[0]?.status === 'sent';
      });
      const during = await statusOf(alertC.id);
      expect(
        during.find((row) => row.target.startsWith(stalling.url))?.status,
      ).toBe('sending');
      // 200 at once: sent, and its dripping body is not waited for.
      await waitFor(async () =>
        (await statusOf(alertC.id)).some(
          (row) => row.target.startsWith(dripping.url) && row.status === 'sent',
        ),
      );
      await waitFor(() => dripping.connectionLifetimesMs.length > 0);
      expect(dripping.connectionLifetimesMs[0]).toBeLessThan(2_000);

      // The stalled attempt ends at its deadline and is scheduled again.
      const timedOut = await waitFor(
        async () =>
          (await statusOf(alertC.id)).find(
            (entry) =>
              entry.target.startsWith(stalling.url) &&
              entry.error === 'Webhook unreachable: ETIMEDOUT',
          ),
        { timeoutMs: 15_000 },
      );
      expect(timedOut.status).not.toBe('sent');
    } finally {
      await service.pool.query(
        'UPDATE alert_rules SET enabled = false WHERE org_id = ANY($1::uuid[])',
        [[orgC, orgD]],
      );
      await stalling.close();
      await dripping.close();
    }
  });
});
