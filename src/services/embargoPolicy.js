// 엠바고 배부 판정 규칙 — 순수 모듈(DB·HTTP·파일시스템·타이머 비의존, lifecycle.js와 동형 관례).
// 답하는 질문은 둘뿐이다:
//   (1) 지금 이 기사에서 어떤 kind를 배부해야 하는가        → dueKinds
//   (2) 배부 이력이 이러할 때 상태는 무엇이어야 하는가       → embargoStatusFor
// 조회·쓰기·주기 실행은 전부 호출자(tick 서비스)의 책임이다 — ADR-008 (3): 시점 배부는 외부 cron의
// tick pull이며 앱 안에 타이머를 두지 않는다. 여기에 new Date()를 두지 않는 이유도 같다(now는 항상 인자).
//
// news.md "엠바고 규칙"의 직역이며 임의 확장은 없다:
//   - 1차 엠바고 시각 → 언론사(press)
//   - 2차 엠바고 시각 → 비언론사(nonpress), 단 송고 시 바로 언론사(press)  ← 송고 훅의 책임(여기 아님)
//   - 1+2차 → 1차 시각에 press, 2차 시각에 nonpress

// 엠바고 tick이 배부를 허용하는 상태. DES(배부 전 대기)·EPS(배부 진행)·DPS(완결·레거시)뿐이다.
// CRITICAL: RDS(미송고)·RRH·RRK·DDH·DDK(보류/킬)·EEK·EEH(엠바고 킬/보류)·DPD(삭제 승인)는 전부 제외다.
// 외부 수신처로 한 번 나간 기사는 회수 수단이 없으므로, 이 게이트가 유일한 방어선이다.
export const EMBARGO_DISTRIBUTABLE_STATUSES = Object.freeze(['DES', 'EPS', 'DPS']);

// 상태 계산이 개입할 수 있는 현재 상태. 그 외(DPS 완결·EEK·EEH·DPD·RDS…)는 절대 건드리지 않는다.
const MUTABLE_STATUSES = new Set(['DES', 'EPS']);

// 배부 kind ↔ 엠바고 필드. 반환 순서(press → nonpress)의 단일 출처이기도 하다.
const KIND_FIELDS = Object.freeze([
  Object.freeze({ kind: 'press', field: 'embargoAt' }),      // 1차 엠바고 = 언론사
  Object.freeze({ kind: 'nonpress', field: 'secondEmbargoAt' }), // 2차 엠바고 = 비언론사
]);

const KINDS = Object.freeze(KIND_FIELDS.map((f) => f.kind));

// 객체가 아닌 입력(null·문자열·undefined)에도 throw하지 않는다 — 판정 모듈이 호출자를 깨뜨리지 않게.
function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

/**
 * ISO-8601 문자열을 epoch ms로 파싱한다. 파싱 불가면 null.
 * 문자열만 받는다 — SCHEMA.md:48("시간 컬럼은 ISO-8601 UTC 문자열")과 같은 타입 계약이다.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseInstant(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// distributed 인자를 유효 kind 집합으로 정규화한다(비배열·미지 값은 버린다).
function toKindSet(distributed) {
  const list = Array.isArray(distributed) ? distributed : [];
  return new Set(KINDS.filter((k) => list.includes(k)));
}

/**
 * 이 기사의 엠바고 배부가 "완결"되려면 어떤 kind가 필요한가.
 * 2차만 설정된 기사의 송고 즉시 press 배부는 완결 요건이 아니다(2차 배부 후에 완결).
 * @param {object} [contents] Contents 행
 * @returns {string[]} ['press','nonpress'] 부분집합(항상 이 순서)
 */
export function requiredKinds(contents = {}) {
  const c = asObject(contents);
  return KIND_FIELDS.filter(({ field }) => Boolean(c[field])).map(({ kind }) => kind);
}

/**
 * 이미 배부된 kind 목록. distributionService가 실제 스풀 기록 1건 이상일 때만 남기는
 * (eventType='distribute', action=kind) 행이 "이미 배부됨"의 유일한 근거다.
 * @param {Array<object>} [historyRows] articleHistoryModel.queryByArticle() 결과(최신순)
 * @returns {string[]} 중복 없는 kind 목록(항상 [press, nonpress] 순서)
 */
