// 인가 서비스 — R/D/Z 역할 게이트 (ADR-004). 의존성은 주입(sessionService, articleModel).
// CRITICAL: 모든 acting role은 검증된 세션에서만 도출한다. 클라이언트가 보낸 role/payload는 신뢰하지 않는다.
// HTTP 비의존 — 라우트(step8)는 이 게이트를 호출해 "세션 검증 → 인가" 만 위임한다.

// capability -> 허용 역할. 정의되지 않은 capability/역할은 거부한다.
const CAPABILITIES = {
  manageUsers: ['Z'],          // 사용자(USER) CRUD — Z 전용
  manageReceiverConfig: ['Z'], // 수집 수신 설정 CRUD — Z 전용
  manageDistributionTarget: ['Z'], // 배부 대상(수신처) CRUD — Z 전용 (ADR-008)
  editDps: ['D'],              // DPS 기사 고침/포털고침 — D 전용 (news.md 권한 규칙)
  runDistributionTick: ['Z'], // 시점 배부 tick 실행 — Z 전용 (ADR-008 (3))
};

// 고침/포털고침으로 인정하는 액션.
const REVISE_ACTIONS = new Set(['revise', 'portalRevise']);

export function createAuthorization({ sessionService, articleModel }) {
  // 단순 역할 게이트 — role이 capability 허용 목록에 있으면 ok.
  function assertAuthorized(role, capability) {
    const allowed = CAPABILITIES[capability];
    if (!allowed) return { ok: false, reason: 'unknown-capability' };
    if (!allowed.includes(role)) return { ok: false, reason: 'forbidden' };
    return { ok: true };
  }

  // DPS 기사의 고침/포털고침 편집 인가 — D 권한만. role은 세션에서 도출한다.
  function editDps(sessionId, articleId, action) {
    const me = sessionService.touchSession(sessionId);
    if (!me) return { ok: false, reason: 'unauthenticated' };
    if (!REVISE_ACTIONS.has(action)) return { ok: false, reason: 'unknown-action' };

    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };
    if (row.contents.status !== 'DPS') return { ok: false, reason: 'not-dps' };

    const gate = assertAuthorized(me.role, 'editDps');
    if (!gate.ok) return gate;
    return { ok: true, role: me.role };
  }

  // Z 전용 게이트 — 사용자 관리. 인가만 판정하고 실제 op 수행은 호출자(step8) 책임.
  function manageUsers(sessionId, op, payload) {
    const me = sessionService.touchSession(sessionId);
    if (!me) return { ok: false, reason: 'unauthenticated' };
    const gate = assertAuthorized(me.role, 'manageUsers');
    if (!gate.ok) return gate;
    return { ok: true, role: me.role, op, payload };
  }

  // Z 전용 게이트 — 수신 설정 관리.
  function manageReceiverConfig(sessionId, op, payload) {
    const me = sessionService.touchSession(sessionId);
    if (!me) return { ok: false, reason: 'unauthenticated' };
    const gate = assertAuthorized(me.role, 'manageReceiverConfig');
    if (!gate.ok) return gate;
    return { ok: true, role: me.role, op, payload };
  }

  // Z 전용 게이트 — 배부 대상(수신처) 관리 (ADR-008).
  function manageDistributionTarget(sessionId, op, payload) {
    const me = sessionService.touchSession(sessionId);
    if (!me) return { ok: false, reason: 'unauthenticated' };
    const gate = assertAuthorized(me.role, 'manageDistributionTarget');
    if (!gate.ok) return gate;
    return { ok: true, role: me.role, op, payload };
  }

  // Z 전용 게이트 — 시점 배부 tick 실행 (ADR-008 (3)). userId는 배부/전이 이력의 actor로 쓴다.
  function runDistributionTick(sessionId) {
    const me = sessionService.touchSession(sessionId);
    if (!me) return { ok: false, reason: 'unauthenticated' };
    const gate = assertAuthorized(me.role, 'runDistributionTick');
    if (!gate.ok) return gate;
    return { ok: true, role: me.role, userId: me.userId };
  }

  return {
    assertAuthorized, editDps, manageUsers, manageReceiverConfig, manageDistributionTarget,
    runDistributionTick,
  };
}
