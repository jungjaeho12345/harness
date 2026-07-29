// 엠바고 배부 tick 규칙의 단일 출처 — 순수 함수만(부수효과·외부 의존·시계 접근 0).
// "지금 이 기사에 어떤 배부가 도래했는가 / 완결까지 무엇이 남았는가"만 판정한다.
// 상태 전이(EPS→DPS)·배부 실행은 하지 않는다(step1 tick 서비스의 책임). 시각(nowMs)은 항상 인자로 받는다.
//
// CRITICAL: 시각 비교는 epoch(Date.parse) 기반으로만 한다. 문자열 사전식 비교(a < b)는
// 오프셋/포맷이 섞이면 엠바고 시각 '전'에 도래로 판정되어 조기 반출(되돌릴 수 없는 사고)을 일으킨다.
// 파싱 실패·오프셋 없는 값은 항상 "도래 아님"으로 수렴한다(fail-safe) — 잘못된 입력이 즉시 반출로 이어지지 않게.
//
// 존재 판정은 관대하게, 시각 파싱은 엄격하게:
//  - requiredKinds(완결 요건)의 "설정됨" 판정은 관대(쓰레기 값도 설정으로 봄) → 배부 없이 완결되는 것을 막는다.
//  - isDue(도래) 판정은 엄격(오프셋 있는 파싱 가능 값만) → 쓰레기 값은 "required이되 영원히 due 아님"이 되어 EPS에 머문다.

// 명시적 타임존 오프셋으로 끝나는지 검사한다: Z/z, +HH:MM, -HH:MM, +HHMM, -HHMM.
// 오프셋이 없는 값('2026-07-30T09:00')은 런타임 로컬 시각으로 해석되어 서버 TZ에 따라 조기 반출될 수 있으므로 거부한다.
const TZ_OFFSET = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

// kind ↔ 엠바고 컬럼 매핑. 순서 고정(테스트 결정성): press가 항상 먼저.
//  - press    : 1차 엠바고(embargoAt) — 언론사 배부.
//  - nonpress : 2차 엠바고(secondEmbargoAt) — 비언론사 배부.
// 주의: "2차만 설정된 기사"의 press는 여기에 없다. 그 언론사 배부는 송고 훅
// (articleService.distributionKindsForSend → ['press'])이 이미 즉시 수행했으므로 tick 대상이 아니다(중복 반출 금지).
const KIND_FIELD = [
  ['press', 'embargoAt'],
  ['nonpress', 'secondEmbargoAt'],
];

// 값이 "설정되어 있음"인지 — 관대한 존재 판정. null/undefined가 아니고 문자열화 후 trim이 비어있지 않으면 설정으로 본다.
// 쓰레기 값('곧')도 설정으로 흡수해 required에 남긴다(fail-safe) — 반대로 하면 배부 없이 완결될 수 있다.
function isPresent(value) {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== '';
}

// 문자열 시각을 epoch ms로 파싱한다 — 실패는 전부 null(강제변환 금지).
export function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // 명시적 오프셋이 없으면 로컬 해석 위험 → null.
  if (!TZ_OFFSET.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

// value가 nowMs 시점에 도래했는가. 파싱 불가/비수 nowMs는 항상 false(도래 아님으로 수렴).
export function isDue(value, nowMs) {
  if (!Number.isFinite(nowMs)) return false;
  const instant = parseInstant(value);
  if (instant === null) return false;
  return instant <= nowMs; // 동시각 = 도래.
}

// tick이 책임지는 kind 집합(완결 요건). 순서는 항상 [press, nonpress] 기준.
export function requiredKinds(contents) {
  if (contents === null || typeof contents !== 'object') return [];
  const out = [];
  for (const [kind, field] of KIND_FIELD) {
    if (isPresent(contents[field])) out.push(kind);
  }
  return out;
}

// 지금 배부해야 할 kind. requiredKinds 중 대응 필드가 isDue인 것만(없는 kind는 절대 포함하지 않음).
export function dueKinds(contents, nowMs) {
  if (contents === null || typeof contents !== 'object') return [];
  const out = [];
  for (const [kind, field] of KIND_FIELD) {
    if (isPresent(contents[field]) && isDue(contents[field], nowMs)) out.push(kind);
  }
  return out;
}

// distributedKinds(배열|Set)를 조회용 Set으로 정규화. 그 외 타입은 빈 Set(전부 미충족으로 본다).
function toDistributedSet(distributedKinds) {
  if (distributedKinds instanceof Set) return distributedKinds;
  if (Array.isArray(distributedKinds)) return new Set(distributedKinds);
  return new Set();
}

// 완결까지 남은 kind — requiredKinds 중 distributedKinds에 없는 것들(순서 유지).
export function missingKinds(contents, distributedKinds) {
  const done = toDistributedSet(distributedKinds);
  return requiredKinds(contents).filter((kind) => !done.has(kind));
}

// 완결 판정 — required가 있고(>0) 남은 것이 없으면 완결.
// required가 []이면 항상 false: 엠바고 컬럼이 둘 다 빈 EPS(비정상 데이터)를 배부 0건으로 DPS 전이시키지 않는다.
export function isComplete(contents, distributedKinds) {
  return requiredKinds(contents).length > 0 && missingKinds(contents, distributedKinds).length === 0;
}
