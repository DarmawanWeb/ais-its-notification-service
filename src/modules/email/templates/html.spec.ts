import { describe, expect, it } from 'vitest';

import { escapeHtml, html, SafeHtml, safeUrl } from './html.js';

describe('escapeHtml', () => {
  it('escapes the characters significant in content and attributes', () => {
    expect(escapeHtml(`<a href="x" title='y'>&\`</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&#96;&lt;/a&gt;',
    );
  });
});

describe('html', () => {
  it('escapes interpolated strings and numbers, skips null and undefined', () => {
    const name = '<b>Siti</b>';

    expect(html`<p>${name} ${42}${null}${undefined}</p>`.value).toBe(
      '<p>&lt;b&gt;Siti&lt;/b&gt; 42</p>',
    );
  });

  it('nests fragments built with the tag without escaping them twice', () => {
    const items = ['a&b', 'c'].map((item) => html`<li>${item}</li>`);

    // prettier-ignore
    const list = html`<ul>${items}</ul>`;

    expect(list.value).toBe('<ul><li>a&amp;b</li><li>c</li></ul>');
    expect(html`${new SafeHtml('<br>')}`.toString()).toBe('<br>');
  });
});

describe('safeUrl', () => {
  it('passes absolute http(s) URLs', () => {
    expect(safeUrl('https://ais-its.example/reset#token=a')).toBe(
      'https://ais-its.example/reset#token=a',
    );
  });

  it('refuses other schemes and relative URLs', () => {
    expect(() => safeUrl('javascript:alert(1)')).toThrow(RangeError);
    expect(() => safeUrl('data:text/html,x')).toThrow(RangeError);
    expect(() => safeUrl('/reset')).toThrow(RangeError);
  });
});
