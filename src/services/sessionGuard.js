// 세션 가드 — sessionService와 같은 인터페이스를 갖는 데코레이터 (ADR-004/ADR-006).
// 세션에는 로그인 시점의 role/active 스냅샷이 고정되므로, 비활성화(active='N')·역할 강등이
// 기존 세션에 반영되지 않는다(최대 1시간 슬라이딩으로 이전 권한 유지 — 2026-08-03 감사 [high]).
// 그래서 touch/peek 마다 User 행을 재조회해 (1) 행 없음·비활성이면 세션을 즉시 무효화하고
// (2) 그 외에는 신원을 DB 최신값으로 재도출한다.
//
// sessionService에 userModel을 직접 결합하지 않는 이유: 세션을 DB 없이 조립하는 기존 서비스
// 단위 테스트 계약을 보존하기 위함이다(결합 지점은 합성 루트).
// 캐시/타이머는 두지 않는다 — 캐시 창이 곧 무효화 지연이고(즉시 차단 요구와 충돌),
// in-process SQLite PK 조회는 마이크로초 단위다(ADR-008: 앱 내 타이머 없음).

import { identityOf } from './sessionService.js';

export function createSessionGuard({ sessionService, userModel }) {
  // 세션 스토어가 돌려준 신원을 DB 최신 행과 대조해 재도출한다.
  function revalidate(sessionId, identity) {
    if (!identity) return undefined;
    const row = userModel.findById(identity.userId);
    // 행이 사라졌거나 비활성이면 세션 자체를 무효화한다 — 같은 토큰으로는 다시 통과할 수 없다.
    // 비활성 판정은 정확히 'N'일 때만(userService.login과 동형). active가 빈 레거시 행은 통과.
    if (!row || row.active === 'N') {
      sessionService.invalidate(sessionId);
      return undefined;
    }
    // DB 행을 통째로 담지 않는다 — 화이트리스트 투영으로 비밀번호·잠금 메타 유출을 차단한다.
    return identityOf(row);
  }

  // sessionService의 메서드는 항상 동적으로 호출한다(구조분해 캡처 금지) —
  // 테스트가 sessionService.touchSession을 스파이로 교체하는 기존 패턴을 보존한다.
  function touchSession(sessionId) {
    return revalidate(sessionId, sessionService.touchSession(sessionId));
  }

  function peekSession(sessionId) {
    return revalidate(sessionId, sessionService.peekSession(sessionId));
  }

  function createSession(user) {
    return sessionService.createSession(user);
  }

  function invalidate(sessionId) {
    return sessionService.invalidate(sessionId);
  }

  return { createSession, touchSession, peekSession, invalidate };
}
