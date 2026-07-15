import { describe, it, expect } from 'vitest';
import { buildPrintArticle, renderPrintHtml } from './printDocument.js';
import {
  serialize, deserialize, textBlock, blocksToText,
} from './editorContent.js';

// 편집 탭(WriterPage tab) 형태의 최소 스텁 — fields(공통정보+직렬화 본문)/readOnly(메타).
function tabOf(fields = {}, readOnly = {}) {
  return { fields, readOnly };
}

describe('printDocument — buildPrintArticle', () => {
  it('tab.fields의 공통정보·제목을 그대로 담고 markupVersion은 현재 본문(블록)에서 나온 문자열이다', () => {
    const body = serialize([textBlock('헤드라인'), textBlock('본문 첫 문단')]);
    const fields = {
      title: '헤드라인', author: '김기자', region: '서울', category: '정치',
      attribute: '단신', keyword: '키워드', body,
    };
    const article = buildPrintArticle(tabOf(fields, { articleId: 'AKR1' }));

    // 공통정보/제목이 그대로 담긴다.
    expect(article.title).toBe('헤드라인');
    expect(article.author).toBe('김기자');
    expect(article.region).toBe('서울');
    expect(article.category).toBe('정치');
    expect(article.attribute).toBe('단신');
    expect(article.keyword).toBe('키워드');
    // 읽기전용 메타도 포함(가로 나열 상세보기 원본).
    expect(article.articleId).toBe('AKR1');
    // markupVersion은 현재 본문(블록)에서 나온 문자열.
    expect(typeof article.markupVersion).toBe('string');
    expect(blocksToText(deserialize(article.markupVersion))).toBe('헤드라인\n본문 첫 문단');
  });

  it('빈/결손 탭에서도 예외 없이 article-형태를 만든다(markupVersion은 빈 본문)', () => {
    expect(() => buildPrintArticle(undefined)).not.toThrow();
    const a = buildPrintArticle(undefined);
    expect(typeof a.markupVersion).toBe('string');
    expect(deserialize(a.markupVersion)).toEqual([]); // 빈 본문
    // 빈 fields 탭도 방어.
    expect(() => buildPrintArticle({ fields: {} })).not.toThrow();
  });
});

describe('printDocument — renderPrintHtml', () => {
  it('제목/본문 텍스트를 포함한 완전한 HTML 문서(<!doctype html> … </html>)를 반환한다', () => {
    const body = serialize([textBlock('제목줄'), textBlock('본문줄')]);
    const html = renderPrintHtml(tabOf({ title: '제목줄', body }), {});

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trim().endsWith('</html>')).toBe(true);
    expect(html).toContain('제목줄');
    expect(html).toContain('본문줄');
  });

  // XSS 회귀 잠금(핵심) — 이스케이프 우회가 없음을 못박는다.
  it('제목/작성자/본문의 <script>가 이스케이프되어 리터럴 <script>가 아니라 &lt;script&gt;로 나타난다', () => {
    const body = serialize([textBlock('<script>alert(1)</script>')]);
    const html = renderPrintHtml(
      tabOf({
        title: '<script>alert("t")</script>',
        author: '<script>alert("a")</script>',
        body,
      }),
      {},
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('빈/결손 탭에서도 예외 없이 렌더된다', () => {
    expect(() => renderPrintHtml(undefined, {})).not.toThrow();
    const html = renderPrintHtml(undefined, {});
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });
});
