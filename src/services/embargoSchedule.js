// 엠바고 시점 배부 규칙 — 순수 함수 (HTTP/DB/FS 비의존). 현재 시각은 항상 인자로 받는다.
// news.md "엠바고 규칙"(256~263행)의 직역이며, ADR-008 (3)(5)의 판정 근거를 한곳에 모은다.
//
//   1차만   → 1차 시각에 언론사(press). 완결에 필요한 배부: press
//   2차만   → 송고 시 언론사(press, phase 47 송고 훅) + 2차 시각에 비언론사(nonpress).
//             완결에 필요한 배부: press + nonpress (press는 tick의 배부 대상이 아니다 — 이미 송고 시 나갔다)
//   1+2차   → 1차 시각 press, 2차 시각 nonpress. 완결: press + nonpress
//   없음    → 시점 배부 대상이 아니다(송고 즉시 DPS — phase 47)
//
// CRITICAL: 여기에 타이머(setInterval/setTimeout)를 두지 않는다. 주기 실행은 외부 운영 루틴의 tick pull이다(ADR-008 (3)).
// CRITICAL: 판정 불가한 엠바고 값은 "도래"로 수렴시키지 않는다 — 잘못 나간 기사는 회수할 수 없다.

// 배부 종류의 단일 출처(순서 고정: press 우선). 이력의 action 값도 이 allowlist로만 받는다.
export const DISTRIBUTION_KINDS = ['press', 'nonpress'];

// 시각 문자열 → epoch ms. 명시적 오프셋(Z 또는 ±hh:mm)이 있는 ISO-8601만 유효, 그 외는 null(= 미도래).
// 사전식 문자열 비교를 쓰지 않는 이유: 엠바고 입력은 자유 텍스트라 포맷이 섞일 수 있고,
// 사전식 비교는 포맷이 다른 순간 순서가 뒤집혀 엠바고 전 기사를 외부로 내보낸다.
// Date.parse를 그대로 신뢰하지 않는 이유: 값 형식별로 타임존 해석이 갈린다 —
// 날짜만('2026-07-30')은 UTC 자정으로, 오프셋 없는 값('…T15:00')은 서버 로컬로 해석되어
// 같은 입력이 서버 TZ에 따라 다른 시각(KST 기준 최대 9시간 조기 반출)이 된다.
// 판정 불가한 값은 도래로 수렴시키지 않는다(파일 상단 CRITICAL — 잘못 나간 기사는 회수 불가).
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function toEpoch(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!ISO_WITH_OFFSET.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

// 엠바고 유형별로 "완결(EPS→DPS)에 필요한" 배부 종류.
// 2차만인 기사에 press가 포함되는 이유: 송고 시 언론사 배부가 규칙의 일부이기 때문이다(news.md 259행).
// 그 배부가 실패해 이력이 없으면 완결이 아니다 — 사실이 아닌 완결을 만들지 않는다.
export function requiredKinds(contents = {}) {
  const first = toEpoch(contents.embargoAt);
  const second = toEpoch(contents.secondEmbargoAt);
  if (first !== null && second !== null) return ['press', 'nonpress'];
  if (first !== null) return ['press'];
  if (second !== null) return ['press', 'nonpress'];
  return [];
}

// 지금(nowIso) 시각 기준으로 배부 시각이 도래한 종류. 경계(같은 시각)는 도래로 본다.
// 2차만인 기사의 press는 여기에 포함되지 않는다 — 송고 훅이 이미 처리했고, tick이 또 보내면 중복 반출이다
// (실패한 송고 시 배부의 재전송은 MVP-4 범위).
export function dueKinds(contents = {}, nowIso) {
  const now = toEpoch(nowIso);
  if (now === null) return [];

  const out = [];
  const first = toEpoch(contents.embargoAt);
  if (first !== null && now >= first) out.push('press');
  const second = toEpoch(contents.secondEmbargoAt);
  if (second !== null && now >= second) out.push('nonpress');
  return out;
}

// 이력에서 이미 배부된 종류를 뽑는다 — distributionService가 남긴 { eventType:'distribute', action:kind } 행만 본다.
// 송고 이력(eventType='status')이나 편집 이력은 배부 근거가 아니다.
export function distributedKinds(historyRows = []) {
  if (!Array.isArray(historyRows)) return [];
  const found = new Set();
  for (const row of historyRows) {
    if (!row || row.eventType !== 'distribute') continue;
    // action을 그대로 신뢰하지 않는다(allowlist) — 임의 값이 배부 대상 kind로 흘러가면 안 된다.
    if (DISTRIBUTION_KINDS.includes(row.action)) found.add(row.action);
  }
  return DISTRIBUTION_KINDS.filter((k) => found.has(k));
}

// 지금 배부해야 하는 종류 = 시각 도래분 − 이미 배부된 분.
// tick은 외부 루틴이 반복 호출하므로 이 차집합이 멱등성의 핵심이다.
export function pendingKinds(contents = {}, historyRows = [], nowIso) {
  const done = new Set(distributedKinds(historyRows));
  return dueKinds(contents, nowIso).filter((k) => !done.has(k));
}

// 완결 판정 — 근거는 오직 ArticleHistory의 배부 이력이다(ADR-008 (5)). 시각 비교로 판정하지 않는다.
// 엠바고가 없는 기사(required 빈 배열)는 판정 대상이 아니다(false) — EPS가 아닌 기사를 건드리지 않기 위함.
export function isEmbargoComplete(contents = {}, historyRows = []) {
  const required = requiredKinds(contents);
  if (required.length === 0) return false;
  const done = new Set(distributedKinds(historyRows));
  return required.every((k) => done.has(k));
}
