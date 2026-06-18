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

describe('articleDetail — embed media rendering', () => {
  it('renders an <img> (not the raw src text) for an allowed image embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'image', src: '/uploads/abc.png', alt: '사진' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('<img');
    expect(html).toContain('src="/uploads/abc.png"');
    expect(html).toContain('alt="사진"');
  });

  it('renders an <img> for a data:image/ embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'image', src: 'data:image/png;base64,AAAA' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('<img');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it('does not render an <img> nor leak the raw src for a disallowed image scheme', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'image', src: 'javascript:alert(1)' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:alert(1)');
  });

  it('renders a canonical YouTube <iframe> for a video embed', () => {
    const markupVersion = serialize([embedBlock({
      embedType: 'video', videoId: 'dQw4w9WgXcQ', src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('<iframe');
    expect(html).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
  });

  it('renders the title text (no media) for an article reference embed', () => {
    const markupVersion = serialize([embedBlock({ embedType: 'article', articleId: 'AKR9', title: '참조기사' })]);
    const html = renderDetailHtml({ markupVersion });
    expect(html).toContain('참조기사');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<iframe');
  });
});
