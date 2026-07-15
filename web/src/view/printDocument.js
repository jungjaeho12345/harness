// 파일 메뉴 인쇄/인쇄미리보기용 순수 헬퍼 (news.md 파일 메뉴: 인쇄, 인쇄미리보기).
// 현재 편집 탭을 상세보기(renderDetailHtml)가 먹는 article-형태로 매핑하고 인쇄 HTML 문자열만 만든다.
// CRITICAL: HTML은 오직 renderDetailHtml 경유로만 만든다 — 모든 사용자 값이 escapeHtml을 거쳐
//   새 창(document.write) 싱크에서 스크립트가 실행되지 않는다(발행/상세보기 XSS 이중차단, ListPage.openDetail 동형).
// 순수 모듈 — model/fetch/window/document 미접촉. 새 창 열기/print()는 WriterPage 얇은 배선에만 둔다(테스트 가능성·순수성).

import { renderDetailHtml } from './articleDetail.js';
import { serialize, deserialize } from './editorContent.js';

// 현재 편집 탭 → renderDetailHtml이 먹는 article-형태. 공통정보(fields)·읽기전용 메타(readOnly)를 그대로 담고,
// markupVersion은 현재 본문(tab.fields.body: 직렬화 문자열)을 블록 정규화해 반영한다(레거시 평문도 deserialize가 흡수).
// tab/필드 결손(undefined 등)에도 죽지 않게 방어한다 — 빈 값은 상세보기가 '—'/빈 본문으로 렌더한다.
export function buildPrintArticle(tab) {
  const fields = (tab && tab.fields) || {};
  const readOnly = (tab && tab.readOnly) || {};
  return {
    ...fields,
    ...readOnly,
    markupVersion: serialize(deserialize(fields.body ?? '')),
  };
}

// 인쇄 HTML 문서 문자열 — 반드시 renderDetailHtml 경유(이스케이프 보존). 필드값을 직접 문자열 연결하지 않는다.
export function renderPrintHtml(tab, byline) {
  return renderDetailHtml(buildPrintArticle(tab), byline);
}
