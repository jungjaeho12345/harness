package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

/**
 * 경로 정책 표({@link RoutePolicy})의 규율을 잠근다.
 *
 * <h2>드리프트 게이트</h2>
 * 표의 출처는 {@code docs/api-contract/endpoints.json} 39행이다. 런타임은 그 문서를 읽지 않으므로
 * (배포 산출물에 문서가 없다) 표는 Java 상수로 복제되어 있고, <b>복제본이 원본과 어긋나는 순간</b>
 * 이 테스트가 깨진다. 라우트가 늘면 인벤토리와 표를 함께 갱신하라는 요구를 사람의 기억이 아니라
 * 기계가 강제한다.
 *
 * <h2>auth 클래스를 보존한다</h2>
 * "public이 아니면 세션"으로 뭉개면 {@code auth: "token"}(수집 2건 — {@code x-collection-token} + loopback)이
 * 유효 토큰에도 401이 되고, 이 표는 후속 phase가 그대로 물려받으므로 오류가 수집 도메인까지 상속된다.
 */
class RoutePolicyTest {

	/** 인벤토리 정본 — 테스트는 리포 레이아웃 안에서 돈다(작업 디렉토리 = 모듈 루트). */
	private static final Path INVENTORY = Path.of("..", "docs", "api-contract", "endpoints.json");

	private static List<String> inventoryRows() throws IOException {
		assertTrue(Files.isRegularFile(INVENTORY),
				"인벤토리를 찾을 수 없다 — 작업 디렉토리가 모듈 루트가 아니다: " + INVENTORY.toAbsolutePath());
		String text = Files.readString(INVENTORY, StandardCharsets.UTF_8);
		Map<String, Object> root = new ObjectMapper().readValue(text, Map.class);
		@SuppressWarnings("unchecked")
		List<Map<String, Object>> routes = (List<Map<String, Object>>) root.get("routes");
		List<String> rows = new ArrayList<>();
		for (Map<String, Object> route : routes) {
			rows.add(route.get("id") + " " + route.get("method") + " " + route.get("path") + " " + route.get("auth"));
		}
		return rows;
	}

	private static List<String> tableRows() {
		List<String> rows = new ArrayList<>();
		for (RoutePolicy.Route route : RoutePolicy.ROUTES) {
			rows.add(route.id() + " " + route.method() + " " + route.path() + " " + route.auth().token());
		}
		return rows;
	}

	@Test
	void tableIsAFaithfulCopyOfTheEndpointInventory() throws IOException {
		assertEquals(inventoryRows(), tableRows(),
				"경로 정책 표가 docs/api-contract/endpoints.json 과 어긋났다 — 라우트가 늘면 표도 갱신한다");
	}

	@Test
	void everyRowIsReachableByItsOwnSampleRequest() {
		for (RoutePolicy.Route route : RoutePolicy.ROUTES) {
			String sample = route.path().replaceAll(":[A-Za-z]+", "sample");
			RoutePolicy.Route matched = RoutePolicy.match(route.method(), sample);

			assertEquals(route.id(), (matched == null) ? null : matched.id(),
					"다른 행이 이 경로를 가로챈다(선언 순서 문제): " + route.method() + " " + sample);
		}
	}

	@Test
	void literalPathsWinOverParameterizedOnes() {
		assertEquals("articles-search", RoutePolicy.match("GET", "/api/articles/search").id());
	}

	@Test
	void tokenClassRoutesDoNotRequireASession() {
		// 수집 2건은 이 phase의 필터 대상이 아니다(수집 도메인 phase 소유 — fail-closed 503 → 토큰 인증 순서 포함).
		assertFalse(RoutePolicy.requiresSession("POST", "/api/collection/receive"));
		assertFalse(RoutePolicy.requiresSession("POST", "/api/collection/pull"));
		assertEquals(RoutePolicy.AuthClass.TOKEN, RoutePolicy.match("POST", "/api/collection/receive").auth(),
				"표는 클래스를 지운 것이 아니라 보존한 채 대상에서 제외한다");
	}

	@Test
	void publicRoutesDoNotRequireASession() {
		assertFalse(RoutePolicy.requiresSession("GET", "/api/health"));
		assertFalse(RoutePolicy.requiresSession("POST", "/api/login"));
		assertFalse(RoutePolicy.requiresSession("POST", "/api/logout"));
	}

	@Test
	void everySessionFamilyClassRequiresASession() {
		assertTrue(RoutePolicy.requiresSession("GET", "/api/articles"));
		assertTrue(RoutePolicy.requiresSession("POST", "/api/articles"));
		assertTrue(RoutePolicy.requiresSession("PUT", "/api/users/someone"));
		assertTrue(RoutePolicy.requiresSession("PUT", "/api/articles/AKR1"));
		assertTrue(RoutePolicy.requiresSession("GET", "/api/logs/digest"));
	}

	@Test
	void unlistedPathsHaveNoRowAndAreLetThrough() {
		assertNull(RoutePolicy.match("GET", "/api/does-not-exist"));
		assertFalse(RoutePolicy.requiresSession("GET", "/api/does-not-exist"),
				"표에 없는 경로는 통과시켜 컨테이너 404로 흘려보낸다(/api/** 와일드카드 금지)");
		assertFalse(RoutePolicy.requiresSession("DELETE", "/api/articles"), "메서드가 다르면 다른 라우트다");
	}

	@Test
	void trailingSlashesAreNormalizedBeforeMatching() {
		assertTrue(RoutePolicy.requiresSession("GET", "/api/articles/"));
		assertTrue(RoutePolicy.requiresSession("GET", "/api/articles//"));
	}

	@Test
	void headIsMatchedAsGet() {
		// express는 HEAD를 GET 핸들러로 라우팅한다 — Node 실측도 HEAD /api/articles가 401이다.
		assertTrue(RoutePolicy.requiresSession("HEAD", "/api/articles"));
	}

	@Test
	void pathParametersDoNotSpanSlashes() {
		assertNull(RoutePolicy.match("GET", "/api/articles/one/two"),
				":id 는 세그먼트 하나만 먹는다");
	}
}
