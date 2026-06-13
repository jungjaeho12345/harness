// 수집(자동기사) 수신 설정 서비스 — rcvMgmt.do의 조회/생성/삭제 (HTTP 비의존, ADR-006).
// CRITICAL: 모든 op는 Z(관리자) 전용. acting role은 검증된 세션에서만 도출한다(authorization 게이트).
// remove는 설정 행만 지운다 — 이미 수집된 Article/Contents는 건드리지 않는다(DB 비파괴).

export function createReceiverConfigService({ receiverConfigModel, authorization }) {
  function query(sessionId, filters = {}) {
    const gate = authorization.manageReceiverConfig(sessionId, 'query', filters);
    if (!gate.ok) return gate;
    return { ok: true, items: receiverConfigModel.query(filters) };
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
