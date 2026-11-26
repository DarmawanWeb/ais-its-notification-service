import { describe, expect, it } from 'vitest';

import {
  type AlertLifecycle,
  type AlertOccurrence,
  type MergeableAlert,
  mergeOccurrence,
  type ResolvableAlert,
  resolveByDetector,
  transitionAlert,
} from './alert-inbox.js';

const FIRST = new Date('2026-11-21T08:00:00Z');
const LATER = new Date('2026-11-21T08:05:00Z');
const EARLIER = new Date('2026-11-21T07:55:00Z');

const stored: MergeableAlert = {
  severity: 'warning',
  status: 'open',
  occurrences: 1,
  lastOccurredAt: FIRST,
  title: 'Anchored 1.2 km from the pipeline',
  message: 'KM Example is predicted at anchor near KP 12',
  lat: -6.1,
  lon: 106.8,
  relatedMmsi: null,
  zoneId: '0193a3c0-0000-7000-8000-000000000001',
  methodId: 'ews.pipeline_distance_status',
  data: { distanceM: 1_200 },
  acknowledgedBy: null,
  acknowledgedAt: null,
};

function occurrence(overrides: Partial<AlertOccurrence> = {}): AlertOccurrence {
  return {
    severity: 'warning',
    occurredAt: LATER,
    title: 'Anchored 900 m from the pipeline',
    message: 'KM Example is predicted at anchor near KP 12',
    lat: -6.11,
    lon: 106.81,
    relatedMmsi: null,
    zoneId: null,
    methodId: 'ews.pipeline_distance_status',
    data: { distanceM: 900 },
    ...overrides,
  };
}

describe('mergeOccurrence (notify.alert_dedup_merge)', () => {
  it('counts the occurrence and takes the details of the newest one', () => {
    const { alert, escalated, reopened } = mergeOccurrence(
      stored,
      occurrence(),
    );

    expect(alert).toMatchObject({
      occurrences: 2,
      lastOccurredAt: LATER,
      severity: 'warning',
      status: 'open',
      title: 'Anchored 900 m from the pipeline',
      lat: -6.11,
      lon: 106.81,
      data: { distanceM: 900 },
    });
    expect(escalated).toBe(false);
    expect(reopened).toBe(false);
  });

  it('keeps the known zone and related vessel when the occurrence has none', () => {
    const { alert } = mergeOccurrence(
      { ...stored, relatedMmsi: 525005224 },
      occurrence(),
    );

    expect(alert.zoneId).toBe(stored.zoneId);
    expect(alert.relatedMmsi).toBe(525005224);
  });

  it('never lowers the severity', () => {
    const { alert, escalated } = mergeOccurrence(
      { ...stored, severity: 'critical' },
      occurrence({ severity: 'info' }),
    );

    expect(alert.severity).toBe('critical');
    expect(escalated).toBe(false);
  });

  it('escalates to a higher severity', () => {
    const { alert, escalated } = mergeOccurrence(
      stored,
      occurrence({ severity: 'critical' }),
    );

    expect(alert.severity).toBe('critical');
    expect(escalated).toBe(true);
  });

  it('counts an out-of-order occurrence without overwriting newer details', () => {
    const { alert } = mergeOccurrence(
      stored,
      occurrence({ occurredAt: EARLIER, severity: 'critical' }),
    );

    expect(alert).toMatchObject({
      occurrences: 2,
      lastOccurredAt: FIRST,
      severity: 'critical',
      title: stored.title,
      data: stored.data,
    });
  });

  it('reopens an acknowledged alert that escalates', () => {
    const acknowledged: MergeableAlert = {
      ...stored,
      status: 'acknowledged',
      acknowledgedBy: '0193a3c0-0000-7000-8000-0000000000aa',
      acknowledgedAt: FIRST,
    };

    const { alert, reopened } = mergeOccurrence(
      acknowledged,
      occurrence({ severity: 'critical' }),
    );

    expect(reopened).toBe(true);
    expect(alert).toMatchObject({
      status: 'open',
      acknowledgedBy: null,
      acknowledgedAt: null,
    });
  });

  it('keeps an acknowledged alert acknowledged without escalation', () => {
    const acknowledged: MergeableAlert = {
      ...stored,
      status: 'acknowledged',
      acknowledgedBy: '0193a3c0-0000-7000-8000-0000000000aa',
      acknowledgedAt: FIRST,
    };

    const { alert, reopened } = mergeOccurrence(acknowledged, occurrence());

    expect(reopened).toBe(false);
    expect(alert.status).toBe('acknowledged');
    expect(alert.occurrences).toBe(2);
  });

  it('refuses to merge into a resolved alert', () => {
    expect(() =>
      mergeOccurrence({ ...stored, status: 'resolved' }, occurrence()),
    ).toThrow(RangeError);
  });
});

