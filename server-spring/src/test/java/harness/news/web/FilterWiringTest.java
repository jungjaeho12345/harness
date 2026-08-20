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
	void theThreeEdgeFiltersAreRegisteredWithTheDocumentedOrder() {
		Map<String, Integer> orders = registeredOrders();

		assertEquals(Integer.valueOf(FilterOrder.CORS), orders.get("CorsFilter"), "CORS 필터가 등록되지 않았다");
		assertEquals(Integer.valueOf(FilterOrder.CSRF_ORIGIN), orders.get("CsrfOriginFilter"), "CSRF 필터가 등록되지 않았다");
		assertEquals(Integer.valueOf(FilterOrder.PATH_POLICY), orders.get("PathPolicyFilter"), "경로 정책 필터가 등록되지 않았다");
	}

	@Test
	void corsRunsBeforeCsrfAndCsrfBeforeThePathPolicy() {
		assertTrue(FilterOrder.CORS < FilterOrder.CSRF_ORIGIN,
				"preflight가 CSRF에 도달하면 비허용 출처 preflight가 403이 된다(계약은 2xx)");
		assertTrue(FilterOrder.CSRF_ORIGIN < FilterOrder.PATH_POLICY,
				"교차 출처 쓰기는 세션 판정보다 먼저 403이어야 한다");
	}
}
