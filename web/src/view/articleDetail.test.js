import { describe, it, expect } from 'vitest';
import {
  EMPTY_FIELD, DETAIL_COMMON_FIELDS, escapeHtml, buildDetail, renderDetailHtml,
} from './articleDetail.js';
import { serialize, textBlock, embedBlock } from './editorContent.js';

describe('articleDetail — data construction', () => {
  it('lists the common-info fields horizontally with empty fields as "—"', () => {
    const { common } = buildDetail({ author: '김기자', region: '' });
    const author = common.find((f) => f.key === 'author');
    const region = common.find((f) => f.key === 'region');
    expect(author.value).toBe('김기자');
    expect(region.value).toBe(EMPTY_FIELD);
    expect(common).toHaveLength(DETAIL_COMMON_FIELDS.length);
  });

  it('keeps body block order from markupVersion', () => {
    const markupVersion = serialize([textBlock('제목'), embedBlock({ embedType: 'image', src: 'x' }), textBlock('본문')]);
    const { blocks } = buildDetail({ markupVersion });
    expect(blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text']);
  });

  it('window title falls back to "(제목 없음)"', () => {
    expect(buildDetail({ title: '제목있음' }).windowTitle).toBe('제목있음');
    expect(buildDetail({}).windowTitle).toBe('(제목 없음)');
  });
});

describe('articleDetail — HTML escaping', () => {
  it('escapeHtml neutralizes script-bearing markup', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renderDetailHtml escapes title, common fields and body (no executable script)', () => {
    const markupVersion = serialize([textBlock('<img src=x onerror=alert(1)>')]);
    const html = renderDetailHtml({
      title: '<script>evil()</script>',
      author: '<b>kim</b>',
      markupVersion,
    });
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;kim&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
