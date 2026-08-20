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

	@Test
	void percentEncodedPathsAreMatchedTheWayTheContainerRoutesThem() {
		// Spring 디스패처는 세그먼트를 디코딩해 핸들러를 찾는다(express는 원문으로 매칭한다).
		// 표가 원문만 보면 인코딩 한 글자로 게이트가 통째로 우회된다 — step7이 로그인 필터에서 실측한 노출이다.
		assertTrue(RoutePolicy.requiresSession("GET", "/api/artic%6Ces"),
				"디코딩하면 /api/articles다 — 미인증이면 401이어야 한다");
		assertEquals("articles-list", RoutePolicy.match("GET", "/api/artic%6Ces").id());
		assertEquals("login", RoutePolicy.match("POST", "/api/lo%67in").id());
		assertTrue(RoutePolicy.requiresSession("GET", "/api/sessio%6E"));
		assertTrue(RoutePolicy.requiresSession("POST", "/api/articles/AKR1/l%6Fck"));
		assertTrue(RoutePolicy.requiresSession("GET", "/api/logs%2Fdigest"),
				"%2F는 세그먼트 구분자로 디코딩된다");
	}

	@Test
	void encodingIsNormalizedTogetherWithTrailingSlashes() {
		assertTrue(RoutePolicy.requiresSession("GET", "/api/artic%6Ces/"),
				"인코딩 + 후행 슬래시를 겹쳐도 게이트는 그대로다");
	}

	@Test
	void rawPathsStillMatchWhenDecodingWouldNot() {
		// 판정은 원문·디코딩 <b>둘 다</b> 본다 — 넓은 쪽으로만 틀리게 만든다.
		// %2F를 디코딩하면 :id 세그먼트가 갈라져 매칭이 사라지지만, 원문 판정이 게이트를 유지한다.
		assertTrue(RoutePolicy.requiresSession("GET", "/api/articles/AKR%2F1"));
		assertEquals("articles-get", RoutePolicy.match("GET", "/api/articles/AKR%2F1").id());
	}

	@Test
	void brokenPercentEncodingIsNotAMatchAndDoesNotThrow() {
		// 깨진 인코딩은 컨테이너가 400으로 거른다 — 여기서 추측하지 않고 원문 판정만 남긴다.
		assertNull(RoutePolicy.match("GET", "/api/artic%zzles"));
		assertFalse(RoutePolicy.requiresSession("GET", "/api/artic%zzles"));
		assertNull(RoutePolicy.match("GET", "/api/artic%6"));
	}

	@Test
	void doubleEncodingIsNotDecodedTwice() {
		// 컨테이너도 한 번만 디코딩한다 — 두 번 풀면 표가 컨테이너보다 넓어져 미정의 경로가 401이 된다.
		assertNull(RoutePolicy.match("GET", "/api/artic%256Ces"));
		assertFalse(RoutePolicy.requiresSession("GET", "/api/artic%256Ces"));
	}

	@Test
	void pathParametersAreStrippedTheWayTheContainerParsesThem() {
		// Spring의 PathContainer는 세그먼트에서 `;name=value`를 떼어내고 매칭한다 —
		// 표가 원문만 보면 세미콜론 한 글자로 리터럴 경로 전체의 게이트가 우회된다(2026-08-20 실측).
		assertEquals("login", RoutePolicy.match("POST", "/api/login;x=1").id());
		assertEquals("articles-list", RoutePolicy.match("GET", "/api/articles;a=b").id());
		assertTrue(RoutePolicy.requiresSession("GET", "/api/articles;a=b"));
		assertTrue(RoutePolicy.requiresSession("GET", "/api/logs/digest;a=b"));
		assertEquals("health", RoutePolicy.match("GET", "/api/health;a=b").id());
		assertEquals("articles-search", RoutePolicy.match("GET", "/api/articles/search;a=b").id(),
				"파라미터를 떼어낸 뒤에도 리터럴 경로가 :id보다 먼저 잡혀야 한다");
	}

	@Test
	void pathParametersAreNormalizedTogetherWithEncodingAndTrailingSlashes() {
		// 세 정규화(파라미터 제거 · 후행 슬래시 · 1회 디코딩)는 같은 파이프라인이다 — 겹쳐도 게이트는 그대로다.
		assertTrue(RoutePolicy.requiresSession("GET", "/api/artic%6Ces;a=b"));
		assertEquals("articles-list", RoutePolicy.match("GET", "/api/artic%6Ces;a=b").id());
		assertEquals("login", RoutePolicy.match("POST", "/api/lo%67in;x=1").id());
		assertTrue(RoutePolicy.requiresSession("GET", "/api/articles;a=b/"));
		assertEquals("login", RoutePolicy.match("POST", "/api/login;x=1/").id());
		assertTrue(RoutePolicy.requiresSession("GET", "/api/artic%6Ces;a=b/"));
	}

	@Test
	void pathParametersOnAParameterSegmentAreStrippedToo() {
		// :id 세그먼트는 [^/]+가 `;v=2`째로 삼켜 우회가 없었지만, 파라미터를 떼어낸 뒤에도 같은 행이어야 한다
		// — 안 그러면 라우트 id가 바뀌어(예: 다른 행이 가로채) 인가 판정이 조용히 갈라진다.
		assertEquals("articles-get", RoutePolicy.match("GET", "/api/articles/AKR1;v=2").id());
		assertEquals("articles-history", RoutePolicy.match("GET", "/api/articles/AKR1;v=2/history").id());
		assertEquals("articles-lock", RoutePolicy.match("POST", "/api/articles/AKR1/lock;v=2").id());
		assertTrue(RoutePolicy.requiresSession("PUT", "/api/users/someone;v=2"));
		// 컨테이너도 이렇게 본다: 앞 세그먼트의 파라미터를 떼어내면 `/api/articles/history` = :id 경로다.
		assertEquals("articles-get", RoutePolicy.match("GET", "/api/articles;a=b/history").id());
	}

	@Test
	void unlistedPathsWithPathParametersStayUnlisted() {
		// 파라미터 제거가 표를 넓혀 미정의 경로까지 잡으면 "미정의 = 404 비-JSON" 계약이 깨진다.
		assertNull(RoutePolicy.match("GET", "/api/nope;a=b"));
		assertFalse(RoutePolicy.requiresSession("GET", "/api/nope;a=b"));
		assertNull(RoutePolicy.match("GET", "/api/articles/AKR1/nope;a=b"));
		assertFalse(RoutePolicy.requiresSession("DELETE", "/api/articles;a=b"), "메서드가 다르면 여전히 다른 라우트다");
	}

	@Test
	void anEncodedSemicolonIsJudgedWideNotNarrow() {
		// %3B는 컨테이너가 파라미터 구분자로 보지 <b>않는다</b>(디코딩 전 세그먼트에서 `;`를 찾기 때문) →
		// 컨테이너는 /api/articles%3Ba=b 를 404로 흘린다. 이 표는 디코딩한 형태에도 같은 정규화를 걸어
		// <b>세션을 요구하는 쪽</b>으로 판정한다 — 두 방향의 오류가 비대칭이라 넓은 쪽이 안전하다.
		// (이 한 줄이 400 계열로 바뀌는 것은 계약 변경이 아니라 의도적 판단이어야 한다.)
		assertTrue(RoutePolicy.requiresSession("GET", "/api/articles%3Ba=b"));
	}
}
