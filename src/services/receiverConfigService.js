// 수집(자동기사) 수신 설정 서비스 — rcvMgmt.do의 조회/생성/삭제 (HTTP 비의존, ADR-006).
// CRITICAL: 모든 op는 Z(관리자) 전용. acting role은 검증된 세션에서만 도출한다(authorization 게이트).
// remove는 설정 행만 지운다 — 이미 수집된 Article/Contents는 건드리지 않는다(DB 비파괴).

// 조회 응답에 노출 가능한 컬럼 — allowlist(블랙리스트가 아님). userService.SAFE_FIELDS와 동일 원칙.
// password(FTP 비밀번호)·apiKey(API 키)는 의도적으로 제외한다(시크릿은 쓰기 전용, ADR-004).
// username은 host/port/apiEndpoint와 함께 "어디에 무엇으로 붙는지"를 보여주는 식별자(비밀번호 없이는
// 인증 불가)이므로 노출 유지한다. 향후 새 시크릿 컬럼이 추가돼도 allowlist라 자동으로 비노출(안전 기본값).
const SAFE_FIELDS = [
  'id', 'sourceId', 'type', 'name', 'host', 'port',
  'apiEndpoint', 'active', 'createdAt', 'username',
];

function sanitize(row = {}) {
  const out = {};
  for (const f of SAFE_FIELDS) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

export function createReceiverConfigService({ receiverConfigModel, authorization }) {
  function query(sessionId, filters = {}) {
    const gate = authorization.manageReceiverConfig(sessionId, 'query', filters);
    if (!gate.ok) return gate;
    // 모델은 전체 행(시크릿 포함)을 반환하고, 노출 정책은 서비스 계층이 책임진다(계층 분리).
    return { ok: true, items: receiverConfigModel.query(filters).map(sanitize) };
  }

  function create(sessionId, entry = {}) {
    const gate = authorization.manageReceiverConfig(sessionId, 'create', entry);
    if (!gate.ok) return gate;
    return { ok: true, id: receiverConfigModel.insert(entry) };
  }

  function remove(sessionId, id) {
    const gate = authorization.manageReceiverConfig(sessionId, 'remove', { id });
    if (!gate.ok) return gate;
    return { ok: true, changes: receiverConfigModel.remove(id) };
  }

  return { query, create, remove };
}
