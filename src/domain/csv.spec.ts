import { describe, expect, it } from 'vitest';

import { addVary, csvField, csvLine, preferredLocale } from './csv.js';

describe('csvField / csvLine', () => {
  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField(null)).toBe('');
    expect(csvField(-6.95)).toBe('-6.95');
    expect(csvField(true)).toBe('true');
  });

  it('neutralizes text that a spreadsheet would evaluate as a formula', () => {
    expect(csvField('=HYPERLINK("http://x")')).toBe(
      '"\'=HYPERLINK(""http://x"")"',
    );
    expect(csvField('+62 812')).toBe("'+62 812");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('ends a record with CRLF', () => {
    expect(csvLine(['id', 1, null])).toBe('id,1,\r\n');
  });
});

describe('preferredLocale', () => {
  it.each([
    [undefined, 'id'],
    ['', 'id'],
    ['en', 'en'],
    ['en-GB,en;q=0.9', 'en'],
    ['id-ID,id;q=0.9,en;q=0.8', 'id'],
    ['fr-FR,en;q=0.5', 'en'],
    ['fr, de', 'id'],
    ['en;q=0.2, id;q=0.8', 'id'],
    ['en;q=0, id;q=0', 'id'],
    ['*', 'id'],
  ])('%s → %s', (header, locale) => {
    expect(preferredLocale(header)).toBe(locale);
  });
});

describe('addVary', () => {
  function reply(initial?: string | string[]) {
    const headers = new Map<string, unknown>();
    if (initial !== undefined) headers.set('vary', initial);
    return {
      headers,
      getHeader: (name: string) => headers.get(name),
      header: (name: string, value: string) => headers.set(name, value),
    };
  }

  it('keeps the Vary of the CORS hook', () => {
    const target = reply('Origin');
    addVary(target, 'Accept-Language');
    expect(target.headers.get('vary')).toBe('Origin, Accept-Language');
  });

  it('adds a field once and leaves * alone', () => {
    const listed = reply(['Origin', 'accept-language']);
    addVary(listed, 'Accept-Language');
    expect(listed.headers.get('vary')).toEqual(['Origin', 'accept-language']);
    const any = reply('*');
    addVary(any, 'Accept-Language');
    expect(any.headers.get('vary')).toBe('*');
    const none = reply();
    addVary(none, 'Accept-Language');
    expect(none.headers.get('vary')).toBe('Accept-Language');
  });
});
