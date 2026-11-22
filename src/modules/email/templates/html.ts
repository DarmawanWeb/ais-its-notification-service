const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/**
 * Escapes text for HTML element content and quoted attribute values
 * (OWASP XSS prevention rule 1/2: `& < > " ' \``).
 */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"'`]/g,
    (character) => HTML_ESCAPES[character] ?? character,
  );
}

/** Markup that is already safe: produced by {@link html}, never from input. */
export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

/** A value interpolated into {@link html}. */
export type HtmlValue =
  SafeHtml | string | number | null | undefined | readonly HtmlValue[];

function render(value: HtmlValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value))
    return value.map((item: HtmlValue) => render(item)).join('');
  return escapeHtml(String(value));
}

/**
 * Tagged template for HTML: every interpolated value is escaped unless it is
 * a {@link SafeHtml} fragment built with this tag, so template data can
 * never inject markup.
 *
 * @example html`<p>Hello ${name}</p>` // name "<b>x</b>" → "<p>Hello &lt;b&gt;x&lt;/b&gt;</p>"
 */
export function html(
  strings: TemplateStringsArray,
  ...values: readonly HtmlValue[]
): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? '');
  });
  return new SafeHtml(out);
}

/**
 * A link usable in `href`: only absolute `http(s)` URLs pass, so a
 * `javascript:` or `data:` URL from template data never becomes clickable.
 *
 * @throws RangeError for any other URL
 */
export function safeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RangeError(`URL scheme ${url.protocol} is not allowed`);
  }
  return url.toString();
}
