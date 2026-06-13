// 상세보기 데이터 구성 (news.md 상세보기).
// 상단: 공통정보를 가로로 나열(빈 필드는 '—'). 하단: 본문 블록을 저장된 순서대로 하나의 영역에.
// 본문 첫 줄이 곧 제목이므로 별도 제목 요소는 두지 않는다. 창 제목은 기사 제목(없으면 '(제목 없음)').
// CRITICAL: 모든 내용은 HTML 이스케이프되어 스크립트가 실행되지 않는다.

import { deserialize, isEmbedBlock } from './editorContent.js';

export const EMPTY_FIELD = '—';
const NO_TITLE = '(제목 없음)';

// 공통정보 — 가로 나열 순서(news.md). 엠바고/2차 엠바고 시간 포함.
export const DETAIL_COMMON_FIELDS = Object.freeze([
  { key: 'author', label: '작성자' },
  { key: 'coAuthor', label: '공동작성' },
  { key: 'content', label: '내용' },
  { key: 'region', label: '지역' },
  { key: 'attribute', label: '속성' },
  { key: 'keyword', label: '키워드' },
  { key: 'internalComment', label: '내부코멘트' },
  { key: 'externalComment', label: '외부코멘트' },
  { key: 'attachmentFile', label: '첨부파일' },
  { key: 'referenceFile', label: '자료파일' },
  { key: 'embargoAt', label: '엠바고 시간' },
  { key: 'secondEmbargoAt', label: '2차 엠바고 시간' },
]);

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fieldValue(v) {
  return (v === undefined || v === null || v === '') ? EMPTY_FIELD : String(v);
}

// 상세보기 구조 데이터(공통정보 + 본문 블록 + 창 제목). 컴포넌트/새창 렌더 양쪽이 쓴다.
export function buildDetail(article = {}) {
  const common = DETAIL_COMMON_FIELDS.map(({ key, label }) => ({
    key, label, value: fieldValue(article[key]),
  }));
  const blocks = deserialize(article.markupVersion ?? article.body ?? article.content ?? '');
  const windowTitle = article.title ? String(article.title) : NO_TITLE;
  return { common, blocks, windowTitle };
}

// 상세보기 새 창에 write할 HTML 문서 문자열 — 모든 값 이스케이프(스크립트 실행 불가).
export function renderDetailHtml(article = {}) {
  const { common, blocks, windowTitle } = buildDetail(article);

  const commonHtml = common
    .map((f) => `<div class="yh-detail__field"><dt>${escapeHtml(f.label)}</dt>`
      + `<dd>${escapeHtml(f.value)}</dd></div>`)
    .join('');

  const bodyHtml = blocks
    .map((b) => {
      if (isEmbedBlock(b)) {
        const label = b.embedType === 'article' ? (b.title ?? '') : (b.src ?? b.title ?? '');
        return `<figure class="yh-detail__embed" data-embed-type="${escapeHtml(b.embedType)}">`
          + `${escapeHtml(label)}</figure>`;
      }
      return `<p class="yh-detail__line">${escapeHtml(b.text)}</p>`;
    })
    .join('');

  return '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
    + `<title>${escapeHtml(windowTitle)}</title></head><body>`
    + `<dl class="yh-detail__common">${commonHtml}</dl>`
    + `<section class="yh-detail__body">${bodyHtml}</section>`
    + '</body></html>';
}
