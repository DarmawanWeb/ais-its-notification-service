import type { Locale } from '@darmawanweb/ais-its-contracts/domain';

import type { CsvValue } from '../../domain/csv.js';
import type { InboxAlert } from './alert.js';

/** A column of the alert export. */
interface ExportColumn {
  readonly header: Readonly<Record<Locale, string>>;
  readonly value: (alert: InboxAlert) => CsvValue;
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/**
 * Columns of `GET /alerts/export.csv`: headers in the language of
 * `Accept-Language` (`id` or `en`); values are the stored ones (codes such
 * as `warning` / `open`, ISO-8601 UTC times, the English title and message
 * of the detector).
 */
export const ALERT_EXPORT_COLUMNS: readonly ExportColumn[] = [
  { header: { id: 'ID', en: 'ID' }, value: (a) => a.id },
  {
    header: { id: 'Kejadian pertama', en: 'First occurrence' },
    value: (a) => iso(a.occurredAt),
  },
  {
    header: { id: 'Kejadian terakhir', en: 'Last occurrence' },
    value: (a) => iso(a.lastOccurredAt),
  },
  {
    header: { id: 'Jumlah kejadian', en: 'Occurrences' },
    value: (a) => a.occurrences,
  },
  { header: { id: 'Jenis', en: 'Type' }, value: (a) => a.type },
  { header: { id: 'Domain', en: 'Domain' }, value: (a) => a.domain },
  { header: { id: 'Tingkat', en: 'Severity' }, value: (a) => a.severity },
  { header: { id: 'Status', en: 'Status' }, value: (a) => a.status },
  { header: { id: 'MMSI', en: 'MMSI' }, value: (a) => a.mmsi },
  {
    header: { id: 'MMSI terkait', en: 'Related MMSI' },
    value: (a) => a.relatedMmsi,
  },
  { header: { id: 'Judul', en: 'Title' }, value: (a) => a.title },
  { header: { id: 'Pesan', en: 'Message' }, value: (a) => a.message },
  { header: { id: 'Lintang', en: 'Latitude' }, value: (a) => a.lat },
  { header: { id: 'Bujur', en: 'Longitude' }, value: (a) => a.lon },
  { header: { id: 'Zona', en: 'Zone' }, value: (a) => a.zoneId },
  { header: { id: 'Metode', en: 'Method' }, value: (a) => a.methodId },
  {
    header: { id: 'Diketahui pada', en: 'Acknowledged at' },
    value: (a) => iso(a.acknowledgedAt),
  },
  {
    header: { id: 'Diselesaikan pada', en: 'Resolved at' },
    value: (a) => iso(a.resolvedAt),
  },
  {
    header: { id: 'Diselesaikan oleh', en: 'Resolved by' },
    value: (a) => (a.resolvedAt === null ? null : (a.resolvedBy ?? 'system')),
  },
  {
    header: { id: 'Alasan penyelesaian', en: 'Resolution reason' },
    value: (a) => a.resolutionReason,
  },
  { header: { id: 'Kunci dedup', en: 'Dedup key' }, value: (a) => a.dedupKey },
];

/** The header row of the export in `locale`. */
export function exportHeader(locale: Locale): CsvValue[] {
  return ALERT_EXPORT_COLUMNS.map((column) => column.header[locale]);
}

/** One alert as an export row. */
export function exportRow(alert: InboxAlert): CsvValue[] {
  return ALERT_EXPORT_COLUMNS.map((column) => column.value(alert));
}
