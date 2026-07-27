// 배부 대상(수신처) 서비스 — 도메인 로직 (HTTP 비의존, ADR-006). 의존성은 주입.
// CRITICAL: 모든 op는 Z(관리자) 전용. acting role은 검증된 세션에서만 도출한다(authorization 게이트).
//   클라이언트가 보낸 role/id/타임스탬프는 신뢰하지 않는다(ADR-004).
// 대상 제거 경로는 없다 — 비활성은 active='N' soft delete가 유일하다(DB 비파괴).
// 배부 실행(스풀 파일 쓰기·Contents.distributedAt·EPS→DPS 전이·tick)은 이 서비스의 책임이 아니다
//   — phase 47/48(ADR-008). 여기서는 대상을 검증하고 저장만 한다(파일시스템·타이머·네트워크 접촉 없음).

import { sanitizeSpoolDir } from './spoolDir.js';

// 조회 응답에 노출 가능한 컬럼 — allowlist(블랙리스트가 아님). receiverConfigService와 동일 원칙:
// 향후 시크릿 컬럼이 추가돼도 자동으로 비노출된다(안전 기본값).
const SAFE_FIELDS = ['id', 'name', 'kind', 'spoolDir', 'active', 'createdAt', 'updatedAt'];

// query에서 모델로 넘길 수 있는 필터 키 — 그 외 키는 무시한다.
const FILTER_KEYS = ['id', 'name', 'kind', 'spoolDir', 'active'];

const KINDS = new Set(['press', 'nonpress']); // 언론사 | 비언론사 (news.md 엠바고 규칙의 두 축)
const ACTIVE = new Set(['Y', 'N']);

const NAME_MAX = 100;

function sanitize(row = {}) {
  const out = {};
  for (const f of SAFE_FIELDS) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

// 허용 키의 원시값(문자열/숫자)만 통과 — 배열·객체는 무시한다(모델 바인딩 오류·필터 주입 차단).
function pickFilters(filters = {}) {
  const out = {};
  for (const k of FILTER_KEYS) {
    const v = filters[k];
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

export function createDistributionTargetService({
  distributionTargetModel,
  authorization,
  now = () => new Date().toISOString(), // 주입 가능한 시계(테스트 결정성).
}) {
  // 이름 검증 — 비문자열은 강제변환 없이 즉시 거부한다.
  // (String(undefined)==='undefined'가 trim/길이 검사를 통과해 name='undefined' 행을 만드는 결함 차단.)
  function checkName(value) {
    if (typeof value !== 'string') return { ok: false, reason: 'invalid-name' };
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > NAME_MAX) return { ok: false, reason: 'invalid-name' };
    return { ok: true, value: trimmed };
  }

  // 집합 검사 — 비문자열은 자연 거부된다(대소문자 보정 없음).
  function checkKind(value) {
    return KINDS.has(value) ? { ok: true, value } : { ok: false, reason: 'invalid-kind' };
  }

  function checkActive(value) {
    return ACTIVE.has(value) ? { ok: true, value } : { ok: false, reason: 'invalid-active' };
  }

  // spoolDir 검증 — 규칙의 단일 출처는 sanitizeSpoolDir(타입 게이트 포함)다. 여기서 재구현하지 않는다.
  // 유일성은 비활성 행까지 포함해 따진다(비활성 대상의 스풀 폴더가 그대로 남아 있기 때문).
  function checkSpoolDir(value, selfId) {
    const dir = sanitizeSpoolDir(value);
    if (dir === '') return { ok: false, reason: 'invalid-spool-dir' };
    const taken = distributionTargetModel.query({ spoolDir: dir }).some((r) => r.id !== selfId);
    if (taken) return { ok: false, reason: 'duplicate-spool-dir' };
    return { ok: true, value: dir };
  }

  // 상태 변경 단일 경로 — PUT /:id(update)와 POST /:id/deactivate가 모두 여기로 수렴한다.
  // 두 경로가 갈라지면(예: 한쪽만 updatedAt stamp) 감사 기록이 진입점에 따라 달라진다.
  function applyPatch(id, patch = {}) {
    if (!distributionTargetModel.findById(id)) return { ok: false, reason: 'not-found' };
    return { ok: true, changes: distributionTargetModel.update(id, { ...patch, updatedAt: now() }) };
  }

  function query(sessionId, filters = {}) {
    const gate = authorization.manageDistributionTarget(sessionId, 'query', filters);
    if (!gate.ok) return gate;
    // 검증은 write 경로에서만 강제한다 — 과거에 저장된 행은 규칙에 걸려도 숨기지 않는다(비파괴).
    return { ok: true, items: distributionTargetModel.query(pickFilters(filters)).map(sanitize) };
  }

  function create(sessionId, entry = {}) {
    const gate = authorization.manageDistributionTarget(sessionId, 'create', entry);
    if (!gate.ok) return gate;

    const name = checkName(entry.name);
    if (!name.ok) return name;
    const kind = checkKind(entry.kind);
    if (!kind.ok) return kind;
    const spoolDir = checkSpoolDir(entry.spoolDir);
    if (!spoolDir.ok) return spoolDir;
    const active = entry.active === undefined ? { ok: true, value: 'Y' } : checkActive(entry.active);
    if (!active.ok) return active;

    // id·createdAt·updatedAt은 서버가 정한다(entry의 동명 필드는 채택하지 않는다).
    const stamp = now();
    return {
      ok: true,
      id: distributionTargetModel.insert({
        name: name.value,
        kind: kind.value,
        spoolDir: spoolDir.value,
        active: active.value,
        createdAt: stamp,
        updatedAt: stamp,
      }),
    };
  }

  // present-only — 전달한 필드만 검증·반영하고 미전달 필드는 불변.
  // 전달된 필드가 하나라도 규칙을 어기면 아무것도 저장하지 않는다(부분 저장 금지).
  function update(sessionId, id, fields = {}) {
    const gate = authorization.manageDistributionTarget(sessionId, 'update', fields);
    if (!gate.ok) return gate;
    // 존재 확인을 검증보다 먼저 한다 — 없는 id가 검증 reason으로 둔갑하지 않도록.
    if (!distributionTargetModel.findById(id)) return { ok: false, reason: 'not-found' };

    const patch = {};
    if (fields.name !== undefined) {
      const name = checkName(fields.name);
      if (!name.ok) return name;
      patch.name = name.value;
    }
    if (fields.kind !== undefined) {
      const kind = checkKind(fields.kind);
      if (!kind.ok) return kind;
      patch.kind = kind.value;
    }
    if (fields.spoolDir !== undefined) {
      const spoolDir = checkSpoolDir(fields.spoolDir, id); // 자기 자신은 중복에서 제외.
      if (!spoolDir.ok) return spoolDir;
      patch.spoolDir = spoolDir.value;
    }
    if (fields.active !== undefined) {
      const active = checkActive(fields.active);
      if (!active.ok) return active;
      patch.active = active.value;
    }
    return applyPatch(id, patch);
  }

  // 비활성(soft delete) — 행을 지우지 않는다. update와 같은 헬퍼로 수렴한다.
  function deactivate(sessionId, id) {
    const gate = authorization.manageDistributionTarget(sessionId, 'deactivate', { id });
    if (!gate.ok) return gate;
    return applyPatch(id, { active: 'N' });
  }

  return { query, create, update, deactivate };
}
