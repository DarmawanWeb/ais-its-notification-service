import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  type ReceivedRequest,
  startFakeServer,
} from './support/receivers.js';
import { startTestService, type TestService } from './support/test-service.js';

const DEPLOYMENT_SECRET = 'whsec-deployment-secret-0123456789';

const ChannelSchema = z.object({
  type: z.string(),
  target: z.string(),
  keyId: z.uuid().nullable(),
  signingSecret: z.string().nullable(),
});
const RuleSchema = z.object({ id: z.uuid(), channels: z.array(ChannelSchema) });
const SummarySchema = z.object({
  sent: z.number(),
  failed: z.number(),
  pending: z.number(),
  queued: z.number(),
  total: z.number(),
  lastDeliveredAt: z.string().nullable(),
  successRate: z.number().nullable(),
});
const ProblemSchema = z.object({ status: z.number(), code: z.string() });

/** Per-channel webhook signing keys and the delivery summary. */
describe('webhook signing keys and delivery statistics', () => {
  const org = newId();
  const manager = { roles: ['fleet_manager'] as Role[], orgId: org };
  let service: TestService;
  let receiver: FakeServer;
  let vessel: number;

  async function call(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    claims: { roles: Role[]; orgId?: string | null },
    payload?: Record<string, unknown>,
  ) {
    return service.app.inject({
      method,
      url: `/api/v2${url}`,
      headers: await service.authorization(claims),
      ...(payload === undefined ? {} : { payload }),
    });
  }

  const hook = (name: string) => `${receiver.url}/${name}`;

  /** The webhook requests received at `path`. */
  function requestsTo(path: string): ReceivedRequest[] {
    return receiver.requests.filter((request) => request.path === path);
  }

  function signedWith(request: ReceivedRequest | undefined, secret: string) {
    return verifyWebhookSignature(
      secret,
      String(request?.headers['x-ais-its-timestamp']),
      request?.rawBody ?? '',
      String(request?.headers['x-ais-its-signature']),
    );
  }

  beforeAll(async () => {
    receiver = await startFakeServer(() => ({ status: 204 }));
    service = await startTestService({
      env: {
        WEBHOOK_SIGNING_SECRET: DEPLOYMENT_SECRET,
        WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
        DELIVERY_POLL_INTERVAL_MS: '100',
      },
    });
    vessel = uniqueMmsi();
    await registerVessel(service, { mmsi: vessel, orgId: org });
  });

  afterAll(async () => {
    await service.app.close();
    await receiver.close();
  });

  it('gives every webhook channel its own key, shown once; a PATCH keeps, adds and drops keys', async () => {
    const created = await call('POST', '/alert-rules', manager, {
      name: 'Keys',
      types: ['keys_only'],
      channels: [
        { type: 'email', target: 'ops@example.com' },
        { type: 'webhook', target: hook('a') },
        { type: 'webhook', target: hook('b') },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    const rule = RuleSchema.parse(created.json());
    const [email, a, b] = rule.channels;
    expect(email).toMatchObject({ keyId: null, signingSecret: null });
    expect(a?.signingSecret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(b?.signingSecret).toMatch(/^whsec_/);
    expect(a?.keyId).not.toBe(b?.keyId);

    // Never shown again.
    const read = RuleSchema.parse(
      (await call('GET', `/alert-rules/${rule.id}`, manager)).json(),
    );
    expect(read.channels.map((channel) => channel.signingSecret)).toEqual([
      null,
      null,
      null,
    ]);
    expect(read.channels[1]?.keyId).toBe(a?.keyId);

    const patched = await call('PATCH', `/alert-rules/${rule.id}`, manager, {
      channels: [
        { type: 'webhook', target: hook('a') },
        { type: 'webhook', target: hook('c') },
      ],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const [keptA, addedC] = RuleSchema.parse(patched.json()).channels;
    expect(keptA).toMatchObject({ keyId: a?.keyId, signingSecret: null });
    expect(addedC?.keyId).not.toBeNull();
    expect(addedC?.signingSecret).toMatch(/^whsec_/);
    const { rows } = await service.pool.query<{ target: string }>(
      'SELECT target FROM webhook_keys WHERE rule_id = $1 ORDER BY target',
      [rule.id],
    );
    expect(rows.map((row) => row.target)).toEqual([hook('a'), hook('c')]);
  });

  it('rotates the secret of a webhook channel and signs deliveries with the new key', async () => {
    const created = RuleSchema.parse(
      (
        await call('POST', '/alert-rules', manager, {
          name: 'Rotated',
          types: ['ews'],
          channels: [
            { type: 'email', target: 'ops@example.com' },
            { type: 'webhook', target: hook('rotated') },
          ],
        })
      ).json(),
    );
    const rotated = await call(
      'POST',
      `/alert-rules/${created.id}/channels/1/rotate-secret`,
      manager,
    );
    expect(rotated.statusCode, rotated.body).toBe(200);
    const channel = RuleSchema.parse(rotated.json()).channels[1];
    expect(channel?.keyId).not.toBe(created.channels[1]?.keyId);
    const secret = z.string().parse(channel?.signingSecret);

    const alert = alertRaised(vessel, { dedupKey: `ews:${vessel}:rotated` });
    await raiseAlert(service, alert);
    const [request] = await waitFor(() => {
      const received = requestsTo('/rotated');
      return received.length > 0 ? received : undefined;
    });
    expect(request?.headers['x-ais-its-key-id']).toBe(channel?.keyId);
    expect(signedWith(request, secret)).toBe(true);
    expect(signedWith(request, created.channels[1]?.signingSecret ?? '')).toBe(
      false,
    );

    for (const [url, claims, status, code] of [
      [
        `/alert-rules/${created.id}/channels/5/rotate-secret`,
        manager,
        404,
        'RULE_CHANNEL_NOT_FOUND',
      ],
      [
        `/alert-rules/${created.id}/channels/0/rotate-secret`,
        manager,
        422,
        'RULE_CHANNEL_NOT_WEBHOOK',
      ],
      [
        `/alert-rules/${created.id}/channels/10/rotate-secret`,
        manager,
        400,
        'VALIDATION_FAILED',
      ],
      [
        `/alert-rules/${created.id}/channels/1/rotate-secret`,
        { roles: ['fleet_manager'] as Role[], orgId: newId() },
        404,
        'ALERT_RULE_NOT_FOUND',
      ],
      [
        `/alert-rules/${created.id}/channels/1/rotate-secret`,
        { roles: ['viewer'] as Role[], orgId: org },
        403,
        'FORBIDDEN',
      ],
    ] as const) {
      const response = await call('POST', url, claims);
      expect(response.statusCode, url).toBe(status);
      expect(ProblemSchema.parse(response.json()).code).toBe(code);
    }
  });

  it('signs a channel from before 0.2.0 with the deployment secret until its secret is rotated', async () => {
    const ruleId = newId();
    await service.pool.query(
      `INSERT INTO alert_rules (id, org_id, created_by, name, types, channels)
       VALUES ($1, $2, $3, 'Legacy', ARRAY['dark'], $4::jsonb)`,
      [
        ruleId,
        org,
        newId(),
        JSON.stringify([{ type: 'webhook', target: hook('legacy') }]),
      ],
    );
    const legacy = RuleSchema.parse(
      (await call('GET', `/alert-rules/${ruleId}`, manager)).json(),
    );
    expect(legacy.channels[0]).toMatchObject({ keyId: null });

    const dark = (key: string) =>
      alertRaised(vessel, {
        type: 'dark',
        domain: 'surveillance',
        dedupKey: `dark:${vessel}:${key}`,
        methodId: 'dark.ais_gap',
        zoneId: null,
      });
    await raiseAlert(service, dark('before'));
    const [before] = await waitFor(() => {
      const received = requestsTo('/legacy');
      return received.length > 0 ? received : undefined;
    });
    expect(before?.headers['x-ais-its-key-id']).toBe('deployment');
    expect(signedWith(before, DEPLOYMENT_SECRET)).toBe(true);

    // A test to the channel's target is signed like its deliveries.
    const test = await call('POST', '/notifications/test', manager, {
      channel: 'webhook',
      target: hook('legacy'),
    });
    expect(test.json()).toMatchObject({ status: 'sent', keyId: 'deployment' });

    const rotated = RuleSchema.parse(
      (
        await call(
          'POST',
          `/alert-rules/${ruleId}/channels/0/rotate-secret`,
          manager,
        )
      ).json(),
    ).channels[0];
    await raiseAlert(service, dark('after'));
    const after = await waitFor(() => {
      const received = requestsTo('/legacy');
      return received.length > 2 ? received.at(-1) : undefined;
    });
    expect(after.headers['x-ais-its-key-id']).toBe(rotated?.keyId);
    expect(signedWith(after, z.string().parse(rotated?.signingSecret))).toBe(
      true,
    );
  });

  it("summarizes the deliveries of the organization's rules", async () => {
    const summary = await waitFor(async () => {
      const response = await call(
        'GET',
        '/notifications/deliveries/summary',
        manager,
      );
      expect(response.statusCode, response.body).toBe(200);
      const parsed = SummarySchema.parse(response.json());
      // E-mails of the rules above are queued, webhooks sent.
      return parsed.sent >= 3 ? parsed : undefined;
    });
    expect(summary.failed).toBe(0);
    expect(summary.successRate).toBe(1);
    expect(summary.total).toBe(
      summary.sent + summary.failed + summary.pending + summary.queued,
    );
    expect(summary.lastDeliveredAt).not.toBeNull();

    const other = SummarySchema.parse(
      (
        await call('GET', '/notifications/deliveries/summary', {
          roles: ['fleet_manager'],
          orgId: newId(),
        })
      ).json(),
    );
    expect(other).toMatchObject({
      total: 0,
      successRate: null,
      lastDeliveredAt: null,
    });

    const empty = SummarySchema.parse(
      (
        await call(
          'GET',
          `/notifications/deliveries/summary?from=2020-01-01T00:00:00Z&to=2020-02-01T00:00:00Z`,
          manager,
        )
      ).json(),
    );
    expect(empty.total).toBe(0);

    const reversed = await call(
      'GET',
      '/notifications/deliveries/summary?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      manager,
    );
    expect(reversed.statusCode).toBe(400);
    const viewer = await call('GET', '/notifications/deliveries/summary', {
      roles: ['viewer'],
      orgId: org,
    });
    expect(viewer.statusCode).toBe(403);
    await storedAlert(service, `ews:${vessel}:rotated`);
  });
});
