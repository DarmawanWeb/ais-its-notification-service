import type { RealtimeAlert } from '@darmawanweb/ais-its-contracts/realtime';
import { describe, expect, it } from 'vitest';

import {
  alertLink,
  buildAlertMessage,
  formatUtc,
  vesselLabel,
} from './alert-message.js';

const ALERT: RealtimeAlert = {
  id: '0193a3c0-0000-7000-8000-000000000001',
  type: 'collision',
  domain: 'safety',
  severity: 'warning',
  status: 'acknowledged',
  mmsi: 525005223,
  relatedMmsi: 525005224,
  title: 'CPA 0.4 nm in 9 min',
  message: 'Risk of collision with 525005224',
  lat: 1.1,
  lon: 104.05,
  zoneId: null,
  methodId: 'collision.cpa_tcpa',
  occurredAt: '2026-11-21T08:15:00.000Z',
  lastOccurredAt: '2026-11-21T08:16:00.000Z',
  occurrences: 2,
  data: {},
};

const CONTEXT = {
  locale: 'en' as const,
  vesselName: 'KM Example',
  ruleName: 'Collisions',
  link: 'https://ais-its.example/alerts?alert=0193a3c0',
};

describe('buildAlertMessage', () => {
  it('builds the localized texts from the registry and the catalog', () => {
    const message = buildAlertMessage(ALERT, CONTEXT);

    expect(message.subject).toBe(
      '[Warning] Collision risk — KM Example (525005223)',
    );
    expect(message.heading).toBe('Collision risk: CPA 0.4 nm in 9 min');
    expect(message.summary).toBe(ALERT.message);
    expect(message.lines).toEqual(
      expect.arrayContaining([
        { label: 'Other vessel', value: '525005224' },
        { label: 'Status', value: 'Acknowledged' },
        { label: 'Occurrences', value: '2' },
        { label: 'Latest occurrence', value: '2026-11-21 08:16:00 UTC' },
        { label: 'Position', value: '1.10000, 104.05000' },
        { label: 'Alert rule', value: 'Collisions' },
      ]),
    );
    const method = message.lines.find((line) => line.label === 'Method');
    expect(method?.value).toMatch(/\(collision\.cpa_tcpa\)$/);
  });

  it('speaks Bahasa Indonesia', () => {
    const message = buildAlertMessage(ALERT, { ...CONTEXT, locale: 'id' });

    expect(message.subject).toBe(
      '[Peringatan] Risiko tubrukan — KM Example (525005223)',
    );
    expect(message.linkLabel).toBe('Buka alert');
  });

  it('shows future types and uncatalogued methods by their ids', () => {
    const message = buildAlertMessage(
      {
        ...ALERT,
        type: 'anchor_dragging',
        methodId: 'safety.anchor_dragging',
        relatedMmsi: null,
        lat: null,
        lon: null,
        occurrences: 1,
      },
      { ...CONTEXT, vesselName: null, ruleName: null },
    );

    expect(message.subject).toBe('[Warning] anchor_dragging — 525005223');
    expect(message.lines).toContainEqual({
      label: 'Method',
      value: 'safety.anchor_dragging',
    });
    const labels = message.lines.map((line) => line.label);
    expect(labels).not.toContain('Position');
    expect(labels).not.toContain('Occurrences');
    expect(labels).not.toContain('Alert rule');
  });
});

describe('helpers', () => {
  it('formats times in UTC and labels vessels', () => {
    expect(formatUtc('2026-11-21T08:15:00.123+07:00')).toBe(
      '2026-11-21 01:15:00 UTC',
    );
    expect(vesselLabel(525005223, ' ')).toBe('525005223');
    expect(vesselLabel(525005223, 'KM Example')).toBe('KM Example (525005223)');
  });

  it('links to the alert in the web application', () => {
    expect(alertLink('http://localhost:8000/', 'a b')).toBe(
      'http://localhost:8000/alerts?alert=a%20b',
    );
  });
});
