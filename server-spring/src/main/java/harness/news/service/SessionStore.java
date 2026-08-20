package harness.news.service;

import java.security.SecureRandom;
import java.time.Clock;
import java.util.HexFormat;
import java.util.concurrent.ConcurrentHashMap;

/**
 * in-process 세션 스토어 — 리포 루트 {@code src/services/sessionService.js}와 동형이다.
 *
 * <p><b>세션에는 userId만 담는다.</b> role·부서 같은 신원을 담아 두면 그것이 로그인 시점 스냅샷이 되고,
 * 강등·비활성화가 최대 1시간(슬라이딩) 동안 반영되지 않는다. 신원 재도출은 {@link SessionGuard}가
 * 매 조회마다 DB에서 한다(ADR-004) — 이 클래스는 "누가·언제까지"만 안다.
 *
 * <p>불변식 넷.
 * <ul>
 *   <li>토큰은 {@link SecureRandom} 32바이트를 소문자 hex 64자로 쓴 값이다(계약 정규식
 *       {@code ^[0-9a-f]{64}$}). 권한·신원을 인코딩하지 않으므로 토큰만 봐서는 아무것도 알 수 없다.</li>
 *   <li>만료는 1시간 슬라이딩이다. 인증된 요청({@link #touchSession})마다 갱신되고,
 *       비연장 조회({@link #peekSession})는 시계를 밀지 않는다 — 사용자 활동이 아닌 반복 확인(SSE 등)이
 *       유휴 만료를 무력화하지 못하게 하는 축이다.</li>
 *   <li>만료 판정은 {@link #live}<b> 한 곳</b>에서만 하고, 만료된 항목은 그 자리에서 제거한다.
 *       주기 정리 타이머는 두지 않는다(ADR-008: 앱 내 타이머 0).</li>
 *   <li>단일 세션 정책 — 발급은 같은 {@code userId}의 기존 항목을 <b>전부</b> 제거한다.</li>
 * </ul>
 *
 * <p>시각은 주입된 {@link Clock}에서만 읽는다(decisions (14)). 저장소는 프로세스 메모리이며 외부
 * 세션 스토어·{@code HttpSession}은 쓰지 않는다(decisions (10)). 토큰은 로그·예외 메시지·
 * {@code toString()} 어디에도 넣지 않는다 — 토큰 자체가 권한이다.
 *
 * <p>이 타입은 패키지 밖에서 보이지 않는다. 소비처가 스토어를 직접 잡으면 재도출을 건너뛴 신원을 얻는
 * 우회로가 생기므로, 합성 루트({@link SessionConfig})가 가드 안에만 넣어 준다.
 */
class SessionStore {

	/** 유휴 만료 한도 — 1시간 슬라이딩. */
	private static final long ONE_HOUR_MS = 60L * 60L * 1000L;

	/** 세션 항목 — 신원이 아니라 {@code userId}와 만료 시각뿐이다. */
	private record Entry(String userId, long expiresAt) {
	}

	private final ConcurrentHashMap<String, Entry> sessions = new ConcurrentHashMap<>();

	private final SecureRandom random = new SecureRandom();

	private final Clock clock;

	SessionStore(Clock clock) {
		this.clock = clock;
	}

	/**
	 * 세션 발급(로그인 성공 경로). 같은 {@code userId}의 기존 세션을 먼저 전부 무효화한다 —
	 * 계약 스위트 전체가 이 단일 세션 정책 위에서 돌기 때문에 다중 세션을 허용하면 계약이 red가 된다.
	 *
	 * <p>제거와 등록 사이에 다른 발급이 끼어들면 방금 발급한 토큰이 함께 지워질 수 있어 발급만 직렬화한다
	 * (로그인 경로뿐이라 비용이 없다). 조회·갱신은 잠그지 않는다.
	 *
	 * @return 64자 소문자 hex 토큰
	 */
	synchronized String createSession(String userId) {
		this.sessions.values().removeIf((entry) -> entry.userId().equals(userId));
		byte[] token = new byte[32];
		this.random.nextBytes(token);
		String sessionId = HexFormat.of().formatHex(token);
		this.sessions.put(sessionId, new Entry(userId, this.clock.millis() + ONE_HOUR_MS));
		return sessionId;
	}

	/**
	 * 슬라이딩 조회 — 유효하면 만료를 1시간 뒤로 밀고 {@code userId}를 돌려준다.
	 *
	 * @return 세션이 없거나 만료면 {@code null}
	 */
	String touchSession(String sessionId) {
		Entry entry = live(sessionId);
		if (entry == null) {
			return null;
		}
		// CAS — 다른 스레드가 먼저 갱신했으면(또는 무효화했으면) 그 결과를 존중한다.
		this.sessions.replace(sessionId, entry,
				new Entry(entry.userId(), this.clock.millis() + ONE_HOUR_MS));
		return entry.userId();
	}

	/**
	 * 비연장 조회 — 만료 판정만 하고 만료 시각은 그대로 둔다.
	 *
	 * @return 세션이 없거나 만료면 {@code null}
	 */
	String peekSession(String sessionId) {
		Entry entry = live(sessionId);
		return (entry == null) ? null : entry.userId();
	}

	/**
	 * 세션 제거(로그아웃·가드의 무효화). 없는 토큰·{@code null}도 예외가 아니다.
	 *
	 * @return 실제로 제거했으면 {@code true}
	 */
	boolean invalidate(String sessionId) {
		return (sessionId != null) && (this.sessions.remove(sessionId) != null);
	}

	/**
	 * 만료 판정 단일 지점 — 만료된 항목은 여기서 스토어에서 지운다(조회 시점 정리, 타이머 없음).
	 * 판정식은 Node와 같다: 만료 시각에 <b>도달하면</b> 만료다({@code now >= expiresAt}).
	 */
	private Entry live(String sessionId) {
		if (sessionId == null) {
			return null;
		}
		Entry entry = this.sessions.get(sessionId);
		if (entry == null) {
			return null;
		}
		if (this.clock.millis() >= entry.expiresAt()) {
			this.sessions.remove(sessionId, entry); // 값까지 대조 — 그사이 재발급된 항목은 건드리지 않는다.
			return null;
		}
		return entry;
	}
}
