package harness.news.service;

import harness.news.model.UserRepository;
import harness.news.model.UserRow;

/**
 * 세션 가드 — {@link SessionStore}와 같은 연산 4개를 갖는 데코레이터다
 * (리포 루트 {@code src/services/sessionGuard.js}와 동형). 인증이 필요한 소비처는 이것만 주입받는다.
 *
 * <p><b>이 클래스가 하는 일 한 문장:</b> 세션이 살아 있어도 그 신원을 그대로 믿지 않고, 조회할 때마다
 * {@code User} 행을 다시 읽어 (1) 행이 없거나 {@code active='N'}이면 세션을 <b>스토어에서 제거</b>하고
 * (2) 그 외에는 신원을 <b>DB 최신값으로 재도출</b>한다.
 *
 * <p>왜 이렇게까지 하는가: 세션에 로그인 시점 스냅샷을 두면 비활성화·역할 강등이 기존 세션에 반영되지
 * 않아 최대 1시간(슬라이딩) 동안 이전 권한이 유지된다 — 2026-08-03 감사가 [high]로 올린 권한 상승이고,
 * ADR-004가 "매 요청 재도출"로 못 박은 지점이다. phase 67 테스트 게이트는 Node에서 이 재도출을 지워도
 * 계약 267 케이스가 전부 green이었다는 사실을 발견해 {@code session-guard.contract.js}로 잠갔다.
 *
 * <p><b>캐시·TTL·백그라운드 갱신을 두지 않는다.</b> 캐시 창이 곧 무효화 지연이고, 그 지연이 그대로
 * "비활성화된 계정이 계속 통과하는 시간"이다. PK 조회 1회는 로컬 SQLite에서 마이크로초다.
 *
 * <p>무효화는 영구적이다 — 제거된 토큰은 계정을 다시 활성화해도 되살아나지 않는다(재로그인만이
 * 새 토큰을 준다). 그 사실이 계약의 "같은 토큰은 다른 라우트에서도 401" 케이스를 만든다.
 */
public class SessionGuard {

	private final SessionStore store;

	private final UserRepository users;

	SessionGuard(SessionStore store, UserRepository users) {
		this.store = store;
		this.users = users;
	}

	/**
	 * 세션 발급 위임(로그인 성공 경로). 단일 세션 정책은 스토어가 강제한다.
	 *
	 * @return 64자 소문자 hex 토큰
	 */
	public String createSession(String userId) {
		return this.store.createSession(userId);
	}

	/**
	 * 슬라이딩 조회 + 재도출 — 일반 REST 요청 경로다(요청마다 만료가 1시간 뒤로 밀린다).
	 *
	 * @return 재도출한 신원, 세션이 없거나 만료·무효면 {@code null}
	 */
	public Identity touchSession(String sessionId) {
		return rederive(sessionId, this.store.touchSession(sessionId));
	}

	/**
	 * 비연장 조회 + 재도출 — 사용자 활동이 아닌 확인 경로(SSE 재검증 등) 전용이다.
	 * 일반 요청에 이것을 쓰면 슬라이딩 갱신 계약이 깨진다.
	 *
	 * @return 재도출한 신원, 세션이 없거나 만료·무효면 {@code null}
	 */
	public Identity peekSession(String sessionId) {
		return rederive(sessionId, this.store.peekSession(sessionId));
	}

	/**
	 * 세션 제거(로그아웃).
	 *
	 * @return 실제로 제거했으면 {@code true}
	 */
	public boolean invalidate(String sessionId) {
		return this.store.invalidate(sessionId);
	}

	/**
	 * 스토어가 준 {@code userId}를 DB 최신 행과 대조해 신원을 다시 만든다.
	 *
	 * <p>비활성 판정은 정확히 {@code 'N'}일 때만 한다(Node의 로그인·가드와 동형) — {@code active}가 비어 있는
	 * 레거시 행은 통과시킨다. 행 전체를 반환하지 않고 {@link Identity} 투영만 돌려주므로 비밀번호 해시와
	 * 잠금 메타는 이 경계를 넘지 못한다.
	 */
	private Identity rederive(String sessionId, String userId) {
		if (userId == null) {
			return null; // 세션이 없거나 만료 — DB를 읽을 이유가 없다.
		}
		UserRow row = this.users.findById(userId); // 매 조회 재조회. 캐시하지 않는다.
		if (row == null || "N".equals(row.active())) {
			this.store.invalidate(sessionId); // 즉시·영구 무효화.
			return null;
		}
		return Identity.of(row);
	}
}
