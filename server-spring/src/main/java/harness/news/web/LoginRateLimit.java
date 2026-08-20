package harness.news.web;

import java.time.Clock;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 로그인 IP 레이트리밋의 계산부 — <b>클라이언트별 고정 창 카운터</b>. HTTP를 모른다(필터가 와이어를 소유한다).
 *
 * <h2>계약값(추측 금지 — 코드에서 읽었다)</h2>
 * {@code server/index.js} 609~614행:
 * <pre>
 * const loginLimiter = rateLimit({
 *   windowMs: FIFTEEN_MIN_MS,
 *   limit: 10,              // 15분/10회 (news.md 로그인 워크플로우)
 *   standardHeaders: true,
 *   legacyHeaders: false,
 * });
 * </pre>
 * 이 두 숫자는 <b>계약</b>이라 프로파일·프로퍼티로 덮지 않는다(덮을 수 있게 만들면 어떤 배포에서
 * {@code contract/cases/auth-negative/login-negative.contract.js}가 통과하는지가 설정에 달리게 된다).
 *
 * <h2>수식: 창 안 {@value #LIMIT}회까지는 통과, 그 <b>다음</b> 요청이 거부</h2>
 * 요청마다 카운트를 먼저 올리고 {@code count > LIMIT}면 거부한다 → 11번째 요청이 429다(Node 실측과 동일).
 * <b>모든</b> 로그인 요청을 센다 — 성공·실패·잠금(423) 결과와 무관하다(express-rate-limit 기본 동작).
 *
 * <h2>저장소는 in-memory·프로세스 로컬이다</h2>
 * DB·세션에 두지 않는다: 로그인 실패는 미인증 요청이라 세션이 없고, DB에 쓰면 무제한 행 증식 +
 * DB 비파괴 규율과 충돌한다. 프로세스 로컬이라는 사실은 계약 하네스의 전제이기도 하다 —
 * 프로파일마다 새 프로세스를 띄우므로 카운터가 격리·리셋된다(index.json decisions (6-a)).
 *
 * <h2>정리는 조회 시점에만 한다</h2>
 * {@code @Scheduled} 같은 앱 내 타이머를 만들지 않는다(ADR-008의 "앱 내 타이머 0"). 대신 항목 수가
 * {@value #SWEEP_THRESHOLD}를 넘으면 조회할 때 창이 지난 항목을 걷어낸다 — 무한 증식(메모리 DoS)을 막으면서
 * 정상 부하에서는 훑는 비용이 들지 않는다.
 *
 * <p>시각은 주입된 {@link Clock}에서만 읽는다({@code System.currentTimeMillis()} 직접 호출 금지 —
 * index.json decisions (14), 테스트 결정성의 전제).
 */
final class LoginRateLimit {

	/** 창당 허용 요청 수. */
	static final int LIMIT = 10;

	/** 창 길이(ms) — 15분. */
	static final long WINDOW_MS = 15L * 60L * 1000L;

	/** 이 수를 넘긴 시점부터 조회할 때 창 경과 항목을 걷어낸다. */
	static final int SWEEP_THRESHOLD = 1024;

	/** 클라이언트 식별자 → 창. 식별자는 <b>원격 소켓 주소</b>다(필터가 정한다). */
	private final Map<String, Window> windows = new ConcurrentHashMap<>();

	private final Clock clock;

	LoginRateLimit(Clock clock) {
		this.clock = clock;
	}

	/**
	 * 이 요청을 세고 한도를 넘겼는지 답한다.
	 *
	 * @param clientKey 클라이언트 식별자. {@code null}·공백은 <b>하나의 버킷</b>으로 묶는다
	 *     (식별 불가를 무제한으로 해석하면 그 경로가 곧 우회로다)
	 * @return 이 요청을 거부해야 하면 {@code true}
	 */
	boolean exceeded(String clientKey) {
		String key = (clientKey == null || clientKey.isBlank()) ? "" : clientKey;
		long now = this.clock.millis();
		sweepIfCrowded(now);
		Window window = this.windows.computeIfAbsent(key, (ignored) -> new Window(now));
		synchronized (window) {
			if (now - window.start >= WINDOW_MS) {
				window.start = now;
				window.count = 0;
			}
			window.count += 1;
			return window.count > LIMIT;
		}
	}

	/** 현재 보유 중인 클라이언트 항목 수(정리 규율을 테스트가 관측하는 창구). */
	int size() {
		return this.windows.size();
	}

	/**
	 * 창이 지난 항목 제거. 걷어낸 항목은 어차피 다음 조회에서 리셋될 것들이라 판정에 영향이 없다
	 * (막 만들어진 항목은 {@code start == now}라 절대 걸리지 않는다).
	 */
	private void sweepIfCrowded(long now) {
		if (this.windows.size() <= SWEEP_THRESHOLD) {
			return;
		}
		this.windows.values().removeIf((window) -> {
			synchronized (window) {
				return now - window.start >= WINDOW_MS;
			}
		});
	}

	/** 한 클라이언트의 고정 창 — 시작 시각과 그 창에서 센 요청 수. */
	private static final class Window {

		private long start;

		private int count;

		private Window(long start) {
			this.start = start;
		}

	}

}
