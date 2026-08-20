package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.TempNewsDb;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.ApplicationContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 필터 등록·순서 배선 — 순서가 계약의 일부다(Node의 미들웨어 등록 순서와 동형).
 *
 * <ul>
 *   <li><b>CORS가 가장 앞</b>: preflight는 CSRF·세션 판정에 도달하지 않고 끝난다.</li>
 *   <li><b>CSRF가 경로 정책보다 앞</b>: 교차 출처 쓰기는 세션을 보기 전에 403이다(403과 401이 뒤바뀌면
 *       계약 케이스가 바로 깨진다).</li>
 *   <li><b>레이트리밋이 CSRF 다음·경로 정책 앞</b>: Node도 CSRF 통과 뒤에 센다. 무엇보다 <b>라우트보다
 *       먼저</b>여야 한다 — 뒤로 밀면 한도를 넘긴 요청이 라우트에 닿아 잠긴 계정에 423만 계속 나오고
 *       429가 영영 오지 않는다(login-negative C-3).</li>
 * </ul>
 * 순서 값은 {@link FilterOrder} 한 곳에만 있다 — 등록부마다 숫자를 적으면 언젠가 어긋난다.
 */
@SpringBootTest
class FilterWiringTest {

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> TempNewsDb.sharedDataDir().toAbsolutePath().toString());
	}

	@Autowired
	private ApplicationContext context;

	private Map<String, Integer> registeredOrders() {
		Map<String, Integer> orders = new LinkedHashMap<>();
		for (FilterRegistrationBean<?> registration : this.context.getBeansOfType(FilterRegistrationBean.class).values()) {
			orders.put(registration.getFilter().getClass().getSimpleName(), registration.getOrder());
		}
		return orders;
	}

	@Test
	void theEdgeFiltersAreRegisteredWithTheDocumentedOrder() {
		Map<String, Integer> orders = registeredOrders();

		assertEquals(Integer.valueOf(FilterOrder.CORS), orders.get("CorsFilter"), "CORS 필터가 등록되지 않았다");
		assertEquals(Integer.valueOf(FilterOrder.REQUEST_LOG), orders.get("RequestLogFilter"),
				"액세스 로그 필터가 등록되지 않았다");
		assertEquals(Integer.valueOf(FilterOrder.CSRF_ORIGIN), orders.get("CsrfOriginFilter"), "CSRF 필터가 등록되지 않았다");
		assertEquals(Integer.valueOf(FilterOrder.LOGIN_RATE_LIMIT), orders.get("LoginRateLimitFilter"),
				"로그인 레이트리밋 필터가 등록되지 않았다");
		assertEquals(Integer.valueOf(FilterOrder.PATH_POLICY), orders.get("PathPolicyFilter"), "경로 정책 필터가 등록되지 않았다");
	}

	@Test
	void corsRunsBeforeCsrfAndCsrfBeforeTheRateLimitAndThePathPolicyIsLast() {
		assertTrue(FilterOrder.CORS < FilterOrder.REQUEST_LOG,
				"preflight는 CORS에서 끝나므로 액세스 로그에 남지 않는다(Node 동형)");
		assertTrue(FilterOrder.REQUEST_LOG < FilterOrder.CSRF_ORIGIN,
				"액세스 로그가 CSRF보다 뒤면 거부된 교차 출처 쓰기가 로그에 남지 않는다(ADR-009 등록 위치)");
		assertTrue(FilterOrder.CORS < FilterOrder.CSRF_ORIGIN,
				"preflight가 CSRF에 도달하면 비허용 출처 preflight가 403이 된다(계약은 2xx)");
		assertTrue(FilterOrder.CSRF_ORIGIN < FilterOrder.LOGIN_RATE_LIMIT,
				"교차 출처 쓰기는 예산을 쓰기 전에 403이어야 한다(Node도 CSRF 통과 뒤에 센다)");
		assertTrue(FilterOrder.LOGIN_RATE_LIMIT < FilterOrder.PATH_POLICY,
				"레이트리밋은 라우트에 가장 가까운 경로 정책보다도 앞이다 — 라우트가 먼저 응답하면 429가 오지 않는다");
	}
}
