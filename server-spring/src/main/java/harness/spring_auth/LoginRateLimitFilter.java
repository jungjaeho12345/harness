package harness.spring_auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * POST /api/login IP 레이트리밋 — 15분/10회(express-rate-limit loginLimiter와 동형). 창 안 10회까지 통과,
 * **11번째 요청이 429**. 429는 라우트가 아니라 이 필터가 응답한다 → 본문이 JSON이 아니다(text/html):
 *   "모든 거부는 {ok,reason}" 규칙의 유일한 예외이며 그 예외가 계약이다. 헤더 RateLimit-Limit: 10.
 * 인메모리 프로세스 로컬 카운터(auth-negative는 전용 프로세스라 카운터가 격리된다). 시계 주입(테스트 결정성).
 */
public class LoginRateLimitFilter extends OncePerRequestFilter {

	static final int LIMIT = 10;
	static final long WINDOW_MS = 15L * 60L * 1000L;
	// Node express-rate-limit 기본 429 본문(파싱 대상 아님 — content-type/헤더만 계약이 본다).
	private static final byte[] BODY =
			"Too many requests, please try again later.".getBytes(StandardCharsets.UTF_8);

	private static final class Window {
		long start;
		int count;

		Window(long start) {
			this.start = start;
		}
	}

	private final ConcurrentHashMap<String, Window> counters = new ConcurrentHashMap<>();
	private final LongSupplier clock;

	public LoginRateLimitFilter() {
		this(System::currentTimeMillis);
	}

	public LoginRateLimitFilter(LongSupplier clock) {
		this.clock = clock;
	}

	@Override
	protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
			throws ServletException, IOException {
		if (!"POST".equalsIgnoreCase(req.getMethod()) || !"/api/login".equals(req.getRequestURI())) {
			chain.doFilter(req, res);
			return;
		}
		if (overLimit(req.getRemoteAddr())) {
			reject(res);
			return;
		}
		chain.doFilter(req, res);
	}

	/** IP별 고정 15분 창 카운터 증가 후 한도 초과 여부. 창 밖이면 리셋. count>LIMIT면 초과(11번째). */
	private boolean overLimit(String ip) {
		String key = ip == null ? "" : ip;
		Window w = counters.computeIfAbsent(key, (k) -> new Window(clock.getAsLong()));
		synchronized (w) {
			long now = clock.getAsLong();
			if (now - w.start >= WINDOW_MS) {
				w.start = now;
				w.count = 0;
			}
			w.count += 1;
			return w.count > LIMIT;
		}
	}

	private void reject(HttpServletResponse res) throws IOException {
		res.setStatus(429);
		res.setHeader("RateLimit-Limit", String.valueOf(LIMIT));
		// Node express-rate-limit의 'text/html; charset=utf-8'와 바이트 동일(공백 포함) — 컨테이너 정규화 우회.
		ResponseContentType.set(res, "text/html; charset=utf-8");
		res.getOutputStream().write(BODY);
	}
}
