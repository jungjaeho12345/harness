// 이력보기/송고이력보기 새 창 HTML 렌더 (news.md 우클릭 컨텍스트 메뉴 이력보기).
// 이력 항목을 시간순 목록으로(발생시각·이벤트 종류·행위자·상태전이 from→to) 보여준다.
// CRITICAL: 모든 값은 HTML 이스케이프되어 새 창에서 스크립트가 실행되지 않는다(저장된 제목/행위자에 스크립트가 섞여도 안전).

import { escapeHtml } from './articleDetail.js';

const KIND_LABEL = { history: '이력', sendHistory: '송고이력' };
const EMPTY_FIELD = '—';

function field(v) {
  return (v === undefined || v === null || v === '') ? EMPTY_FIELD : String(v);
}

function rowHtml(entry = {}) {
  const time = escapeHtml(field(entry.createdAt));
  const event = escapeHtml(field(entry.eventType));
  const actor = escapeHtml(field(entry.actorUserId));
  const role = escapeHtml(field(entry.actorRole));
  const from = escapeHtml(field(entry.fromStatus));
  const to = escapeHtml(field(entry.toStatus));
  return '<tr class="yh-history__row">'
    + `<td class="yh-history__time">${time}</td>`
    + `<td class="yh-history__event">${event}</td>`
    + `<td class="yh-history__actor">${actor} (${role})</td>`
    + `<td class="yh-history__transition">${from} → ${to}</td>`
    + '</tr>';
}

// 이력 목록을 새 창에 write할 HTML 문서 문자열 — 모든 값 이스케이프(스크립트 실행 불가).
export function renderHistoryHtml(items = [], { title, kind = 'history' } = {}) {
  const kindLabel = KIND_LABEL[kind] || KIND_LABEL.history;
  const windowTitle = `${field(title)} ${kindLabel}`;

  const body = (items && items.length)
    ? '<table class="yh-history__table"><thead><tr>'
      + '<th>발생시각</th><th>이벤트</th><th>행위자</th><th>상태전이</th>'
      + '</tr></thead><tbody>'
      + items.map(rowHtml).join('')
      + '</tbody></table>'
    : '<p class="yh-history__empty">이력이 없습니다.</p>';

  return '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
    + `<title>${escapeHtml(windowTitle)}</title></head><body>`
    + `<h1 class="yh-history__title">${escapeHtml(windowTitle)}</h1>`
    + `<section class="yh-history">${body}</section>`
    + '</body></html>';
}