describe('transitionAlert (notify.alert_lifecycle)', () => {
  const open: AlertLifecycle = {
    status: 'open',
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedBy: null,
    resolvedAt: null,
  };
  const actor = '0193a3c0-0000-7000-8000-0000000000bb';

  it('acknowledges an open alert', () => {
    expect(transitionAlert(open, 'acknowledge', actor, LATER)).toEqual({
      changed: true,
      lifecycle: {
        ...open,
        status: 'acknowledged',
        acknowledgedBy: actor,
        acknowledgedAt: LATER,
      },
    });
  });

  it('is idempotent for an acknowledged alert', () => {
    const acknowledged: AlertLifecycle = {
      ...open,
      status: 'acknowledged',
      acknowledgedBy: actor,
      acknowledgedAt: FIRST,
    };

    expect(transitionAlert(acknowledged, 'acknowledge', actor, LATER)).toEqual({
      changed: false,
      lifecycle: acknowledged,
    });
  });

  it('resolves open and acknowledged alerts, keeping the acknowledgement', () => {
    const acknowledged: AlertLifecycle = {
      ...open,
      status: 'acknowledged',
      acknowledgedBy: actor,
      acknowledgedAt: FIRST,
    };

    expect(transitionAlert(open, 'resolve', actor, LATER)).toMatchObject({
      changed: true,
      lifecycle: { status: 'resolved', resolvedBy: actor, resolvedAt: LATER },
    });
    expect(
      transitionAlert(acknowledged, 'resolve', actor, LATER),
    ).toMatchObject({
      changed: true,
      lifecycle: {
        status: 'resolved',
        acknowledgedBy: actor,
        acknowledgedAt: FIRST,
      },
    });
  });

  it('is idempotent for a resolved alert and refuses to acknowledge it', () => {
    const resolved: AlertLifecycle = {
      ...open,
      status: 'resolved',
      resolvedBy: actor,
      resolvedAt: FIRST,
    };

    expect(transitionAlert(resolved, 'resolve', actor, LATER)).toEqual({
      changed: false,
      lifecycle: resolved,
    });
    expect(transitionAlert(resolved, 'acknowledge', actor, LATER)).toEqual({
      rejected: 'ALERT_ALREADY_RESOLVED',
    });
  });
});

describe('resolveByDetector (notify.alert_lifecycle)', () => {
  const open: ResolvableAlert = {
    status: 'open',
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedBy: null,
    resolvedAt: null,
    lastOccurredAt: LATER,
  };

  it('resolves an open alert at the end of the condition, by the system', () => {
    const resolvedAt = new Date('2026-11-21T08:20:00Z');
    expect(resolveByDetector(open, resolvedAt)).toEqual({
      resolved: true,
      lifecycle: {
        status: 'resolved',
        acknowledgedBy: null,
        acknowledgedAt: null,
        resolvedBy: null,
        resolvedAt,
      },
    });
  });

  it('resolves an acknowledged alert and keeps its acknowledgement', () => {
    const acknowledged: ResolvableAlert = {
      ...open,
      status: 'acknowledged',
      acknowledgedBy: '0193a3c0-0000-7000-8000-0000000000aa',
      acknowledgedAt: LATER,
    };
    const outcome = resolveByDetector(acknowledged, LATER);
    expect(outcome).toMatchObject({
      resolved: true,
      lifecycle: {
        status: 'resolved',
        acknowledgedBy: acknowledged.acknowledgedBy,
        acknowledgedAt: LATER,
        resolvedBy: null,
        resolvedAt: LATER,
      },
    });
  });

  it('resolves at the exact time of the latest occurrence', () => {
    expect(resolveByDetector(open, LATER)).toMatchObject({ resolved: true });
  });

  it('keeps an alert open that merged an occurrence after resolvedAt', () => {
    expect(resolveByDetector(open, FIRST)).toEqual({
      resolved: false,
      ignored: 'later_occurrence',
    });
  });

  it('leaves a resolved alert alone', () => {
    const resolved: ResolvableAlert = {
      ...open,
      status: 'resolved',
      resolvedBy: '0193a3c0-0000-7000-8000-0000000000aa',
      resolvedAt: LATER,
    };
    expect(resolveByDetector(resolved, new Date())).toEqual({
      resolved: false,
      ignored: 'already_resolved',
    });
  });
});
