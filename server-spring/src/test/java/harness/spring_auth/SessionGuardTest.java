package harness.spring_auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * step3 세션 가드 — ADR-004 재도출. 세션 스토어는 실제(userId만 저장), UserLookup은 카운팅 페이크로
 * "요청마다 findUser 재조회"와 "강등 즉시 반영·비활성 즉시 무효+영구"를 증명한다(session-guard 계약 2축).
 */
class SessionGuardTest {

	/** 인메모리 User 테이블 — 테스트가 role/active를 바꿔 DB 최신값 변화를 흉내낸다. findUser 호출을 센다. */
	private static final class FakeUsers implements UserLookup {
		final Map<String, NewsDb.User> rows = new HashMap<>();
		final AtomicInteger findCalls = new AtomicInteger(0);

		void put(String userId, String role, String active) {
			rows.put(userId, new NewsDb.User(userId, "이름-" + userId, role, "부서", "CODE", active,
					"hash", "0", null, null));
		}

		@Override
		public NewsDb.User findUser(String userId) {
			findCalls.incrementAndGet();
			return rows.get(userId);
		}
	}

	@Test
	void resolvesIdentityFromCurrentDbRole() {
		FakeUsers users = new FakeUsers();
		users.put("u1", "Z", "Y");
		SessionStore store = new SessionStore(() -> 0L);
		SessionGuard guard = new SessionGuard(store, users);
		String sid = store.issue("u1");

		Identity id = guard.touch(sid);
		assertEquals("u1", id.userId());
		assertEquals("Z", id.role());
		assertEquals("이름-u1", id.name());
	}

	@Test
	void findUserCalledEveryRequest() {
		FakeUsers users = new FakeUsers();
		users.put("u1", "Z", "Y");
		SessionStore store = new SessionStore(() -> 0L);
		SessionGuard guard = new SessionGuard(store, users);
		String sid = store.issue("u1");

		guard.touch(sid);
		guard.touch(sid);
		guard.touch(sid);
		assertEquals(3, users.findCalls.get(), "신원은 세션 캐시가 아니라 매 요청 DB 재조회에서 온다(ADR-004)");
	}

	@Test
	void roleDemotionReflectedWithoutReLogin() {
		FakeUsers users = new FakeUsers();
		users.put("u1", "Z", "Y");
		SessionStore store = new SessionStore(() -> 0L);
		SessionGuard guard = new SessionGuard(store, users);
		String sid = store.issue("u1");

		assertEquals("Z", guard.touch(sid).role());
		users.put("u1", "R", "Y"); // DB에서 강등 — 재로그인 없음
		assertEquals("R", guard.touch(sid).role(), "다음 재도출이 새 role을 반영해야 한다");
	}

	@Test
	void deactivationInvalidatesSessionImmediatelyAndPermanently() {
		FakeUsers users = new FakeUsers();
		users.put("u1", "Z", "Y");
		SessionStore store = new SessionStore(() -> 0L);
		SessionGuard guard = new SessionGuard(store, users);
		String sid = store.issue("u1");

		assertTrue(guard.touch(sid) != null);
		users.put("u1", "Z", "N"); // 비활성화
		assertNull(guard.touch(sid), "active=N은 세션을 즉시 무효화한다");
		// 무효화 영구성: 다시 활성으로 돌려도 제거된 세션은 되살아나지 않는다.
		users.put("u1", "Z", "Y");
		assertNull(guard.touch(sid), "무효화된 세션은 스토어에서 제거됐다 — 같은 토큰은 되살아나지 않는다");
		assertNull(store.peek(sid));
	}

	@Test
	void missingUserRowInvalidatesSession() {
		FakeUsers users = new FakeUsers();
		users.put("u1", "Z", "Y");
		SessionStore store = new SessionStore(() -> 0L);
		SessionGuard guard = new SessionGuard(store, users);
		String sid = store.issue("u1");
		users.rows.remove("u1"); // 행 소멸
		assertNull(guard.touch(sid));
		assertNull(store.peek(sid), "행이 사라지면 세션도 무효화된다");
	}

	@Test
	void unknownTokenResolvesNullWithoutDbLookup() {
		FakeUsers users = new FakeUsers();
		SessionStore store = new SessionStore(() -> 0L);
		SessionGuard guard = new SessionGuard(store, users);
		assertNull(guard.touch("deadbeef"));
		assertEquals(0, users.findCalls.get(), "존재하지 않는 세션은 DB를 읽지 않는다");
	}
}
