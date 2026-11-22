import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import type { AlertRaisedV1 } from '@darmawanweb/ais-its-contracts/events';
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
} from './support/receivers.js';
import { startTestService, type TestService } from './support/test-service.js';

const WEBHOOK_SECRET = 'whsec-rest-secret-0123456789';

const AlertSchema = z.object({
  id: z.uuid(),
  mmsi: z.number(),
  relatedMmsi: z.number().nullable(),
  status: z.enum(['open', 'acknowledged', 'resolved']),
  acknowledgedBy: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  occurrences: z.number(),
  methodId: z.string(),
  domain: z.string(),
});
const AlertPageSchema = z.object({
  data: z.array(AlertSchema),
  page: z.object({ nextCursor: z.string().nullable(), limit: z.number() }),
});
const ProblemSchema = z.object({
  type: z.string(),
  status: z.number(),
  code: z.string(),
  errors: z
    .array(z.object({ field: z.string(), message: z.string() }))
    .optional(),
});
const RuleSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  scope: z.enum(['org', 'all']),
  name: z.string(),
  enabled: z.boolean(),
  locale: z.string(),
  channels: z.array(z.object({ type: z.string(), target: z.string() })),
});
const RulePageSchema = z.object({
  data: z.array(RuleSchema),
  meta: z.object({ page: z.number(), pageSize: z.number(), total: z.number() }),
});

