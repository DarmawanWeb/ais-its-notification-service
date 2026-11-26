import { LOCALES, type Locale } from '@darmawanweb/ais-its-contracts/domain';

/** Leading characters that make spreadsheet applications evaluate a cell as a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** A CSV cell value; `null` is an empty cell. */
export type CsvValue = string | number | boolean | null;

/**
 * RFC 4180 field: quoted when it contains a comma, quote or line break. Text
 * (never numbers) starting like a spreadsheet formula gets a leading `'`
 * (CSV injection, OWASP): vessel names and texts come from tenants and
 * detectors.
 */
export function csvField(value: CsvValue): string {
  if (value === null) return '';
  const text =
    typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : FORMULA_PREFIX.test(value)
        ? `'${value}`
        : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One CSV record with its CRLF line end. */
export function csvLine(values: readonly CsvValue[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}

/**
 * The supported locale an `Accept-Language` header prefers (RFC 9110
 * quality values; `id-ID` → `id`, `en-GB` → `en`; `*` → the fallback), else
 * the fallback.
 */
export function preferredLocale(
  acceptLanguage: string | undefined,
  fallback: Locale = 'id',
): Locale {
  if (acceptLanguage === undefined) return fallback;
  let best: { locale: Locale; quality: number } | undefined;
  for (const part of acceptLanguage.split(',')) {
    const [range = '', ...parameters] = part.trim().split(';');
    const quality = qualityOf(parameters);
    if (quality <= 0) continue;
    const primary = range.trim().toLowerCase().split('-')[0] ?? '';
    const locale =
      primary === '*' ? fallback : LOCALES.find((code) => code === primary);
    if (locale === undefined) continue;
    // The first range of the highest quality wins.
    if (best === undefined || quality > best.quality)
      best = { locale, quality };
  }
  return best?.locale ?? fallback;
}

function qualityOf(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const [name, value] = parameter.trim().split('=');
    if (name?.trim().toLowerCase() === 'q') {
      const quality = Number(value);
      return Number.isFinite(quality) ? Math.min(Math.max(quality, 0), 1) : 0;
    }
  }
  return 1;
}

/** The part of a Fastify reply {@link addVary} uses. */
export interface HeaderReply {
  getHeader(name: string): unknown;
  header(name: string, value: string): unknown;
}

/**
 * Adds `field` to the `Vary` header of `reply`, keeping the fields already
 * listed (RFC 9110 §12.5.5): the CORS hook sets `Vary: Origin` (the allowed
 * origins are a list), which Nest's `@Header('vary', …)` would replace.
 * `*` stays `*`.
 */
export function addVary(reply: HeaderReply, field: string): void {
  const current = reply.getHeader('vary');
  const values: unknown[] = Array.isArray(current) ? current : [current];
  const listed = values
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const names = listed.map((value) => value.toLowerCase());
  if (names.includes('*') || names.includes(field.toLowerCase())) return;
  reply.header('vary', [...listed, field].join(', '));
}
