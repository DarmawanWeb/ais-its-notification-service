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
  startFakeServer,
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
});
