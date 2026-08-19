package harness.spring_auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/** step4 IP 레이트리밋 — 창 안 10회 통과, 11번째 429 + RateLimit-Limit:10 + 비-JSON. 시계 주입으로 창 경계 검증. */
class LoginRateLimitFilterTest {

	private MockHttpServletRequest loginReq(String ip) {
		MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/login");
		req.setRemoteAddr(ip);
		return req;
	}

	@Test
	void eleventhLoginIsRateLimited() throws Exception {
		LoginRateLimitFilter filter = new LoginRateLimitFilter(() -> 0L);
		AtomicInteger passed = new AtomicInteger(0);

		for (int i = 1; i <= 10; i++) {
			MockHttpServletResponse res = new MockHttpServletResponse();
			MockFilterChain chain = new MockFilterChain();
			filter.doFilter(loginReq("1.2.3.4"), res, chain);
			// 통과: 체인이 호출되고 필터가 429를 쓰지 않았다.
			assertEquals(200, res.getStatus(), i + "번째 로그인은 통과해야 한다");
			passed.incrementAndGet();
		}
		assertEquals(10, passed.get());

		// 11번째 → 429, 필터가 응답(체인 미호출).
		MockHttpServletResponse res11 = new MockHttpServletResponse();
		MockFilterChain chain11 = new MockFilterChain();
		filter.doFilter(loginReq("1.2.3.4"), res11, chain11);
		assertEquals(429, res11.getStatus());
		assertEquals("10", res11.getHeader("RateLimit-Limit"));
		assertNull(chain11.getRequest(), "429는 필터가 응답한다 — 체인(라우트)은 호출되지 않는다");
	}

	@Test
	void differentIpsHaveIndependentCounters() throws Exception {
		LoginRateLimitFilter filter = new LoginRateLimitFilter(() -> 0L);
		for (int i = 0; i < 11; i++) {
			filter.doFilter(loginReq("10.0.0.1"), new MockHttpServletResponse(), new MockFilterChain());
		}
		// 다른 IP는 첫 요청이라 통과.
		MockHttpServletResponse other = new MockHttpServletResponse();
		filter.doFilter(loginReq("10.0.0.2"), other, new MockFilterChain());
		assertEquals(200, other.getStatus());
	}

	@Test
	void windowResetAllowsAgain() throws Exception {
		AtomicLong clock = new AtomicLong(0L);
		LoginRateLimitFilter filter = new LoginRateLimitFilter(clock::get);
		for (int i = 0; i < 11; i++) {
			filter.doFilter(loginReq("9.9.9.9"), new MockHttpServletResponse(), new MockFilterChain());
		}
		clock.addAndGet(LoginRateLimitFilter.WINDOW_MS); // 창 경과
		MockHttpServletResponse res = new MockHttpServletResponse();
		filter.doFilter(loginReq("9.9.9.9"), res, new MockFilterChain());
		assertEquals(200, res.getStatus(), "새 창에서는 다시 통과");
	}

	@Test
	void nonLoginRequestsBypassLimiter() throws Exception {
		LoginRateLimitFilter filter = new LoginRateLimitFilter(() -> 0L);
		for (int i = 0; i < 20; i++) {
			MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/session");
			req.setRemoteAddr("1.1.1.1");
			MockHttpServletResponse res = new MockHttpServletResponse();
			filter.doFilter(req, res, new MockFilterChain());
			assertEquals(200, res.getStatus());
		}
	}
}
