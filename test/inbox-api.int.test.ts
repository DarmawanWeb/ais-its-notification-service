import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  alertRaised,
  raiseAlert,
  registerVessel,
  storedAlert,
  uniqueMmsi,
} from './support/fixtures.js';
import { startTestService, type TestService } from './support/test-service.js';

const OccurrencePageSchema = z.object({
  data: z.array(
    z.object({
      eventId: z.uuid(),
      occurredAt: z.string(),
      outcome: z.enum(['raised', 'merged', 'escalated']),
      severity: z.string(),
      title: z.string(),
      messageKey: z.string().nullable(),
      messageParams: z.record(z.string(), z.unknown()).nullable(),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  page: z.object({ nextCursor: z.string().nullable(), limit: z.number() }),
});
const UnreadSchema = z.object({
  unread: z.number(),
  readUpTo: z.string().nullable(),
});
const SeriesSchema = z.object({
  from: z.string(),
  to: z.string(),
  bucket: z.enum(['1h', '1d']),
  groupBy: z.string(),
  timeZone: z.string(),
  keys: z.array(z.string()),
  buckets: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      total: z.number(),
      counts: z.record(z.string(), z.number()),
    }),
  ),
});
const ProblemSchema = z.object({ status: z.number(), code: z.string() });

const HOUR = 3_600_000;

