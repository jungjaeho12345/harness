// 시점 배부(tick) 판정 — 순수 함수. DB/FS/타이머/네트워크 의존 0 (ADR-008: 앱 내 타이머 금지).
// distributionKindsForSend(articleService)의 "시점 배부판" 대응물이다. now는 반드시 주입받는다(결정적).
//
// news.md "엠바고 규칙"의 직역:
//   1차 엠바고(embargoAt) 시각 → 언론사(press) 배부
//   2차 엠바고(secondEmbargoAt) 시각 → 비언론사(nonpress) 배부 (송고 시 언론사는 이미 즉시 배부됨)
//   1+2차 → 1차 시각에 press, 2차 시각에 nonpress
// 엠바고 유형은 두 시각 컬럼의 "설정 여부"로만 도출한다(별도 유형 컬럼 없음 — DB 비파괴).

const PRESS = 'press';
const NONPRESS = 'nonpress';

// distributedKinds를 Set으로 정규화한다(호출자가 Set/배열 아무거나 넘겨도 되게).
function toSet(distributedKinds) {
  if (distributedKinds instanceof Set) return distributedKinds;
  return new Set(Array.isArray(distributedKinds) ? distributedKinds : []);
}

// 설정된(truthy) 시각이 now 이하로 도래했는가. 파싱 불가(빈값·비ISO·미설정)면 false(안전측 — 조기 배부 금지).
function reached(when, nowISO) {
  if (!when) return false;
  const t = Date.parse(when);
  const n = Date.parse(nowISO);
  if (Number.isNaN(t) || Number.isNaN(n)) return false;
  return t <= n;
}

// 각 kind가 required인지 — press ⇔ 1차 설정, nonpress ⇔ 2차 설정.
function pressRequired(contents) {
  return !!(contents && contents.embargoAt);
}
function nonpressRequired(contents) {
  return !!(contents && contents.secondEmbargoAt);
}

// 지금(nowISO) 배부해야 하는 kind 목록. 이미 배부된 kind·시각 미도래 kind는 제외한다.
// 반환 순서는 [press, nonpress] 고정.
export function dueDistributionKinds(contents = {}, distributedKinds = [], nowISO = '') {
  const done = toSet(distributedKinds);
  const due = [];
  if (pressRequired(contents) && !done.has(PRESS) && reached(contents.embargoAt, nowISO)) {
    due.push(PRESS);
  }
  if (nonpressRequired(contents) && !done.has(NONPRESS) && reached(contents.secondEmbargoAt, nowISO)) {
    due.push(NONPRESS);
  }
  return due;
}

// 엠바고 배부가 전부 완결되었는가(EPS→DPS 전이 조건).
// required kind(press⇔1차, nonpress⇔2차)가 모두 배부 이력에 있으면 true.
// 2차만 기사의 press는 required가 아니다(송고 즉시 배부분) — nonpress만 채워지면 완결이다.
// 비-엠바고(둘 다 미설정) 기사는 required가 비므로 false(애초에 EPS가 아니라 전이 대상이 아님 — 오전이 방지).
export function isEmbargoComplete(contents = {}, distributedKinds = []) {
  const done = toSet(distributedKinds);
  const required = [];
  if (pressRequired(contents)) required.push(PRESS);
  if (nonpressRequired(contents)) required.push(NONPRESS);
  if (required.length === 0) return false;
  return required.every((k) => done.has(k));
}
