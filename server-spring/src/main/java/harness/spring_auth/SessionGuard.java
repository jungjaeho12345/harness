package harness.spring_auth;

/**
 * 세션 가드 — ADR-004의 심장부. 세션 스토어가 준 userId로 **매 요청 User 행을 재조회**해 신원을
 * DB 최신 role/active로 재도출한다. 행이 없거나 active='N'이면 그 세션을 즉시 무효화(스토어에서 제거)한다.
 * 캐시·TTL 없음(캐시 창이 곧 무효화 지연 — 즉시 차단 요구와 충돌). in-process SQLite PK 조회는 마이크로초.
 *
 * touch(슬라이딩)와 peek(비연장)을 나눠 제공한다 — REST 라우트는 touch(사용자 활동마다 만료 연장),
 * 비연장 조회 경로는 peek. 어느 쪽도 User 신원을 세션에 캐시하지 않는다.
 */
public class SessionGuard {

	private final SessionStore store;
	private final UserLookup users;

	public SessionGuard(SessionStore store, UserLookup users) {
		this.store = store;
		this.users = users;
	}

	/** 스토어가 준 userId를 DB 최신 행과 대조해 신원 재도출 — 없거나 비활성이면 세션 무효화 후 null. */
	private Identity rederive(String sessionId, String userId) {
		if (userId == null) {
			return null;
		}
		NewsDb.User u = users.findUser(userId);
		// 비활성 판정은 정확히 'N'일 때만(userService.login/sessionGuard와 동형). 행이 사라졌으면 무효화.
		if (u == null || "N".equals(u.active())) {
			store.remove(sessionId);
			return null;
		}
		return new Identity(u.userId(), u.name(), u.role(), u.department(), u.departmentCode());
	}

	/** 슬라이딩 재도출 — REST 라우트용(유효 요청마다 만료 연장). */
	public Identity touch(String sessionId) {
		return rederive(sessionId, store.touch(sessionId));
	}

	/** 비연장 재도출. */
	public Identity peek(String sessionId) {
		return rederive(sessionId, store.peek(sessionId));
	}

	/** 세션 발급 위임(단일 세션 정책은 스토어가 강제). */
	public String issue(String userId) {
		return store.issue(userId);
	}

	/** 세션 제거 위임(로그아웃). */
	public void remove(String sessionId) {
		store.remove(sessionId);
	}
}
