// 세션 서비스 — in-process 세션 스토어 (ADR-004: 신뢰 경계는 서버에 둔다).
// 세션 토큰은 서버가 발급하는 무작위 토큰이며 권한 정보를 담지 않는다.
// 만료는 1시간 슬라이딩(인증 요청마다 갱신)이며, 시계는 주입(now)으로 결정성을 확보한다.
// (Date.now() 직접 호출 금지 — 테스트는 가짜 시계를 주입한다.)

import { randomBytes } from 'node:crypto';

const ONE_HOUR_MS = 60 * 60 * 1000;

// 세션에 보관/반환하는 정제된 신원 — 비밀번호(해시 포함)는 절대 담지 않는다.
const IDENTITY_FIELDS = ['userId', 'role', 'department', 'departmentCode', 'name'];

function identityOf(user = {}) {
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

  // 유효하면 1시간 슬라이딩 갱신 후 정제된 신원을 반환, 없거나 만료면 undefined.
  function touchSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return undefined;
    if (now() >= s.expiresAt) {
      sessions.delete(sessionId);
      return undefined;
    }
    s.expiresAt = now() + ONE_HOUR_MS;
    return { ...s.identity };
  }

  // 로그아웃 — 세션 제거.
  function invalidate(sessionId) {
    return sessions.delete(sessionId);
  }

  return { createSession, touchSession, invalidate };
}