/** Occurrence history, read marks, time series and the CSV export of the inbox. */
describe('alert inbox API (web app gaps)', () => {
  const orgA = newId();
  const orgB = newId();
  let service: TestService;
  let vesselA: number;
  let vesselB: number;

  async function call(
    method: 'GET' | 'POST',
    url: string,
    claims: { roles: Role[]; orgId?: string | null; userId?: string },
    options: {
      payload?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    return service.app.inject({
      method,
      url: `/api/v2${url}`,
      headers: { ...(await service.authorization(claims)), ...options.headers },
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
  }

  beforeAll(async () => {
    service = await startTestService();
    vesselA = uniqueMmsi();
    vesselB = uniqueMmsi();
    await registerVessel(service, { mmsi: vesselA, orgId: orgA });
    await registerVessel(service, { mmsi: vesselB, orgId: orgB });
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('lists the occurrences of an alert newest first, with their own severity and texts', async () => {
    const start = Date.now() - 3 * HOUR;
    const first = alertRaised(vesselA, {
      dedupKey: `ews:${vesselA}:history`,
      occurredAt: new Date(start).toISOString(),
      data: {
        distanceM: 1_200,
        messageKey: 'safety.ews.anchored_near_pipeline',
        messageParams: { distanceM: 1_200 },
      },
    });
    const escalation = alertRaised(vesselA, {
      dedupKey: first.dedupKey,
      severity: 'critical',
      occurredAt: new Date(start + HOUR).toISOString(),
      data: { distanceM: 400, messageKey: 'Not A Key', messageParams: {} },
    });
    const repeat = alertRaised(vesselA, {
      dedupKey: first.dedupKey,
      occurredAt: new Date(start + 2 * HOUR).toISOString(),
    });
    for (const alert of [first, escalation, repeat]) {
      await raiseAlert(service, alert);
      await storedAlert(service, first.dedupKey, (row) =>
        alert === first ? true : row.occurrences >= (alert === repeat ? 3 : 2),
      );
    }

    const owner = { roles: ['viewer'] as Role[], orgId: orgA };
    const page1 = await call(
      'GET',
      `/alerts/${first.id}/occurrences?limit=2`,
      owner,
    );
    expect(page1.statusCode, page1.body).toBe(200);
    const one = OccurrencePageSchema.parse(page1.json());
    expect(
      one.data.map((row) => [row.eventId, row.outcome, row.severity]),
    ).toEqual([
      [repeat.id, 'merged', 'warning'],
      [escalation.id, 'escalated', 'critical'],
    ]);
    // An invalid key in the data: no localizable text (data unchanged).
    expect(one.data[1]).toMatchObject({
      messageKey: null,
      messageParams: null,
      data: { distanceM: 400, messageKey: 'Not A Key' },
    });
    const cursor = z.string().parse(one.page.nextCursor);
    const page2 = await call(
      'GET',
      `/alerts/${first.id}/occurrences?limit=2&cursor=${cursor}`,
      owner,
    );
    const two = OccurrencePageSchema.parse(page2.json());
    expect(two.data).toEqual([
      expect.objectContaining({
        eventId: first.id,
        outcome: 'raised',
        messageKey: 'safety.ews.anchored_near_pipeline',
        messageParams: { distanceM: 1_200 },
      }),
    ]);
    expect(two.page.nextCursor).toBeNull();

    // Tenancy as GET /alerts/:id: 404 for other organizations.
    const other = await call('GET', `/alerts/${first.id}/occurrences`, {
      roles: ['viewer'],
      orgId: orgB,
    });
    expect(other.statusCode).toBe(404);
    expect(ProblemSchema.parse(other.json()).code).toBe('ALERT_NOT_FOUND');
  });

  it('counts unread open alerts per user and organization from a read mark that never moves back', async () => {
    const user = { roles: ['viewer'] as Role[], orgId: orgB, userId: newId() };
    const colleague = { ...user, userId: newId() };
    const initial = UnreadSchema.parse(
      (await call('GET', '/alerts/unread-count', user)).json(),
    );
    expect(initial.readUpTo).toBeNull();

    const raised = alertRaised(vesselB, { dedupKey: `ews:${vesselB}:unread` });
    await raiseAlert(service, raised);
    await storedAlert(service, raised.dedupKey);
    const before = UnreadSchema.parse(
      (await call('GET', '/alerts/unread-count', user)).json(),
    );
    expect(before.unread).toBe(initial.unread + 1);

    // Bodiless, with Content-Type: application/json (kit 0.3): everything read now.
    const read = await call('POST', '/alerts/read', user, {
      headers: { 'content-type': 'application/json' },
    });
    expect(read.statusCode, read.body).toBe(200);
    const marked = UnreadSchema.parse(read.json());
    expect(marked.unread).toBe(0);
    expect(marked.readUpTo).not.toBeNull();

    // Older marks do not move it back; other users keep their own state.
    const back = await call('POST', '/alerts/read', user, {
      payload: { upTo: '2020-01-01T00:00:00Z' },
    });
    expect(UnreadSchema.parse(back.json())).toEqual(marked);
    expect(
      UnreadSchema.parse(
        (await call('GET', '/alerts/unread-count', colleague)).json(),
      ).unread,
    ).toBe(before.unread);

    // A new occurrence after the mark is unread again.
    await raiseAlert(
      service,
      alertRaised(vesselB, { dedupKey: raised.dedupKey, severity: 'critical' }),
    );
    await storedAlert(service, raised.dedupKey, (row) => row.occurrences === 2);
    expect(
      UnreadSchema.parse(
        (await call('GET', '/alerts/unread-count', user)).json(),
      ).unread,
    ).toBe(1);

    for (const payload of [{ upTo: 'yesterday' }, { until: 'now' }]) {
      const invalid = await call('POST', '/alerts/read', user, { payload });
      expect(invalid.statusCode).toBe(400);
      expect(ProblemSchema.parse(invalid.json()).code).toBe(
        'VALIDATION_FAILED',
      );
    }
  });

  it('counts alerts per local day by severity with empty buckets', async () => {
    const day = Date.UTC(2026, 9, 10, 17, 30); // 00:30 WIB on 11 October
    for (const [offset, severity] of [
      [0, 'warning'],
      [HOUR, 'critical'],
      [26 * HOUR, 'warning'],
    ] as const) {
      const alert = alertRaised(vesselA, {
        dedupKey: `ews:${vesselA}:series:${newId()}`,
        severity,
        occurredAt: new Date(day + offset).toISOString(),
      });
      await raiseAlert(service, alert);
      await storedAlert(service, alert.dedupKey);
    }
    const response = await call(
      'GET',
      '/alerts/stats/series?from=2026-10-10T17:00:00Z&to=2026-10-13T16:59:59Z&bucket=1d&tz=asia/jakarta&mmsi=' +
        String(vesselA),
      { roles: ['viewer'], orgId: orgA },
    );
    expect(response.statusCode, response.body).toBe(200);
    const series = SeriesSchema.parse(response.json());
    expect(series).toMatchObject({
      bucket: '1d',
      groupBy: 'severity',
      timeZone: 'Asia/Jakarta',
      keys: ['info', 'warning', 'critical'],
    });
    expect(
      series.buckets.map((bucket) => [
        bucket.from,
        bucket.total,
        bucket.counts,
      ]),
    ).toEqual([
      ['2026-10-10T17:00:00.000Z', 2, { info: 0, warning: 1, critical: 1 }],
      ['2026-10-11T17:00:00.000Z', 1, { info: 0, warning: 1, critical: 0 }],
      ['2026-10-12T17:00:00.000Z', 0, { info: 0, warning: 0, critical: 0 }],
    ]);

    // The tenancy of /alerts/summary: another organization counts nothing of A.
    const other = SeriesSchema.parse(
      (
        await call(
          'GET',
          `/alerts/stats/series?from=2026-10-10T17:00:00Z&to=2026-10-13T16:59:59Z&bucket=1d&groupBy=type&mmsi=${vesselA}`,
          { roles: ['viewer'], orgId: orgB },
        )
      ).json(),
    );
    expect(other.buckets.every((bucket) => bucket.total === 0)).toBe(true);
    expect(other.keys).toContain('ews');

    for (const query of [
      'bucket=1h&from=2026-01-01T00:00:00Z&to=2026-11-01T00:00:00Z',
      'tz=%2B07:00',
      'tz=Mars/Olympus',
      'groupBy=vessel',
    ]) {
      const bad = await call('GET', `/alerts/stats/series?${query}`, {
        roles: ['viewer'],
        orgId: orgA,
      });
      expect(bad.statusCode, query).toBe(400);
    }
  });

  it('clips the first and last series bucket to the range and caps the clipped bucket count', async () => {
    const vessel = uniqueMmsi();
    await registerVessel(service, { mmsi: vessel, orgId: orgA });
    for (const occurredAt of [
      '2026-10-20T10:10:00.000Z',
      '2026-10-20T10:40:00.000Z',
      '2026-10-20T11:20:00.000Z',
      '2026-10-20T11:30:00.000Z',
      '2026-10-20T12:00:00.000Z',
    ]) {
      const alert = alertRaised(vessel, {
        dedupKey: `ews:${vessel}:clip:${newId()}`,
        occurredAt,
      });
      await raiseAlert(service, alert);
      await storedAlert(service, alert.dedupKey);
    }
    const authority = { roles: ['authority'] as Role[] };
    const series = async (range: string) => {
      const response = await call(
        'GET',
        `/alerts/stats/series?bucket=1h&${range}&mmsi=${vessel}`,
        authority,
      );
      expect(response.statusCode, response.body).toBe(200);
      return SeriesSchema.parse(response.json()).buckets.map((bucket) => [
        bucket.from,
        bucket.to,
        bucket.total,
      ]);
    };

    // The labels match the counts: [10:30, 11:00) has the alert of 10:40, not
    // the one of 10:10, and the last bucket ends at `to`, inclusive.
    expect(
      await series('from=2026-10-20T10:30:00Z&to=2026-10-20T11:30:00Z'),
    ).toEqual([
      ['2026-10-20T10:30:00.000Z', '2026-10-20T11:00:00.000Z', 1],
      ['2026-10-20T11:00:00.000Z', '2026-10-20T11:30:00.000Z', 2],
    ]);
    // `to` at a bucket start: the alert at that instant ends the bucket before.
    const whole = await series(
      'from=2026-10-20T10:00:00Z&to=2026-10-20T12:00:00Z',
    );
    expect(whole).toEqual([
      ['2026-10-20T10:00:00.000Z', '2026-10-20T11:00:00.000Z', 2],
      ['2026-10-20T11:00:00.000Z', '2026-10-20T12:00:00.000Z', 3],
    ]);
    // The totals are the alerts GET /alerts lists with the same filters.
    const listed = await call(
      'GET',
      `/alerts?from=2026-10-20T10:00:00Z&to=2026-10-20T12:00:00Z&mmsi=${vessel}`,
      authority,
    );
    expect(listed.json<{ data: unknown[] }>().data).toHaveLength(5);

    // The cap counts the buckets returned: 999.75 h starting at :30 span 1001
    // buckets (refused), 1000 whole hours 1000 (the instant `to` folded).
    const tooMany = await call(
      'GET',
      '/alerts/stats/series?bucket=1h&from=2026-01-01T00:30:00Z&to=2026-02-11T16:15:00Z',
      authority,
    );
    expect(tooMany.statusCode, tooMany.body).toBe(400);
    expect(ProblemSchema.parse(tooMany.json()).code).toBe('VALIDATION_FAILED');
    for (const range of [
      'from=2026-01-01T00:00:00Z&to=2026-02-11T16:00:00Z',
      'from=2026-01-01T00:30:00Z&to=2026-02-11T16:00:00Z',
    ]) {
      const response = await call(
        'GET',
        `/alerts/stats/series?bucket=1h&${range}`,
        authority,
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(SeriesSchema.parse(response.json()).buckets).toHaveLength(1_000);
    }
  });

  it('streams the filtered alerts as CSV with localized headers and a row limit', async () => {
    const titled = alertRaised(vesselA, {
      dedupKey: `ews:${vesselA}:csv`,
      title: '=cmd|"/c calc"!A1, injected',
    });
    await raiseAlert(service, titled);
    await storedAlert(service, titled.dedupKey);
    const owner = { roles: ['viewer'] as Role[], orgId: orgA };

    const english = await call(
      'GET',
      `/alerts/export.csv?mmsi=${vesselA}&status=open`,
      owner,
      { headers: { 'accept-language': 'en-GB,en;q=0.9' } },
    );
    expect(english.statusCode, english.body).toBe(200);
    expect(english.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(english.headers['content-language']).toBe('en');
    expect(String(english.headers['content-disposition'])).toMatch(
      /^attachment; filename="alerts-\d{8}-\d{4}\.csv"$/,
    );
    expect(String(english.headers.vary)).toContain('Accept-Language');
    expect(english.headers['x-truncated']).toBeUndefined();
    const lines = english.body.trimEnd().split('\r\n');
    expect(lines[0]).toMatch(/^ID,First occurrence,Last occurrence,/);
    const row = lines.find((line) => line.startsWith(titled.id));
    // Formula-like text is neutralized and quoted (RFC 4180).
    expect(row).toContain(`"'=cmd|""/c calc""!A1, injected"`);
    expect(
      lines.slice(1).every((line) => !line.includes(String(vesselB))),
    ).toBe(true);

    const indonesian = await call(
      'GET',
      `/alerts/export.csv?mmsi=${vesselA}`,
      owner,
    );
    expect(indonesian.headers['content-language']).toBe('id');
    expect(indonesian.body).toMatch(/^ID,Kejadian pertama,Kejadian terakhir,/);
  });

  it('cuts the CSV export at ALERT_EXPORT_MAX_ROWS and says so', async () => {
    const limited = await startTestService({
      env: { ALERT_EXPORT_MAX_ROWS: '2' },
    });
    try {
      const response = await limited.app.inject({
        method: 'GET',
        url: `/api/v2/alerts/export.csv?mmsi=${vesselA}`,
        headers: await limited.authorization({ roles: ['authority'] }),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-truncated']).toBe('true');
      expect(response.body.trimEnd().split('\r\n')).toHaveLength(3);
    } finally {
      await limited.app.close();
    }
  });
});