describe('REST API and tenancy (spec §8.5, §13.9)', () => {
  const orgA = newId();
  const orgB = newId();
  let service: TestService;
  let webhook: FakeServer;
  let vesselA: number;
  let vesselB: number;
  let alertA: AlertRaisedV1;
  let alertB: AlertRaisedV1;
  let collision: AlertRaisedV1;

  async function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    claims: { roles: Role[]; orgId?: string | null; userId?: string },
    payload?: Record<string, unknown>,
  ) {
    return service.app.inject({
      method,
      url: `/api/v2${url}`,
      headers: await service.authorization(claims),
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function listAlerts(
    claims: { roles: Role[]; orgId?: string | null },
    query = '',
  ) {
    const response = await call('GET', `/alerts?limit=500${query}`, claims);
    expect(response.statusCode, response.body).toBe(200);
    return AlertPageSchema.parse(response.json());
  }

  const ids = (page: z.output<typeof AlertPageSchema>) =>
    page.data.map((alert) => alert.id);

  beforeAll(async () => {
    webhook = await startFakeServer(() => ({ status: 200 }));
    // No TELEGRAM_BOT_TOKEN: the Telegram channel is unavailable here.
    service = await startTestService({
      env: {
        WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
        WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
      },
    });
    vesselA = uniqueMmsi();
    vesselB = uniqueMmsi();
    await registerVessel(service, { mmsi: vesselA, orgId: orgA });
    await registerVessel(service, { mmsi: vesselB, orgId: orgB });
    alertA = alertRaised(vesselA, { dedupKey: `ews:${vesselA}:rest` });
    alertB = alertRaised(vesselB, {
      type: 'dark',
      domain: 'surveillance',
      dedupKey: `dark:${vesselB}`,
      methodId: 'dark.ais_gap',
      zoneId: null,
    });
    collision = alertRaised(vesselB, {
      type: 'collision',
      severity: 'critical',
      relatedMmsi: vesselA,
      dedupKey: `collision:${Math.min(vesselA, vesselB)}:${Math.max(vesselA, vesselB)}`,
      methodId: 'collision.cpa_tcpa',
      zoneId: null,
    });
    for (const alert of [alertA, alertB, collision]) {
      await raiseAlert(service, alert);
      await storedAlert(service, alert.dedupKey);
    }
  });

  afterAll(async () => {
    await service.app.close();
    await webhook.close();
  });

  describe('alerts', () => {
    it('shows other roles the alerts of their vessels, incl. as related vessel', async () => {
      const page = await listAlerts({ roles: ['viewer'], orgId: orgA });

      expect(ids(page)).toEqual(
        expect.arrayContaining([alertA.id, collision.id]),
      );
      expect(ids(page)).not.toContain(alertB.id);
      const ofB = await listAlerts({ roles: ['viewer'], orgId: orgB });
      expect(ids(ofB)).toEqual(
        expect.arrayContaining([alertB.id, collision.id]),
      );
      expect(ids(ofB)).not.toContain(alertA.id);
    });

    it('shows authority and super_admin every alert', async () => {
      for (const roles of [['authority'], ['super_admin']] as Role[][]) {
        const page = await listAlerts({ roles, orgId: newId() });
        expect(ids(page)).toEqual(
          expect.arrayContaining([alertA.id, alertB.id, collision.id]),
        );
      }
    });

    it('shows nothing without an active organization', async () => {
      expect(
        (await listAlerts({ roles: ['viewer'], orgId: null })).data,
      ).toEqual([]);
    });

    it('filters and pages newest first with a cursor', async () => {
      const claims = { roles: ['authority'] as Role[], orgId: newId() };
      const byVessel = await listAlerts(claims, `&mmsi=${vesselA}`);
      expect(new Set(ids(byVessel))).toEqual(
        new Set([alertA.id, collision.id]),
      );
      const surveillance = await listAlerts(
        claims,
        `&mmsi=${vesselB}&domain=surveillance`,
      );
      expect(ids(surveillance)).toEqual([alertB.id]);

      const first = await call(
        'GET',
        `/alerts?mmsi=${vesselA}&limit=1`,
        claims,
      );
      const firstPage = AlertPageSchema.parse(first.json());
      expect(firstPage.data).toHaveLength(1);
      expect(firstPage.page.nextCursor).not.toBeNull();
      const second = AlertPageSchema.parse(
        (
          await call(
            'GET',
            `/alerts?mmsi=${vesselA}&limit=1&cursor=${encodeURIComponent(firstPage.page.nextCursor ?? '')}`,
            claims,
          )
        ).json(),
      );
      expect(second.data).toHaveLength(1);
      expect(second.data[0]?.id).not.toBe(firstPage.data[0]?.id);
    });

    it('answers 404 for alerts of other tenants and 400 for bad queries', async () => {
      const response = await call('GET', `/alerts/${alertB.id}`, {
        roles: ['viewer'],
        orgId: orgA,
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(ProblemSchema.parse(response.json()).code).toBe('ALERT_NOT_FOUND');

      const own = await call('GET', `/alerts/${alertA.id}`, {
        roles: ['viewer'],
        orgId: orgA,
      });
      expect(AlertSchema.parse(own.json())).toMatchObject({
        id: alertA.id,
        methodId: 'ews.pipeline_distance_status',
      });

      const bad = await call('GET', '/alerts?severity=fatal', {
        roles: ['viewer'],
        orgId: orgA,
      });
      expect(bad.statusCode).toBe(400);
      expect(ProblemSchema.parse(bad.json()).code).toBe('VALIDATION_FAILED');
    });

    it('counts open alerts by severity, domain and type', async () => {
      const response = await call('GET', '/alerts/summary', {
        roles: ['viewer'],
        orgId: orgB,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        total: 2,
        bySeverity: { info: 0, warning: 1, critical: 1 },
        byDomain: { safety: 1, surveillance: 1 },
        byType: { dark: 1, collision: 1, ews: 0 },
      });
    });

    it('acknowledges and resolves with alert:ack, idempotently', async () => {
      const manager = {
        roles: ['fleet_manager'] as Role[],
        orgId: orgA,
        userId: newId(),
      };

      const viewer = await call('POST', `/alerts/${alertA.id}/ack`, {
        roles: ['viewer'],
        orgId: orgA,
      });
      expect(viewer.statusCode).toBe(403);
      const foreign = await call('POST', `/alerts/${alertB.id}/ack`, manager);
      expect(foreign.statusCode).toBe(404);

      const acknowledged = await call(
        'POST',
        `/alerts/${alertA.id}/ack`,
        manager,
      );
      expect(acknowledged.statusCode).toBe(200);
      expect(AlertSchema.parse(acknowledged.json())).toMatchObject({
        status: 'acknowledged',
        acknowledgedBy: manager.userId,
      });
      const again = await call('POST', `/alerts/${alertA.id}/ack`, {
        ...manager,
        userId: newId(),
      });
      expect(AlertSchema.parse(again.json()).acknowledgedBy).toBe(
        manager.userId,
      );

      const resolved = await call(
        'POST',
        `/alerts/${alertA.id}/resolve`,
        manager,
      );
      expect(AlertSchema.parse(resolved.json())).toMatchObject({
        status: 'resolved',
        resolvedBy: manager.userId,
      });
      const late = await call('POST', `/alerts/${alertA.id}/ack`, manager);
      expect(late.statusCode).toBe(409);
      expect(ProblemSchema.parse(late.json()).code).toBe(
        'ALERT_ALREADY_RESOLVED',
      );

      // A new occurrence after the resolution opens a new inbox alert.
      const recurrence = alertRaised(vesselA, { dedupKey: alertA.dedupKey });
      await raiseAlert(service, recurrence);
      const reopened = await storedAlert(
        service,
        alertA.dedupKey,
        (row) => row.id === recurrence.id,
      );
      expect(reopened).toMatchObject({ status: 'open', occurrences: 1 });
    });
  });

  describe('alert rules', () => {
    const managerA = { roles: ['fleet_manager'] as Role[], orgId: orgA };
    const rule = {
      name: 'Collisions to the ops room',
      types: ['collision'],
      minSeverity: 'warning',
      channels: [{ type: 'email', target: 'ops@example.com' }],
    };

    it('creates, reads, changes and deletes the rules of the own organization', async () => {
      const created = await call('POST', '/alert-rules', managerA, rule);
      expect(created.statusCode, created.body).toBe(201);
      const { id } = RuleSchema.parse(created.json());
      expect(RuleSchema.parse(created.json())).toMatchObject({
        orgId: orgA,
        scope: 'org',
        enabled: true,
        locale: 'id',
      });

      const changed = await call('PATCH', `/alert-rules/${id}`, managerA, {
        name: 'Collisions (paused)',
        enabled: false,
      });
      expect(RuleSchema.parse(changed.json())).toMatchObject({
        name: 'Collisions (paused)',
        enabled: false,
      });

      // Tenant-private: invisible to other organizations.
      const managerB = { roles: ['fleet_manager'] as Role[], orgId: orgB };
      expect(
        (await call('GET', `/alert-rules/${id}`, managerB)).statusCode,
      ).toBe(404);
      expect(
        (await call('PATCH', `/alert-rules/${id}`, managerB, { name: 'x' }))
          .statusCode,
      ).toBe(404);
      const listB = RulePageSchema.parse(
        (await call('GET', '/alert-rules', managerB)).json(),
      );
      expect(listB.data.map((item) => item.id)).not.toContain(id);
      const listAdmin = RulePageSchema.parse(
        (
          await call('GET', `/alert-rules?orgId=${orgA}`, {
            roles: ['super_admin'],
          })
        ).json(),
      );
      expect(listAdmin.data.map((item) => item.id)).toContain(id);

      expect(
        (await call('DELETE', `/alert-rules/${id}`, managerA)).statusCode,
      ).toBe(204);
      expect(
        (await call('GET', `/alert-rules/${id}`, managerA)).statusCode,
      ).toBe(404);
    });

    it('lets only authority principals watch every vessel', async () => {
      const denied = await call('POST', '/alert-rules', managerA, {
        ...rule,
        scope: 'all',
      });
      expect(denied.statusCode).toBe(403);
      expect(ProblemSchema.parse(denied.json()).code).toBe(
        'RULE_SCOPE_FORBIDDEN',
      );

      const authority = await call(
        'POST',
        '/alert-rules',
        { roles: ['authority'], orgId: newId() },
        { ...rule, enabled: false },
      );
      expect(RuleSchema.parse(authority.json()).scope).toBe('all');
    });

    it('derives the scope from the rule organization, not from a super_admin creator', async () => {
      const superAdmin = { roles: ['super_admin'] as Role[], orgId: newId() };
      // A rule a super_admin creates for a shipping company watches its fleet only.
      const forCompany = await call('POST', '/alert-rules', superAdmin, {
        ...rule,
        orgId: orgB,
        enabled: false,
      });
      expect(forCompany.statusCode, forCompany.body).toBe(201);
      expect(RuleSchema.parse(forCompany.json())).toMatchObject({
        orgId: orgB,
        scope: 'org',
      });
      const widened = await call('POST', '/alert-rules', superAdmin, {
        ...rule,
        orgId: orgB,
        scope: 'all',
      });
      expect(widened.statusCode).toBe(403);
      expect(ProblemSchema.parse(widened.json()).code).toBe(
        'RULE_SCOPE_FORBIDDEN',
      );
      const { id } = RuleSchema.parse(forCompany.json());
      const patched = await call(
        'PATCH',
        `/alert-rules/${id}`,
        { roles: ['org_admin'], orgId: orgB },
        { scope: 'all' },
      );
      expect(patched.statusCode).toBe(403);
    });

    it('lets only authority members change a rule that watches every vessel', async () => {
      const authorityOrg = newId();
      const created = await call(
        'POST',
        '/alert-rules',
        { roles: ['authority'], orgId: authorityOrg },
        { ...rule, enabled: false },
      );
      const { id, scope } = RuleSchema.parse(created.json());
      expect(scope).toBe('all');

      // Another member of the authority organization cannot redirect the feed.
      const redirected = await call(
        'PATCH',
        `/alert-rules/${id}`,
        { roles: ['org_admin'], orgId: authorityOrg },
        { channels: [{ type: 'webhook', target: `${webhook.url}/attacker` }] },
      );
      expect(redirected.statusCode).toBe(403);
      expect(ProblemSchema.parse(redirected.json()).code).toBe(
        'RULE_SCOPE_FORBIDDEN',
      );
      const stored = RuleSchema.parse(
        (
          await call('GET', `/alert-rules/${id}`, {
            roles: ['authority'],
            orgId: authorityOrg,
          })
        ).json(),
      );
      expect(stored.channels).toEqual(rule.channels);

      const renamed = await call(
        'PATCH',
        `/alert-rules/${id}`,
        { roles: ['authority'], orgId: authorityOrg },
        { name: 'Harbour master (renamed)' },
      );
      expect(renamed.statusCode, renamed.body).toBe(200);
    });

    it('refuses null fields in a PATCH with 400 VALIDATION_FAILED', async () => {
      const created = await call('POST', '/alert-rules', managerA, {
        ...rule,
        enabled: false,
      });
      const { id } = RuleSchema.parse(created.json());
      for (const field of [
        'name',
        'channels',
        'types',
        'enabled',
        'quietMinutes',
        'scope',
      ]) {
        const response = await call('PATCH', `/alert-rules/${id}`, managerA, {
          [field]: null,
        });
        expect(response.statusCode, `${field}: ${response.body}`).toBe(400);
        const problem = ProblemSchema.parse(response.json());
        expect(problem.code).toBe('VALIDATION_FAILED');
      }
      const unchanged = RuleSchema.parse(
        (await call('GET', `/alert-rules/${id}`, managerA)).json(),
      );
      expect(unchanged).toMatchObject({ name: rule.name, enabled: false });
    });

    it('requires alert_rule:write and an organization', async () => {
      expect(
        (await call('GET', '/alert-rules', { roles: ['viewer'], orgId: orgA }))
          .statusCode,
      ).toBe(403);
      const noOrg = await call(
        'POST',
        '/alert-rules',
        { roles: ['fleet_manager'], orgId: null },
        rule,
      );
      expect(noOrg.statusCode).toBe(403);
      expect(ProblemSchema.parse(noOrg.json()).code).toBe(
        'ORGANIZATION_REQUIRED',
      );
      const foreign = await call('POST', '/alert-rules', managerA, {
        ...rule,
        orgId: orgB,
      });
      expect(foreign.statusCode).toBe(403);
    });

    it('validates channels and refuses unconfigured ones', async () => {
      const invalid = await call('POST', '/alert-rules', managerA, {
        ...rule,
        channels: [
          { type: 'email', target: 'ops@example.com' },
          { type: 'email', target: 'not-an-address' },
        ],
      });
      expect(invalid.statusCode).toBe(400);
      expect(ProblemSchema.parse(invalid.json())).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [
          {
            field: 'channels.1.target',
            message: 'target must be an e-mail address',
          },
        ],
      });

      const telegram = await call('POST', '/alert-rules', managerA, {
        ...rule,
        channels: [{ type: 'telegram', target: '-100123' }],
      });
      expect(telegram.statusCode).toBe(422);
      expect(ProblemSchema.parse(telegram.json()).code).toBe(
        'CHANNEL_NOT_CONFIGURED',
      );

      const unknown = await call('POST', '/alert-rules', managerA, {
        ...rule,
        colour: 'red',
      });
      expect(unknown.statusCode).toBe(400);
    });
  });

  describe('test notifications', () => {
    it('posts a signed test webhook and queues a test e-mail', async () => {
      const claims = { roles: ['org_admin'] as Role[], orgId: orgA };
      const sent = await call('POST', '/notifications/test', claims, {
        channel: 'webhook',
        target: `${webhook.url}/test`,
        locale: 'en',
      });
      expect(sent.statusCode, sent.body).toBe(200);
      expect(sent.json()).toEqual({
        channel: 'webhook',
        target: `${webhook.url}/test`,
        status: 'sent',
        error: null,
      });
      const [request] = webhook.requests;
      expect(
        verifyWebhookSignature(
          WEBHOOK_SECRET,
          String(request?.headers['x-ais-its-timestamp']),
          request?.rawBody ?? '',
          String(request?.headers['x-ais-its-signature']),
        ),
      ).toBe(true);
      expect(JSON.parse(request?.rawBody ?? '{}')).toMatchObject({
        event: 'test',
        locale: 'en',
      });

      const address = `test-${newId()}@example.com`;
      const queued = await call('POST', '/notifications/test', claims, {
        channel: 'email',
        target: address,
      });
      expect(queued.json()).toMatchObject({ status: 'queued' });
      const mailpit = new MailpitClient(inject('infra').mailpitUrl);
      const [mail] = await waitFor(async () => {
        const messages = await mailpit.messagesTo(address);
        return messages.length > 0 ? messages : undefined;
      });
      expect(mail?.Subject).toBe('Notifikasi uji AIS Maritime Intelligence');
    });

    it('requires alert_rule:write', async () => {
      const response = await call(
        'POST',
        '/notifications/test',
        { roles: ['viewer'], orgId: orgA },
        { channel: 'email', target: 'ops@example.com' },
      );
      expect(response.statusCode).toBe(403);
    });
  });
});
