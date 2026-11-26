/**
 * Localizable alert texts (platform convention of contracts 0.4.0): safety
 * and surveillance put a stable `messageKey` (`<domain>.<detector>.<situation>`)
 * and its `messageParams` (a flat object of strings, numbers and booleans)
 * into the `data` of `alert.raised.v1` and `alert.resolved.v1`, next to the
 * English `title` / `message` / `reason` that e-mails and webhooks keep using.
 */

/** Grammar of a message key: dotted lowercase segments, at least two. */
export const MESSAGE_KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/** Longest accepted message key (longer ones are treated as absent). */
export const MESSAGE_KEY_MAX_LENGTH = 128;

/** A message parameter: a flat primitive. */
export type MessageParam = string | number | boolean;

/** The localizable text of an alert or a resolution. */
export interface LocalizableText {
  readonly messageKey: string | null;
  readonly messageParams: Readonly<Record<string, MessageParam>> | null;
}

/** No localizable text: the client renders the English text. */
export const NO_LOCALIZABLE_TEXT: LocalizableText = Object.freeze({
  messageKey: null,
  messageParams: null,
});

function isMessageParam(value: unknown): value is MessageParam {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reads `messageKey` and `messageParams` from alert (or resolution) `data`.
 * Both are returned only when the key matches {@link MESSAGE_KEY_PATTERN}
 * (at most {@link MESSAGE_KEY_MAX_LENGTH} characters) and the params are a
 * plain object of strings, finite numbers and booleans; otherwise both are
 * `null` (data of older detectors, or malformed), and the client falls back
 * to the English text.
 *
 * @param data - the `data` of an inbox alert, an occurrence or a resolution
 */
export function localizableTextOf(
  data: Readonly<Record<string, unknown>> | null,
): LocalizableText {
  if (data === null) return NO_LOCALIZABLE_TEXT;
  const key = data.messageKey;
  const params = data.messageParams;
  if (
    typeof key !== 'string' ||
    key.length > MESSAGE_KEY_MAX_LENGTH ||
    !MESSAGE_KEY_PATTERN.test(key) ||
    !isPlainObject(params)
  ) {
    return NO_LOCALIZABLE_TEXT;
  }
  const entries = Object.entries(params);
  if (!entries.every(([, value]) => isMessageParam(value)))
    return NO_LOCALIZABLE_TEXT;
  return {
    messageKey: key,
    messageParams: Object.fromEntries(entries) as Record<string, MessageParam>,
  };
}
