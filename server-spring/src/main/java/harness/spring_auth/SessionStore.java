package harness.spring_auth;

import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * 인메모리 세션 스토어 — 64-hex 토큰, 1시간 슬라이딩 만료, 단일 세션 정책(ADR-004/ADR-012 프로세스 로컬).
 *
 * CRITICAL(ADR-004): 세션에는 **userId와 만료 시각만** 저장한다 — role/active 같은 신원(User 행)은
 *   절대 캐시하지 않는다. 신원은 SessionGuard가 요청마다 DB에서 재도출한다(강등·비활성 즉시 반영).
 *   시계는 주입(LongSupplier)이라 만료/슬라이딩을 결정적으로 테스트한다(Date.now 직접 호출 금지).
 */
public class SessionStore {

	private static final long ONE_HOUR_MS = 60L * 60L * 1000L;

	/** 세션 항목 — userId(신원 아님)와 만료 시각만. */
	private record Entry(String userId, long expiresAt) {
	}

	private final ConcurrentHashMap<String, Entry> sessions = new ConcurrentHashMap<>();
	private final SecureRandom random = new SecureRandom();
	private final LongSupplier clock;

	public SessionStore() {
		this(System::currentTimeMillis);
	}

	public SessionStore(LongSupplier clock) {
		this.clock = clock;
	}

	/**
	 * 세션 발급 — 단일 세션 정책: 같은 userId의 기존 항목을 모두 제거한 뒤 새 64-hex 토큰을 발급한다.
	 * (이전 토큰은 이후 무효.)
	 */
	public String issue(String userId) {
		sessions.entrySet().removeIf((e) -> e.getValue().userId().equals(userId));
		byte[] bytes = new byte[32];
		random.nextBytes(bytes);
		String sessionId = HexFormat.of().formatHex(bytes); // 소문자 64-hex.
		sessions.put(sessionId, new Entry(userId, clock.getAsLong() + ONE_HOUR_MS));
		return sessionId;
	}

	/** 만료 판정 후 살아 있는 항목만 반환 — 만료면 제거하고 null(판정식 단일 지점). */
	private Entry live(String sessionId) {
		if (sessionId == null) {
			return null;
		}
		Entry e = sessions.get(sessionId);
		if (e == null) {
			return null;
		}
		if (clock.getAsLong() >= e.expiresAt()) {
			sessions.remove(sessionId);
			return null;
		}
		return e;
	}

	/** 비연장 조회 — 만료 판정만 하고 만료 시각은 갱신하지 않는다. userId 또는 null. */
	public String peek(String sessionId) {
		Entry e = live(sessionId);
		return e == null ? null : e.userId();
	}

	/** 슬라이딩 조회 — 유효하면 만료를 1시간 연장하고 userId 반환, 없거나 만료면 null. */
	public String touch(String sessionId) {
		Entry e = live(sessionId);
		if (e == null) {
			return null;
		}
		sessions.put(sessionId, new Entry(e.userId(), clock.getAsLong() + ONE_HOUR_MS));
		return e.userId();
	}

	/** 세션 제거(로그아웃·무효화). null은 무시. */
	public void remove(String sessionId) {
		if (sessionId != null) {
			sessions.remove(sessionId);
		}
	}
}
