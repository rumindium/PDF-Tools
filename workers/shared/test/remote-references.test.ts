import { describe, expect, test } from 'bun:test';
import {
  describeRemoteReferences,
  findRemoteReferencesInCss,
  findRemoteReferencesInHtml,
} from '../src/guards/remote-references';

/**
 * The guard's job is to be *right in both directions*, and the negative cases below are the ones that matter most: a
 * document with a hyperlink, a `data:` image, or a path beside itself is ordinary HTML, and refusing it would make
 * the tool useless rather than safe.
 */

describe('findRemoteReferencesInHtml', () => {
  test('finds an image the renderer would fetch', () => {
    const found = findRemoteReferencesInHtml('<p><img src="https://cdn.example.com/logo.png" alt="logo"></p>');
    expect(found).toEqual([{ reference: 'https://cdn.example.com/logo.png', where: 'img src', reason: 'external' }]);
  });

  test('finds a protocol-relative URL and a stylesheet link', () => {
    const found = findRemoteReferencesInHtml('<link rel="stylesheet" href="//fonts.example.com/site.css">');
    expect(found[0]).toMatchObject({ reason: 'external', where: 'link href' });
  });

  test('finds a URL inside an inline style and inside a <style> block', () => {
    const inline = findRemoteReferencesInHtml('<div style="background: url(http://example.com/x.png)">t</div>');
    expect(inline[0]).toMatchObject({ reference: 'http://example.com/x.png', reason: 'external' });
    const block = findRemoteReferencesInHtml(
      '<style>@import "https://example.com/base.css"; .a { background: url(//example.com/y.png) }</style>',
    );
    expect(block.map((entry) => entry.reference).sort()).toEqual([
      '//example.com/y.png',
      'https://example.com/base.css',
    ]);
  });

  test('finds every candidate of a srcset', () => {
    const found = findRemoteReferencesInHtml('<img srcset="http://a.example/1.png 1x, http://a.example/2.png 2x">');
    expect(found.map((entry) => entry.reference)).toEqual(['http://a.example/1.png', 'http://a.example/2.png']);
  });

  test('an absolute path is refused, because it names a file the document did not bring', () => {
    const found = findRemoteReferencesInHtml('<img src="/assets/logo.png">');
    expect(found).toEqual([{ reference: '/assets/logo.png', where: 'img src', reason: 'absolute' }]);
  });

  test('a path that walks out of the document is refused', () => {
    const found = findRemoteReferencesInHtml('<img src="../../staging/other-job/input/secret.pdf">');
    expect(found[0]?.reason).toBe('traversal');
  });

  test('any scheme is external, including one the engine can execute', () => {
    // `macro:///Standard.Module1.Main` is a URI this engine resolves and runs (`test:isolation` leg 4 executes one),
    // so the guard cannot be a list of web schemes: it is "a scheme at all is not a file beside the document".
    expect(findRemoteReferencesInHtml('<img src="macro:///Standard.Module1.Main">')).toEqual([
      { reference: 'macro:///Standard.Module1.Main', where: 'img src', reason: 'external' },
    ]);
    expect(findRemoteReferencesInHtml('<iframe src="file:///etc/passwd"></iframe>')[0]?.reason).toBe('external');
    expect(findRemoteReferencesInHtml('<img src="javascript:alert(1)">')[0]?.reason).toBe('external');
  });

  test('a hyperlink is not a fetch', () => {
    // The case that decides whether this guard is usable: an ordinary page links to the web. Nothing fetches it.
    expect(findRemoteReferencesInHtml('<a href="https://example.com/docs">Docs</a>')).toEqual([]);
  });

  test('a data URI is not a fetch, and a relative asset is not either', () => {
    expect(findRemoteReferencesInHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')).toEqual([]);
    expect(findRemoteReferencesInHtml('<img src="assets/logo.png"><link href="site.css">')).toEqual([]);
  });

  test('a URL written as text is not a reference', () => {
    expect(findRemoteReferencesInHtml('<p>See https://example.com/help for details.</p>')).toEqual([]);
  });

  test('the same URL twice is reported once', () => {
    const found = findRemoteReferencesInHtml('<img src="http://x/1.png"><img src="http://x/1.png">');
    expect(found).toHaveLength(1);
  });

  test('an attribute value containing > does not derail the scan', () => {
    const found = findRemoteReferencesInHtml('<img alt="a > b" src="http://x/1.png"><p>after</p>');
    expect(found).toEqual([{ reference: 'http://x/1.png', where: 'img src', reason: 'external' }]);
  });
});

describe('findRemoteReferencesInCss', () => {
  test('finds a url() and an @import, and leaves relative ones alone', () => {
    const css = [
      '@import "https://fonts.example.com/site.css";',
      '.hero { background-image: url(assets/hero.png); }',
      '.badge { background: url(data:image/svg+xml;base64,PHN2Zy8+); }',
      '.remote { background: url("http://images.example.com/bg.png"); }',
    ].join('\n');
    // `url(…)` matches are reported before `@import` ones, which is the order the two passes run in — and the
    // absence of the relative and `data:` entries is the half of this assertion that matters.
    expect(findRemoteReferencesInCss(css).map((entry) => entry.reference)).toEqual([
      'http://images.example.com/bg.png',
      'https://fonts.example.com/site.css',
    ]);
  });
});

describe('describeRemoteReferences', () => {
  test('names the reference, where it was, and what to do', () => {
    const message = describeRemoteReferences([
      { reference: 'http://x/1.png', where: 'img src', reason: 'external' },
      { reference: '/assets/2.png', where: 'img src', reason: 'absolute' },
    ]);
    expect(message).toContain('http://x/1.png');
    expect(message).toContain('img src');
    expect(message).toContain('1 more reference(s)');
    expect(message).toContain('relative to the HTML');
  });

  test('says which of the three reasons it refused for', () => {
    expect(
      describeRemoteReferences([{ reference: 'file:///etc/passwd', where: 'embed src', reason: 'absolute' }]),
    ).toContain('absolute path');
    expect(describeRemoteReferences([{ reference: '../x', where: 'img src', reason: 'traversal' }])).toContain(
      'walks out',
    );
  });
});
