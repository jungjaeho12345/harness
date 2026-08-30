package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import harness.news.testsupport.TempNewsDb;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * <b>스텁 금지의 자동 게이트</b> — 이 서버에 핸들러가 붙은 라우트의 <b>정확한 집합</b>을 잠근다.
 *
 * <h2>왜 이 테스트가 필요한가(2026-08-20 테스트 게이트 발견)</h2>
 * phase 68은 39 라우트 중 7개만 구현하고 "미구현 라우트에 스텁을 만들지 않는다"를 핵심 규율로 삼는다
 * (index.json decisions (8)(1)·(18)(b) — 흡수 검토한 클라우드 브랜치가 {@code ok:true}·빈 {@code items}
 * 스텁으로 실제로 저지른 결함이다). 그런데 그 규율을 지키는 <b>자동 게이트가 없었다</b>: 누군가
 * {@code GET /api/articles}에 {@code {"ok":true,"items":[]}} 스텁을 붙여도
 * <ul>
 *   <li>계약 스위트는 그 라우트의 케이스를 아직 돌리지 않으므로 6파일 31케이스가 <b>그대로 green</b>이고,</li>
 *   <li>미인증 401은 여전히 경로 정책 필터가 만들므로 {@code session-guard} 케이스도 green이며,</li>
 *   <li>패리티 diff도 그 라우트를 관측하지 않으므로 <b>0</b>이다.</li>
 * </ul>
 * 즉 스텁은 <b>모든 게이트에 보이지 않은 채</b> "구현이 늘어난 것 같은" 착시만 남긴다. 그 착시가 바로
 * 이 phase가 경계하는 패리티 거짓 신호다. 이 테스트가 그 구멍을 메운다.
 *
 * <h2>이 테스트가 깨졌을 때 할 일</h2>
 * 라우트를 <b>진짜로</b> 구현했다면 (1) 아래 {@link #IMPLEMENTED_ROUTES}에 행을 추가하고
 * (2) <b>같은 커밋에서</b> 그 라우트의 계약 케이스 파일을 {@code scripts/spring-contract.mjs}의 scope 표에
 * 넣어라(index.json decisions (8)(5): 구현한 라우트는 반드시 계약으로 잠근다). 목록만 늘리고 계약을
 * 늘리지 않으면 이 테스트는 다시 green이 되지만 검증되지 않은 구현이 쌓인다 — 목록 갱신은
 * "계약도 같이 늘렸다"는 선언이다.
 */
@SpringBootTest
class HandlerInventoryTest {

	/**
	 * 구현된 38 라우트 — phase 68이 만든 7개 + phase 69 step0의 {@code GET /api/users} +
	 * step7의 기사 단건 3개({@code POST /api/articles} · {@code GET /api/articles/{id}} ·
	 * {@code PUT /api/articles/{id}}) + step8의 편집 잠금 3개({@code POST /api/articles/{id}/lock} ·
	 * {@code .../unlock} · {@code .../force-unlock}) + step10의 생애주기 2개
	 * ({@code POST /api/articles/{id}/action} · {@code POST /api/articles/{id}/derive}) + step11의
	 * 조회 4개({@code GET /api/articles/search} · {@code GET /api/articles} ·
	 * {@code GET /api/articles/{id}/history} · {@code GET /api/articles/{id}/history/{historyId}}) +
	 * phase 70 step3의 수집 수신 설정 3개({@code GET /api/receiver-config} ·
	 * {@code POST /api/receiver-config} · {@code DELETE /api/receiver-config/{id}}) +
	 * phase 70 step6의 배부 대상 4개({@code GET /api/distribution-targets} ·
	 * {@code POST /api/distribution-targets} · {@code PUT /api/distribution-targets/{id}} ·
	 * {@code POST /api/distribution-targets/{id}/deactivate}) + <b>phase 71 step5의 수집 인제스트 2개</b>
	 * ({@code POST /api/collection/receive} · {@code POST /api/collection/pull}) +
	 * <b>phase 72 step9의 배부 실행 3개</b>({@code POST /api/distribution/tick} ·
	 * {@code GET /api/distribution/failures} · {@code POST /api/distribution/retry}) +
	 * <b>phase 73 step9의 미디어·업로드·사진·번역 5개</b>({@code GET /api/media/search} ·
	 * {@code POST /api/upload} · {@code POST /api/photos} · {@code GET /api/photos/search} ·
	 * {@code POST /api/articles/{id}/translate}) + <b>phase 74 step4의 무효화 신호 스트림 1개</b>
	 * ({@code GET /api/stream} — ADR-005·ADR-015. 남은 미구현은 {@code GET /api/logs/stream} 하나이고
	 * 그것이 붙으면 39/39다)다.
	 * {@code server-spring/README.md}·index.json forward_notes (2)와 같은 목록이며 표기는 Spring 매핑
	 * 원문({@code {userId}})이다. 행을 늘릴 때는 아래 테스트 메서드 이름과 실패 메시지의 <b>라우트 수</b>도
	 * 같이 고쳐라 — 수치가 목록과 어긋나면 이 테스트가 주장하는 문장이 거짓이 된다(같은 커밋에서 이동).
	 *
	 * <p><b>{@code DELETE /api/distribution-targets/:id}는 없다</b> — 핸들러 미등록 404가 계약이다(제거는
	 * deactivate뿐). phase 70 step6이 scope 표에 {@code distribution-targets.contract.js}(default)를
	 * 올리면서 이 4행도 계약 관측을 갖는다. "구현했는데 계약이 관측하지 않는 라우트"는 <b>0개</b>다.
	 */
	private static final List<String> IMPLEMENTED_ROUTES = List.of(
			"DELETE /api/receiver-config/{id}",
			"GET /api/articles",
			"GET /api/articles/search",
			"GET /api/articles/{id}",
			"GET /api/articles/{id}/history",
			"GET /api/articles/{id}/history/{historyId}",
			"GET /api/distribution-targets",
			"GET /api/distribution/failures",
			"GET /api/health",
			"GET /api/logs/digest",
			"GET /api/media/search",
			"GET /api/photos/search",
			"GET /api/receiver-config",
			"GET /api/session",
			"GET /api/stream",
			"GET /api/users",
			"POST /api/articles",
			"POST /api/articles/{id}/action",
			"POST /api/articles/{id}/derive",
			"POST /api/articles/{id}/force-unlock",
			"POST /api/articles/{id}/lock",
			"POST /api/articles/{id}/translate",
			"POST /api/articles/{id}/unlock",
			"POST /api/collection/pull",
			"POST /api/collection/receive",
			"POST /api/distribution-targets",
			"POST /api/distribution-targets/{id}/deactivate",
			"POST /api/distribution/retry",
			"POST /api/distribution/tick",
			"POST /api/login",
			"POST /api/logout",
			"POST /api/photos",
			"POST /api/receiver-config",
			"POST /api/upload",
			"POST /api/users",
			"PUT /api/articles/{id}",
			"PUT /api/distribution-targets/{id}",
			"PUT /api/users/{userId}");

	/**
	 * 이 phase가 <b>쓰지 않은</b> 프레임워크 매핑 — Boot 기본 {@code BasicErrorController}다.
	 * 인벤토리에 없는 Spring 전용 표면이며, index.json forward_notes (13)이 기록한
	 * "405·415의 응답 shape이 이 서버의 다른 에러와 다르다"({@code {ok:false,reason:...}}가 아닌
	 * charset 없는 Boot {@code /error} JSON)의 <b>출처</b>다. Node에는 이 경로가 없다(404 HTML).
	 * 계약이 그 축을 동결하지 않아 게이트는 green이지만, 존재 자체는 여기서 명시적으로 잠근다 —
	 * 조용히 무시하면 "핸들러는 선언한 20개뿐"이라는 문장이 사실과 어긋난 채로 남는다.
	 */
	private static final List<String> FRAMEWORK_ROUTES = List.of("ANY /error");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> TempNewsDb.sharedDataDir().toAbsolutePath().toString());
	}

	@Autowired
	private RequestMappingHandlerMapping handlerMapping;

	/** 디스패처에 등록된 매핑 전부를 {@code "METHOD 경로"} 문자열로 편다(정렬 = 비교 안정성). */
	private Set<String> mappedRoutes() {
		Set<String> routes = new TreeSet<>();
		for (Map.Entry<RequestMappingInfo, HandlerMethod> entry : this.handlerMapping.getHandlerMethods().entrySet()) {
			RequestMappingInfo info = entry.getKey();
			Set<RequestMethod> methods = info.getMethodsCondition().getMethods();
			for (String pattern : info.getPatternValues()) {
				if (methods.isEmpty()) {
					routes.add("ANY " + pattern); // 메서드 제약 없는 매핑은 그 자체가 규율 위반이다.
					continue;
				}
				for (RequestMethod method : methods) {
					routes.add(method.name() + " " + pattern);
				}
			}
		}
		return routes;
	}

	@Test
	void exactlyTheThirtyEightImplementedRoutesHaveHandlers() {
		Set<String> expected = new TreeSet<>(IMPLEMENTED_ROUTES);
		expected.addAll(FRAMEWORK_ROUTES);

		assertEquals(expected, mappedRoutes(),
				"핸들러 집합이 선언된 38 라우트(+ Boot 기본 /error)와 다르다 — "
						+ "스텁이 늘었거나(패리티 착시) 구현이 늘었는데 계약 scope 표를 갱신하지 않았다");
	}

	@Test
	void everyHandlerCorrespondsToARowOfTheEndpointInventory() {
		List<String> orphans = new ArrayList<>();
		for (String route : mappedRoutes()) {
			if (FRAMEWORK_ROUTES.contains(route)) {
				continue; // 프레임워크 표면 — 위 상수가 별도로 잠근다.
			}
			String[] parts = route.split(" ", 2);
			// {userId} 같은 템플릿 변수를 구체 세그먼트로 바꿔 표에 물어본다(표는 요청 경로를 받는다).
			String concrete = parts[1].replaceAll("\\{[^/}]+\\}", "sample");
			if (RoutePolicy.match(parts[0], concrete) == null) {
				orphans.add(route);
			}
		}
		assertEquals(List.of(), orphans,
				"인벤토리(docs/api-contract/endpoints.json)에 없는 경로에 핸들러가 붙었다 — "
						+ "계약이 존재하지 않는 표면이므로 패리티로 측정할 수 없다");
	}

	@Test
	void noImplementedRouteIsMissingFromTheMapping() {
		Set<String> mapped = mappedRoutes();
		List<String> missing = new ArrayList<>();
		for (String route : IMPLEMENTED_ROUTES) {
			if (!mapped.contains(route)) {
				missing.add(route);
			}
		}
		// 매핑 조회가 조용히 빈 집합을 돌려주면 위 정확 비교가 "0건 대 0건"으로 통과할 수 있는 형태로
		// 변질될 수 있다 — 실제 라우트가 거기 있다는 사실을 별도로 단언해 동어반복을 막는다.
		assertNotNull(this.handlerMapping, "RequestMappingHandlerMapping 빈이 없다 — webmvc 배선이 깨졌다");
		assertEquals(List.of(), missing, "선언된 구현 라우트가 디스패처에 등록되지 않았다");
	}
}
