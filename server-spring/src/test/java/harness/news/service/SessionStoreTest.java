package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.MutableClock;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 세션 스토어 — 토큰 발급·1시간 슬라이딩 만료·비연장 peek·단일 세션 정책.
 *
 * <p>계약이 동결한 사실을 그대로 잠근다: 토큰은 {@code ^[0-9a-f]{64}$}이고 권한 정보를 담지 않으며,
 * 만료는 마지막 <b>touch</b> 기준 1시간이고 peek는 그 시계를 밀지 못한다(SSE류 반복 조회가 유휴 만료를
 * 무력화하지 못하게 하는 축). 로그인은 같은 userId의 기존 세션을 전부 무효화한다 — 계약 스위트 전체가
 * 이 정책 위에서 돌기 때문에 다중 세션을 허용하면 계약이 red가 된다.
 *
 * <p>시각은 전부 주입 시계({@link MutableClock})로 결정한다 — 이 파일에 실시간 대기는 없다.
 * 세션 토큰은 단언 메시지에 담지 않는다(토큰 자체가 권한이라 surefire 리포트에도 남기지 않는다).
 */
class SessionStoreTest {

	private static final long HOUR_MS = 60L * 60L * 1000L;

	private static final Pattern TOKEN = Pattern.compile("^[0-9a-f]{64}$");

	private MutableClock clock;

	private SessionStore store;

	@BeforeEach
	void setUp() {
		this.clock = new MutableClock(1_700_000_000_000L);
		this.store = new SessionStore(this.clock);
	}

	// --- 토큰 ---------------------------------------------------------------------------------

	@Test
	void tokensAre64LowercaseHexAndNeverRepeat() {
		Set<String> issued = new HashSet<>();
		for (int i = 0; i < 200; i++) {
			String sessionId = this.store.createSession("user-" + i);
			assertTrue(TOKEN.matcher(sessionId).matches(),
					"세션 토큰은 소문자 hex 64자여야 한다(계약 정규식) — 실제 길이=" + sessionId.length());
			issued.add(sessionId);
		}

		assertEquals(200, issued.size(), "토큰이 반복되면 남의 세션을 물려받는다");
	}

	@Test
	void tokenCarriesNoIdentity() {
		String sessionId = this.store.createSession("editor-Z");

		assertFalse(sessionId.contains("editor"), "토큰에 신원이 섞이면 안 된다");
		assertFalse(sessionId.contains("Z"), "토큰은 권한 정보를 담지 않는다(소문자 hex뿐)");
	}

	// --- 만료 --------------------------------------------------------------------------------

	@Test
	void expiresExactlyOneHourAfterIssueWhenNeverTouched() {
		String sessionId = this.store.createSession("u1");

		this.clock.advance(HOUR_MS - 1);
		assertNotNull(this.store.peekSession(sessionId), "1시간 직전에는 아직 유효하다");

		this.clock.advance(1);
		assertNull(this.store.peekSession(sessionId), "발급 후 정확히 1시간이면 만료다(Node: now >= expiresAt)");
	}

	@Test
	void touchSlidesTheExpiryByAnotherHour() {
		String sessionId = this.store.createSession("u1");

		this.clock.advance(HOUR_MS - 1);
		assertEquals("u1", this.store.touchSession(sessionId), "만료 직전 요청은 통과해야 한다");

		this.clock.advance(HOUR_MS - 1);
		assertEquals("u1", this.store.touchSession(sessionId), "touch가 만료를 1시간 연장하지 않았다");

		this.clock.advance(HOUR_MS);
		assertNull(this.store.touchSession(sessionId), "마지막 touch로부터 1시간이 지나면 만료다");
	}

