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

// 배부 가능 상태 — 송고 훅(articleService)·tick(distributionTickService)·배부 실행(distributionService의
// 쓰기 직전 TOCTOU 가드)이 공유하는 **단일 출처**다(tick 전용 스캔 필터가 아니다 — 복제 금지).
// DES(배부 전 대기)·EPS(배부 진행)·DPS(완결·레거시)뿐이다.
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
 * 이미 배부된 kind 목록 — **"역사상 어디로 나갔나"**(정정본 대상 판정: 송고 훅).
 * distributionService가 실제 스풀 기록 1건 이상일 때만 남기는
 * (eventType='distribute', action=kind) 행이 "이미 배부됨"의 유일한 근거다.
 * 이력은 append-only라 과거 배부 사이클의 기록도 그대로 포함된다 — 그것이 이 함수의 의미다.
 * 이번 사이클 한정 판정이 필요하면 cycleDistributedKinds를 써라(두 함수는 서로를 대체하지 않는다).
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

// 사이클 경계가 적용되는 상태 — 재송고로 "새 배부 사이클"이 열리는 DES·EPS뿐.
// DPS(완결·레거시)는 전체 이력을 본다: 재송고 정정본 계약(phase 49)의 근거가
// "역사상 어디로 나갔나"이기 때문이다. 여기에 DPS를 넣으면 tick이 이미 배부된 수신처로
// 중복 배부한다(회수 불가) — 넣지 마라.
export const CYCLE_SCOPED_STATUSES = Object.freeze(['DES', 'EPS']);

/**
 * 사이클 경계 = 가장 최근 송고 이력의 id. 송고 이력은 상태 전이 직후 배부 훅보다 **먼저**
 * insert되므로(articleService.applyAction) 그 사이클의 배부는 전부 경계보다 뒤(id가 크다)에 남는다.
 * 정렬에 의존하지 않고 값으로만 최대를 고른다(호출자가 다른 정렬로 넘길 수 있다).
 * 시각(createdAt)은 쓰지 않는다 — 같은 밀리초 충돌·백필 데이터로 신뢰도가 낮고, 단조 증가하는
 * id가 유일하게 결정적인 순서다. id가 정수가 아닌 송고 행은 후보에서 제외한다(경계 미확정 → 전체 이력).
 * export하는 이유: 재전송(distributionRetryService)의 stale-cycle 게이트가 같은 경계를 써야 한다 —
 * 판정을 복제하면 사이클 어휘가 두 곳에서 갈라진다(cycleDistributedKinds와 단일 출처 공유).
 * @param {Array<object>} rows articleHistoryModel.queryByArticle() 결과(정렬 무관)
 * @returns {number|null} 경계 id, 확정 불가(송고 이력 없음·id 결손)면 null
 */
export function latestSendId(rows) {
  let boundaryId = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    if (r.eventType !== 'status' || r.action !== 'send') continue;
    if (!Number.isInteger(r.id)) continue;
    if (boundaryId === null || r.id > boundaryId) boundaryId = r.id;
  }
  return boundaryId;
}

/**
 * 이번 배부 사이클에서 이미 배부된 kind — **"이번 사이클에서 이미 보냈나"**(도래·완결 판정: tick·상태 승격).
 * 경계는 가장 최근 송고 이력(eventType==='status' && action==='send')이며, 그 행보다 뒤(id가 큰)
 * distribute 이력만 이번 사이클로 센다. 경계를 확정할 수 없으면 전체 이력을 센다(안전측 — 조기 배부 금지).
 * @param {object} [args]
 * @param {string} [args.status] 기사 현재 상태
 * @param {Array<object>} [args.historyRows] articleHistoryModel.queryByArticle() 결과(id DESC)
 * @returns {string[]} 중복 없는 kind 목록(항상 [press, nonpress] 순서)
 */
export function cycleDistributedKinds({ status, historyRows } = {}) {
  const rows = Array.isArray(historyRows) ? historyRows : [];
  // 경계 밖 상태(DPS·RDS·EEK…)는 전체 이력 판정 그대로다 — kind 필터링을 복제하지 않는다.
  if (!CYCLE_SCOPED_STATUSES.includes(status)) return distributedKinds(rows);

  const boundaryId = latestSendId(rows);
  // 경계 미확정(송고 이력 없음·id 결손) → 전체 이력을 센다. "배부 이력 없음"으로 폴백하면
  // 엠바고 시각 전 배부로 이어진다(회수 불가) — 모르면 항상 넓게 센다.
  if (boundaryId === null) return distributedKinds(rows);

  // CRITICAL(안전측 방향): id를 알 수 없는 distribute 행은 이번 사이클에 **포함해서** 센다.
  // 순진한 `r.id > boundaryId`는 undefined > n === false라 그 행을 빼는데, 그 방향은
  // "이미 배부됨"을 좁혀 조기 배부가 된다. 순서를 모르는 행은 항상 "센다" 쪽으로 처리한다.
  const inCycle = rows.filter(
    (r) => r && typeof r === 'object' && (!Number.isInteger(r.id) || r.id > boundaryId),
  );
  return distributedKinds(inCycle);
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