export function distributedKinds(historyRows = []) {
  const rows = Array.isArray(historyRows) ? historyRows : [];
  const seen = new Set(
    rows
      .filter((r) => r && typeof r === 'object' && r.eventType === 'distribute')
      .map((r) => r.action),
  );
  // 이력은 id DESC로 오므로 수집 순서가 아니라 KINDS 순서로 고정한다(단언 안정성).
  return KINDS.filter((k) => seen.has(k));
}

/**
 * 값이 있으나 파싱할 수 없는 엠바고 필드명. 엠바고 시각 입력란은 자유 텍스트라 오타가 들어올 수 있고,
 * 그런 값은 배부되지 않으므로(안전 기본값) 호출자가 표면화할 수 있어야 한다 — 무음 삼킴 금지.
 * @param {object} [contents]
 * @returns {string[]} ['embargoAt','secondEmbargoAt'] 부분집합(항상 이 순서)
 */
export function unparsableEmbargoFields(contents = {}) {
  const c = asObject(contents);
  return KIND_FIELDS
    .filter(({ field }) => Boolean(c[field]) && parseInstant(c[field]) === null)
    .map(({ field }) => field);
}

/**
 * 지금 배부해야 할 kind. 도래하지 않았거나 이미 배부됐거나 파싱 불가면 배부하지 않는다(안전 기본값).
 * @param {object} [args]
 * @param {string} [args.status] 기사 상태
 * @param {object} [args.contents] Contents 행
 * @param {string[]} [args.distributed] 이미 배부된 kind(= distributedKinds 결과)
 * @param {string} args.now 현재 시각 — **ISO-8601 UTC 문자열**(숫자 epoch ms 금지).
 *   숫자를 허용하면 Date.parse(숫자)=NaN → 전 기사가 조용히 미도래로 떨어져 엠바고가
 *   영원히 배부되지 않는다. 계약 위반 시 안전하게 [](미배부)를 반환한다.
 * @returns {string[]} 배부할 kind(항상 [press, nonpress] 순서)
 */
export function dueKinds({ status, contents, distributed = [], now } = {}) {
  if (!EMBARGO_DISTRIBUTABLE_STATUSES.includes(status)) return [];

  const nowMs = parseInstant(now);
  if (nowMs === null) return []; // 잘못된 시계로 조기 배부하지 않는다.

  const c = asObject(contents);
  const done = toKindSet(distributed);

  return KIND_FIELDS
    .filter(({ kind, field }) => {
      if (done.has(kind)) return false; // 멱등 — tick 중복 호출에도 재배부하지 않는다.
      const at = parseInstant(c[field]);
      return at !== null && at <= nowMs;
    })
    .map(({ kind }) => kind);
}

/**
 * 배부 이력에 비춰 기사 상태가 무엇이어야 하는가. 바꿀 필요가 없으면 null.
 * 완결(required ⊆ distributed) → DPS, 1건 이상 배부 → EPS, 아니면 DES.
 * 1차만 설정된 기사가 DES에서 곧장 DPS가 되는 것은 의도된 결과다(같은 배부가 첫 배부이자 완결).
 * @param {object} [args]
 * @param {string} [args.status] 현재 상태
 * @param {object} [args.contents]
 * @param {string[]} [args.distributed]
 * @returns {'DES'|'EPS'|'DPS'|null}
 */
export function embargoStatusFor({ status, contents, distributed = [] } = {}) {
  const required = requiredKinds(contents);
  if (required.length === 0) return null; // 엠바고 미설정 — 이 모듈은 관여하지 않는다.
  // DPS(완결·레거시)·EEK·EEH·DPD·RDS 등은 건드리지 않는다. 상태 역행/부활 금지.
  if (!MUTABLE_STATUSES.has(status)) return null;

  const done = toKindSet(distributed);
  const next = required.every((k) => done.has(k)) ? 'DPS'
    : done.size > 0 ? 'EPS'
      : 'DES';

  if (next === status) return null; // 무의미한 쓰기 금지.
  if (status === 'EPS' && next === 'DES') return null; // 역행 금지(이력 유실·부분 실패로 뒤로 가지 않는다).
  return next;
}
