// 세션 서비스 — in-process 세션 스토어 (ADR-004: 신뢰 경계는 서버에 둔다).
// 세션 토큰은 서버가 발급하는 무작위 토큰이며 권한 정보를 담지 않는다.
// 만료는 1시간 슬라이딩(인증 요청마다 갱신)이며, 시계는 주입(now)으로 결정성을 확보한다.
// (Date.now() 직접 호출 금지 — 테스트는 가짜 시계를 주입한다.)

import { randomBytes } from 'node:crypto';

const ONE_HOUR_MS = 60 * 60 * 1000;

// 세션에 보관/반환하는 정제된 신원 — 비밀번호(해시 포함)는 절대 담지 않는다.
const IDENTITY_FIELDS = ['userId', 'role', 'department', 'departmentCode', 'name'];

// 임의의 사용자/DB 행에서 화이트리스트 필드만 뽑아 신원을 만든다(비밀번호·잠금 메타 차단).
// 세션 가드가 DB 최신 행으로 신원을 재도출할 때도 이 투영을 재사용한다.
export function identityOf(user = {}) {
  const out = {};
  for (const f of IDENTITY_FIELDS) out[f] = user[f];
  return out;
}

export function createSessionService({ now = () => Date.now() } = {}) {
  // sessionId -> { identity, expiresAt }
  const sessions = new Map();

  // 로그인 성공 시: 같은 사용자의 기존 세션을 모두 무효화하고 새 토큰을 발급한다.
  function createSession(user = {}) {
    const identity = identityOf(user);
    for (const [id, s] of sessions) {
      if (s.identity.userId === identity.userId) sessions.delete(id);
    }
    const sessionId = randomBytes(32).toString('hex');
    sessions.set(sessionId, { identity, expiresAt: now() + ONE_HOUR_MS });
    return sessionId;
  }

  // 만료 판정만 하는 내부 조회 — 만료된 세션은 스토어에서 제거한다. 판정식은 여기 한 곳뿐이다.
  function liveSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return undefined;
    if (now() >= s.expiresAt) {
      sessions.delete(sessionId);
      return undefined;
    }
    return s;
  }

  // 유효하면 1시간 슬라이딩 갱신 후 정제된 신원을 반환, 없거나 만료면 undefined.
  function touchSession(sessionId) {
    const s = liveSession(sessionId);
    if (!s) return undefined;
    s.expiresAt = now() + ONE_HOUR_MS;
    return { ...s.identity };
  }

  // 비연장 조회 — 만료 판정만 하고 expiresAt은 갱신하지 않는다.
  // SSE처럼 사용자 활동 없이 반복 확인하는 경로가 세션을 무한 연장해 유휴 만료를 무력화하지 않도록.
  function peekSession(sessionId) {
    const s = liveSession(sessionId);
    if (!s) return undefined;
    return { ...s.identity };
  }

  // 로그아웃 — 세션 제거.
  function invalidate(sessionId) {
    return sessions.delete(sessionId);
  }

  return { createSession, touchSession, peekSession, invalidate };
}
