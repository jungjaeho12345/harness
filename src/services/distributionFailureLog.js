// 배부 실패 원장 파생 — 순수 모듈(DB·HTTP·파일시스템·시계 비의존, embargoPolicy.js와 동형 관례).
// 답하는 질문은 둘뿐이다:
//   (1) 이 이벤트 행들에서 "아직 해소되지 않은 수신처 단위 실패"는 무엇인가 → unresolvedFailures
//   (2) 이 (articleId, targetId) 쌍에 미해소 실패가 있는가                → findUnresolvedFailure
// 답하지 않는 것: 조회·기록(호출자 책임), 재전송 실행, 인가, 시점 판정(dueKinds).
//
// 원장은 append-only다 — 행을 지우거나 갱신하지 않으므로 "해소됨"도 새 행(distribute-retry)으로만 표현한다.
// 미해소 판정: (articleId, targetId, action) 그룹에서 **id가 가장 큰 행**이
//   distribute-failed면 미해소, distribute-retry면 해소.
// 기각한 대안: "실패 행 이후 같은 kind의 distribute 행이 있으면 해소" 휴리스틱 —
//   한 distribute() 호출 안에서 kind 행이 실패 행보다 뒤에 기록되는 id 순서 불변식에 판정이 의존하게 되고,
//   그 순서가 깨지면 신선한 미발송이 조용히 사라진다(무음 실패). 과다 보고(안전 방향)를 택한다.

export const DISTRIBUTE_FAILED_EVENT = 'distribute-failed';
export const DISTRIBUTE_RETRY_EVENT = 'distribute-retry';

// 재전송으로 복구 가능한 실패 사유(단일 출처 — spoolWriter의 실제 반환 토큰 중 수신처 단위 실패만).
// status-changed는 담지 않는다 — 기사가 배부 불가로 전이된 안전 중단이라 재전송 대상이 아니고,
// 영속하면 영원히 해소되지 않는 항목이 된다. spool-disabled도 담지 않는다 —
// 배부 기능 자체가 꺼진 상태(설정 부재)이지 특정 수신처의 실패가 아니다.
export const RETRYABLE_FAILURE_REASONS = Object.freeze([
  'spool-write-failed',
  'invalid-spool-dir',
  'invalid-article-id',
]);

/**
 * 이 사유가 재전송으로 복구 가능한가.
 * @param {unknown} reason
 * @returns {boolean}
 */
export function isRetryableFailureReason(reason) {
  return typeof reason === 'string' && RETRYABLE_FAILURE_REASONS.includes(reason);
}

// targetId를 숫자로 정규화한다 — DB는 INTEGER지만 HTTP 경계에서 문자열이 올 수 있다.
// null/undefined/빈 문자열/비유한 값은 null(그 행은 판정에서 제외).
function normalizeTargetId(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// 판정에 참여할 수 있는 행인가 — 아닌 행은 조용히 무시한다(throw 금지, 판정 모듈이 호출자를 깨뜨리지 않는다).
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.eventType !== DISTRIBUTE_FAILED_EVENT && row.eventType !== DISTRIBUTE_RETRY_EVENT) return null;
  if (!Number.isInteger(row.id)) return null;
  if (typeof row.action !== 'string') return null;
  const targetId = normalizeTargetId(row.targetId);
  if (targetId === null) return null;
  return { row, targetId };
}

/**
 * 아직 해소되지 않은 수신처 단위 실패를 파생한다.
 * 같은 쌍에 실패가 여러 번 쌓여도 1건으로 접힌다(최신 실패의 사유·시각·historyId).
 * @param {Array<object>} rows articleHistoryModel.queryDistributionEvents() 결과(정렬 무관 — id로만 판정)
 * @returns {Array<{historyId:number, articleId:string, targetId:number, kind:string, reason:string|null, failedAt:string|null}>}
 *   최신 실패 우선(historyId DESC). 경로성 필드(spoolDir·file)는 절대 싣지 않는다 — 이 값은 HTTP 응답으로 나간다.
 */
export function unresolvedFailures(rows) {
  const input = Array.isArray(rows) ? rows : [];
  // 그룹 키 (articleId, targetId, action) → 그 그룹에서 id가 가장 큰 행.
  const latestByGroup = new Map();
  for (const raw of input) {
    const norm = normalizeRow(raw);
    if (!norm) continue;
    const key = `${norm.row.articleId}\u0000${norm.targetId}\u0000${norm.row.action}`;
    const prev = latestByGroup.get(key);
    if (!prev || norm.row.id > prev.row.id) latestByGroup.set(key, norm);
  }

  const items = [];
  for (const { row, targetId } of latestByGroup.values()) {
    if (row.eventType !== DISTRIBUTE_FAILED_EVENT) continue; // 최신이 retry → 해소
    items.push({
      historyId: row.id,
      articleId: row.articleId,
      targetId,
      kind: row.action,
      reason: row.reason ?? null,
      failedAt: row.createdAt ?? null,
    });
  }
  items.sort((a, b) => b.historyId - a.historyId);
  return items;
}

/**
 * 이 (articleId, targetId) 쌍의 미해소 실패 항목. 없으면 null.
 * 그룹 키는 (articleId, targetId, action) 3원소라 같은 쌍에 kind 2종이 동시에 미해소일 수 있다 —
 * 그중 historyId가 가장 큰(가장 최근) 항목 1건을 돌려준다. kind는 인자로 받지 않는다
 * (클라이언트가 kind를 고르면 안 된다 — 배부 kind는 실패 이력에서만 도출).
 * @param {Array<object>} rows
 * @param {{articleId?:unknown, targetId?:unknown}} [query]
 * @returns {object|null}
 */
export function findUnresolvedFailure(rows, { articleId, targetId } = {}) {
  const tid = normalizeTargetId(targetId);
  if (tid === null) return null;
  // 판정 규칙을 복제하지 않는다 — 두 곳이 갈라지면 인가 우회가 된다.
  const items = unresolvedFailures(rows);
  // 반환은 historyId DESC 정렬이므로 첫 매치가 가장 최근 항목이다.
  return items.find((it) => it.articleId === articleId && it.targetId === tid) ?? null;
}
