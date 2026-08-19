package harness.spring_auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

/** step3 세션 스토어 — 64-hex 발급·단일 세션·슬라이딩 만료·만료/미존재 조회. 시계 주입으로 결정적. */
class SessionStoreTest {

	private AtomicLong clock() {
		return new AtomicLong(1_000_000L);
	}

	@Test
	void issuesLowercase64Hex() {
		SessionStore store = new SessionStore(() -> 0L);
		String sid = store.issue("reporter");
		assertTrue(sid.matches("[0-9a-f]{64}"), "토큰은 소문자 64-hex여야 한다: " + sid);
	}

	@Test
	void singleSessionInvalidatesPreviousTokenForSameUser() {
		SessionStore store = new SessionStore(() -> 0L);
		String first = store.issue("reporter");
		String second = store.issue("reporter");
		assertNotEquals(first, second);
		assertNull(store.peek(first), "같은 userId 재발급 시 이전 토큰은 무효화된다");
		assertEquals("reporter", store.peek(second));
	}

	@Test
	void differentUsersKeepIndependentSessions() {
		SessionStore store = new SessionStore(() -> 0L);
		String a = store.issue("reporter");
		String b = store.issue("admin");
		assertEquals("reporter", store.peek(a));
		assertEquals("admin", store.peek(b));
	}

	@Test
	void touchSlidesExpiry() {
		AtomicLong now = clock();
		SessionStore store = new SessionStore(now::get);
		String sid = store.issue("reporter"); // 만료 = now + 1h
		now.addAndGet(59L * 60L * 1000L); // +59분: 아직 유효
		assertEquals("reporter", store.touch(sid)); // touch로 만료 = now(59분) + 1h
		now.addAndGet(59L * 60L * 1000L); // 최초 발급 기준 118분: touch 안 했으면 만료였을 시점
		assertEquals("reporter", store.peek(sid), "슬라이딩 연장이 적용돼 아직 유효해야 한다");
	}

	@Test
	void expiredSessionResolvesToNull() {
		AtomicLong now = clock();
		SessionStore store = new SessionStore(now::get);
		String sid = store.issue("reporter");
		now.addAndGet(60L * 60L * 1000L); // 정확히 1h 경과 → 만료(>=)
		assertNull(store.peek(sid));
		assertNull(store.touch(sid));
	}

	@Test
	void unknownAndNullTokenResolveToNull() {
		SessionStore store = new SessionStore(() -> 0L);
		assertNull(store.peek("deadbeef"));
		assertNull(store.peek(null));
		assertNull(store.touch(null));
	}

	@Test
	void removeInvalidatesSession() {
		SessionStore store = new SessionStore(() -> 0L);
		String sid = store.issue("reporter");
		store.remove(sid);
		assertNull(store.peek(sid));
	}

	@Test
	void peekDoesNotExtendExpiry() {
		AtomicLong now = clock();
		SessionStore store = new SessionStore(now::get);
		String sid = store.issue("reporter"); // 만료 = now + 1h
		now.addAndGet(59L * 60L * 1000L);
		assertEquals("reporter", store.peek(sid)); // peek는 연장하지 않는다
		now.addAndGet(2L * 60L * 1000L); // 발급 기준 61분 → peek가 연장 안 했으면 만료
		assertNull(store.peek(sid), "peek는 슬라이딩 연장을 하지 않는다");
	}
}
