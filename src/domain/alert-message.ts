import {
  ALERT_SEVERITY_LABELS,
  alertDomainLabel,
  alertTypeLabel,
  type Locale,
} from '@darmawanweb/ais-its-contracts/domain';
import type { RealtimeAlert } from '@darmawanweb/ais-its-contracts/realtime';
import { getMethod } from '@darmawanweb/ais-its-contracts/references';

/** Context of an alert notification. */
export interface AlertMessageContext {
  readonly locale: Locale;
  /** Name of the vessel from the FLEET projection, when registered. */
  readonly vesselName: string | null;
  /** Name of the rule that notifies, when sent for a rule. */
  readonly ruleName: string | null;
  /** Link to the alert in the web application. */
  readonly link: string;
}

/** One labelled line of an alert notification. */
export interface AlertMessageLine {
  readonly label: string;
  readonly value: string;
}

/** The localized, plain-text parts of an alert notification (no markup). */
export interface AlertMessage {
  /** `[Critical] Pipeline early warning — KM Example (525005223)` */
  readonly subject: string;
  readonly heading: string;
  readonly summary: string;
  readonly lines: readonly AlertMessageLine[];
  readonly link: string;
  readonly linkLabel: string;
}

const LABELS = {
  en: {
    vessel: 'Vessel',
    relatedVessel: 'Other vessel',
    domain: 'Domain',
    severity: 'Severity',
    status: 'Status',
    occurredAt: 'First occurrence',
    lastOccurredAt: 'Latest occurrence',
    occurrences: 'Occurrences',
    position: 'Position',
    method: 'Method',
    rule: 'Alert rule',
    open: 'Open alert',
  },
  id: {
    vessel: 'Kapal',
    relatedVessel: 'Kapal lain',
    domain: 'Domain',
    severity: 'Tingkat',
    status: 'Status',
    occurredAt: 'Kejadian pertama',
    lastOccurredAt: 'Kejadian terakhir',
    occurrences: 'Jumlah kejadian',
    position: 'Posisi',
    method: 'Metode',
    rule: 'Aturan alert',
    open: 'Buka alert',
  },
} as const satisfies Record<Locale, Record<string, string>>;

const STATUS_LABELS = {
  en: { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved' },
  id: { open: 'Terbuka', acknowledged: 'Diterima', resolved: 'Selesai' },
} as const;

/** `2026-11-21 08:15:00 UTC` — unambiguous in every locale. */
export function formatUtc(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** `-6.20880, 106.84560` (5 decimals ≈ 1 m). */
function formatPosition(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/** `KM Example (525005223)` or the MMSI alone for unregistered vessels. */
export function vesselLabel(mmsi: number, name: string | null): string {
  return name === null || name.trim() === '' ? String(mmsi) : `${name} (${mmsi})`;
}

/**
 * Builds the localized texts of an alert notification (e-mail, Telegram,
 * webhook `text`) from the inbox view of the alert. Type, domain and severity
 * labels come from the contracts alert registry (unknown future types are
 * shown by their id) and the method name from the methodology catalog
 * (spec §17: alerts carry the `methodId` of the rule that raised them).
 * The result is plain text: every channel escapes it for its own markup.
 */
export function buildAlertMessage(
  alert: RealtimeAlert,
  context: AlertMessageContext,
): AlertMessage {
  const labels = LABELS[context.locale];
  const severity = ALERT_SEVERITY_LABELS[alert.severity][context.locale];
  const type = alertTypeLabel(alert.type, context.locale);
  const vessel = vesselLabel(alert.mmsi, context.vesselName);
  const method = getMethod(alert.methodId);
  const lines: AlertMessageLine[] = [
    { label: labels.vessel, value: vessel },
    ...(alert.relatedMmsi === null
      ? []
      : [{ label: labels.relatedVessel, value: String(alert.relatedMmsi) }]),
    { label: labels.severity, value: severity },
    { label: labels.domain, value: alertDomainLabel(alert.domain, context.locale) },
    { label: labels.status, value: STATUS_LABELS[context.locale][alert.status] },
    { label: labels.occurredAt, value: formatUtc(alert.occurredAt) },
    ...(alert.occurrences > 1
      ? [
          { label: labels.lastOccurredAt, value: formatUtc(alert.lastOccurredAt) },
          { label: labels.occurrences, value: String(alert.occurrences) },
        ]
      : []),
    ...(alert.lat === null || alert.lon === null
      ? []
      : [{ label: labels.position, value: formatPosition(alert.lat, alert.lon) }]),
    {
      label: labels.method,
      value:
        method === undefined
          ? alert.methodId
          : `${method.name[context.locale]} (${alert.methodId})`,
    },
    ...(context.ruleName === null ? [] : [{ label: labels.rule, value: context.ruleName }]),
  ];
  return {
    subject: `[${severity}] ${type} — ${vessel}`,
    heading: `${type}: ${alert.title}`,
    summary: alert.message,
    lines,
    link: context.link,
    linkLabel: labels.open,
  };
}

/** Link to an alert in the web application (`/alerts?alert=<id>`). */
export function alertLink(publicBaseUrl: string, alertId: string): string {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return `${base}/alerts?alert=${encodeURIComponent(alertId)}`;
}