	@Test
	void peekDoesNotSlideTheExpiry() {
		String sessionId = this.store.createSession("u1");

		// 10분마다 5회 확인 — 이 경로가 만료를 밀면 세션은 영원히 살아남는다(SSE 무한 연장).
		for (int i = 0; i < 5; i++) {
			this.clock.advance(10 * 60_000L);
			assertEquals("u1", this.store.peekSession(sessionId), "peek는 아직 살아 있는 세션을 봐야 한다");
		}

		this.clock.advance(10 * 60_000L); // 발급으로부터 정확히 60분.
		assertNull(this.store.peekSession(sessionId), "peek는 만료를 연장하지 않는다");
		assertNull(this.store.touchSession(sessionId), "만료된 세션은 touch로도 되살아나지 않는다");
	}

	@Test
	void expiredSessionIsDroppedFromTheStore() {
		String sessionId = this.store.createSession("u1");
		this.clock.advance(HOUR_MS);
		assertNull(this.store.peekSession(sessionId));

		// 시계를 되감아도 되살아나지 않는다 — 만료 판정 시점에 엔트리를 제거했다는 음성 증거.
		this.clock.advance(-HOUR_MS);
		assertNull(this.store.peekSession(sessionId), "만료된 세션은 스토어에서 제거돼야 한다");
	}

	// --- 단일 세션 정책 -----------------------------------------------------------------------

	@Test
	void issuingASessionInvalidatesEveryPreviousSessionOfTheSameUser() {
		String first = this.store.createSession("u1");
		String otherUser = this.store.createSession("u2");

		String second = this.store.createSession("u1");

		assertNull(this.store.peekSession(first), "재로그인은 같은 userId의 이전 토큰을 전부 무효화한다");
		assertEquals("u1", this.store.peekSession(second), "새 토큰은 유효하다");
		assertEquals("u2", this.store.peekSession(otherUser), "다른 사용자의 세션은 영향을 받지 않는다");
	}

	// --- 무효화 ------------------------------------------------------------------------------

	@Test
	void invalidateRemovesTheSessionAndIsIdempotent() {
		String sessionId = this.store.createSession("u1");

		assertTrue(this.store.invalidate(sessionId), "존재하던 세션 제거는 true");
		assertNull(this.store.touchSession(sessionId));
		assertNull(this.store.peekSession(sessionId));
		assertFalse(this.store.invalidate(sessionId), "이미 없는 세션의 제거는 false(예외 아님)");
	}

	@Test
	void unknownOrMalformedTokensAreRejectedWithoutThrowing() {
		assertNull(this.store.touchSession(null));
		assertNull(this.store.peekSession(null));
		assertNull(this.store.touchSession("not-a-real-token"), "형식이 틀린 토큰도 예외가 아니라 미인증이다");
		assertNull(this.store.peekSession("0".repeat(64)));
		assertFalse(this.store.invalidate(null));
	}

	// --- 동시성 ------------------------------------------------------------------------------

	@Test
	void concurrentTouchesNeverLoseALiveSession() throws Exception {
		String sessionId = this.store.createSession("u1");
		int threads = 8;
		int perThread = 250;
		ExecutorService pool = Executors.newFixedThreadPool(threads);
		CountDownLatch start = new CountDownLatch(1);
		List<Future<Integer>> results = new ArrayList<>();

		try {
			for (int t = 0; t < threads; t++) {
				results.add(pool.submit(() -> {
					start.await();
					int hits = 0;
					for (int i = 0; i < perThread; i++) {
						if ("u1".equals(this.store.touchSession(sessionId))) {
							hits++;
						}
					}
					return hits;
				}));
			}
			start.countDown();
			for (Future<Integer> result : results) {
				assertEquals(perThread, result.get(30, TimeUnit.SECONDS),
						"동시 touch에서 살아 있는 세션을 놓치면 무작위 401이 된다");
			}
		}
		finally {
			pool.shutdownNow();
		}

		assertEquals("u1", this.store.peekSession(sessionId), "동시 갱신 후에도 세션은 그대로 살아 있어야 한다");
	}
}
