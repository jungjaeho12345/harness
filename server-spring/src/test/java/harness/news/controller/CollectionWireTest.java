package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.config.CollectionProperties;
import harness.news.model.ArticleAggregate;
import harness.news.model.ArticleRepository;
import harness.news.model.ContentsProjection;
import harness.news.model.ReceiverConfigRepository;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * 수집 인제스트 2라우트({@code POST /api/collection/receive} · {@code POST /api/collection/pull})의
 * <b>와이어</b> 계약. 계약 3파일이 서로 다른 서버 구성에서 관측하는 것과 같은 축을 원시 HTTP로 잠근다:
 * {@code contract/cases/default/collection.contract.js}(loopback + 토큰) ·
 * {@code minimal/collection-open.contract.js}(loopback + 무토큰) ·
 * {@code failclosed/collection-disabled.contract.js}(비-loopback + 무토큰).
 *
 * <h2>구성이 곧 계약이라 컨텍스트가 셋이다</h2>
 * 이 파일에는 {@code @SpringBootTest} 클래스가 셋 있다 — 같은 라우트가 <b>서버 구성에 따라</b> 다른 답을
 * 내는 것이 이 phase의 핵심 계약이기 때문이다. 세 구성을 한 컨텍스트에서 흉내 내려면 판정 입력을
 * 런타임에 갈아끼우는 뒷문이 필요한데, 그 뒷문 자체가 fail-closed의 방어를 무너뜨린다.
 *
 * <h2>세션을 쓰지 않는다</h2>
 * 수집 2라우트는 {@code AuthClass.TOKEN}(requiresSession=false)이다 — 픽스처(수신 설정 등록·기사 되읽기)도
 * 세션 라우트가 아니라 <b>리포지토리 직접</b>으로 만든다. 세션 헤더가 하나라도 필요해지면 그것은 이 라우트에
 * 세션 게이트가 붙었다는 뜻이고 계약 3파일이 전부 401로 red가 된다.
 *
 * <p>토큰 값은 이 파일 안에서만 쓰는 테스트 리터럴이다(운영 비밀 아님). 응답·로그에 실리지 않는 것을
 * 별도로 단언한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "app.collection.token=" + CollectionWireFixtures.TOKEN)
class CollectionWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("collection-wire-default");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private ReceiverConfigRepository configs;

	@Autowired
	private ArticleRepository articles;

	// --- 1. 토큰 가드 --------------------------------------------------------------------------

	@Test
	void aMissingOrWrongTokenIs401OnBothRoutesAndNeverReachesTheService() {
		String sourceId = CollectionWireFixtures.register(this.configs, Map.of());
		String marker = CollectionWireFixtures.unique("cw-401-marker");

		for (String path : List.of("/api/collection/receive", "/api/collection/pull")) {
			Wire.Response missing = Wire.json(this.port, "POST", path, Map.of(),
					"{\"sourceId\":\"" + sourceId + "\",\"payload\":\"" + marker + "\\n본문\"}");
			assertEquals(401, missing.status(), path + " 토큰 헤더 없음");
			assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", missing.body());
			assertEquals("Content-Type: application/json; charset=utf-8", missing.line("content-type"));

			Wire.Response wrong = Wire.json(this.port, "POST", path,
					Map.of(CollectionWireFixtures.HEADER, "wire-wrong-token"),
					"{\"sourceId\":\"" + sourceId + "\",\"payload\":\"" + marker + "\\n본문\"}");
			assertEquals(401, wrong.status(), path + " 틀린 토큰");
			assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", wrong.body());
		}

		// 서비스까지 가지 않았다 — 401 경로에서 기사가 만들어지면 인증 이전에 등록이 일어난 것이다.
		assertEquals(0, CollectionWireFixtures.articlesContaining(this.articles, marker),
				"401로 끊긴 요청이 기사를 등록했다");
	}

	/**
	 * <b>가드가 본문 판독보다 앞이다</b> — 토큰이 틀리면 깨진 JSON도 <b>파싱하지 않고</b> 401이다.
	 *
	 * <p>Node는 {@code express.json()}이 라우트보다 먼저 돌아 같은 요청이 <b>500</b>({@code internal-error})이
	 * 된다(전역 에러 핸들러 — {@code server/index.js} 1244행). 계약 3파일은 깨진 본문을 보내지 않아 이 축을
	 * 관측하지 못한다. <b>안전 방향의 의도된 divergence</b>다: 신원이 확인되지 않은 요청의 바이트를 파서에
	 * 먹이지 않는다. 이 테스트는 그 순서가 <b>우연이 아니라 계약</b>임을 못 박는다 — 판독을 가드 위로
	 * 올리는 리팩터링이 들어오면 여기서 red가 난다.
	 */
	@Test
	void aMalformedBodyIsRejectedByTheTokenGuardBeforeItIsEverParsed() {
		for (String path : List.of("/api/collection/receive", "/api/collection/pull")) {
			Wire.Response broken = Wire.json(this.port, "POST", path, Map.of(), "{\"sourceId\": ");

			assertEquals(401, broken.status(), path + " 깨진 본문보다 토큰 가드가 앞이다(Node는 500)");
			assertEquals("{\"ok\":false,\"reason\":\"unauthenticated\"}", broken.body());
		}

		// 토큰이 맞으면 그때 비로소 판독하고, 깨진 본문은 전역 핸들러가 500으로 만든다(Node와 같은 코드).
		Wire.Response parsed = Wire.json(this.port, "POST", "/api/collection/receive",
				Map.of(CollectionWireFixtures.HEADER, CollectionWireFixtures.TOKEN), "{\"sourceId\": ");

		assertEquals(500, parsed.status(), "인증된 요청의 깨진 본문은 판독 실패로 500이다");
	}

	// --- 2. 서비스 판정(403/200) ------------------------------------------------------------------

	@Test
	void anUnregisteredSourceIs403UnregisteredAndAnInactiveOneIs403Inactive() {
		Wire.Response unregistered = receive(CollectionWireFixtures.unique("cw-never"), "\"제목\\n본문\"");
		assertEquals(403, unregistered.status());
		assertEquals("{\"ok\":false,\"reason\":\"unregistered\"}", unregistered.body());

		String inactive = CollectionWireFixtures.register(this.configs, Map.of("active", "N"));
		Wire.Response denied = receive(inactive, "\"제목\\n본문\"");
		assertEquals(403, denied.status(), "비활성 소스는 unregistered가 아니라 inactive다");
		assertEquals("{\"ok\":false,\"reason\":\"inactive\"}", denied.body());
	}

	@Test
	void aRegisteredSourceIsCollectedWithTheFirstLineAsTitleAndTheAutoAttribute() {
		String sourceId = CollectionWireFixtures.register(this.configs, Map.of());
		String title = CollectionWireFixtures.unique("cw-title");

		Wire.Response response = receive(sourceId, "\"" + title + "\\n" + title + " 본문 줄\"");

		assertEquals(200, response.status());
		assertEquals(List.of("ok", "articleId"), CollectionWireFixtures.keysOf(response.body()),
				"성공 응답은 {ok,articleId} 2키뿐이다: " + response.body());
		String articleId = CollectionWireFixtures.articleIdOf(response.body());

		Map<String, Object> row = CollectionWireFixtures.contentsOf(this.articles, articleId);
		assertEquals(title, row.get("title"), "문자열 payload의 첫 줄이 제목이다");
		assertEquals("자동기사", row.get("attribute"));
		assertEquals("RDS", row.get("status"), "수집 기사는 초기 상태 RDS다");
		assertEquals(List.of(title, title + " 본문 줄"),
				CollectionWireFixtures.blockTexts(this.articles, articleId));
	}

	@Test
	void aMissingPayloadIsStillA200WithAnEmptyArticle() {
		String sourceId = CollectionWireFixtures.register(this.configs, Map.of());

		Wire.Response response = Wire.json(this.port, "POST", "/api/collection/receive",
				Map.of(CollectionWireFixtures.HEADER, CollectionWireFixtures.TOKEN),
				"{\"sourceId\":\"" + sourceId + "\"}");

		assertEquals(200, response.status(), "payload 누락은 400이 아니다(입력 검증이 없다는 것이 계약)");
		String articleId = CollectionWireFixtures.articleIdOf(response.body());
		Map<String, Object> row = CollectionWireFixtures.contentsOf(this.articles, articleId);
		assertEquals("", row.get("title"));
		assertEquals("자동기사", row.get("attribute"));
		assertEquals(List.of(""), CollectionWireFixtures.blockTexts(this.articles, articleId));
	}

	// --- 3. 응답에 입력이 반향되지 않는다 -----------------------------------------------------------

	@Test
	void theResponseNeverEchoesTheTokenOrThePayload() {
		String sourceId = CollectionWireFixtures.register(this.configs, Map.of());
		String secretish = "cw-payload-marker-9f2c";

		Wire.Response ok = receive(sourceId, "\"" + secretish + "\\n본문\"");
		assertEquals(200, ok.status());
		assertFalse(ok.body().contains(secretish), "수집 본문이 응답에 반향됐다");
		assertFalse(ok.body().contains(CollectionWireFixtures.TOKEN), "수집 토큰이 응답에 실렸다");

		Wire.Response denied = receive(CollectionWireFixtures.unique("cw-never"), "\"" + secretish + "\"");
		assertEquals(403, denied.status());
		assertFalse(denied.body().contains(secretish));
		assertFalse(denied.body().contains(CollectionWireFixtures.TOKEN));
	}

	// --- 4. sourceId 값 바인딩은 Node 정책 그대로(관대해지면 남의 소스에 닿는다) ---------------------

	/**
	 * Node는 {@code receiverConfigModel.query({ sourceId })}에 클라이언트 값을 <b>그대로</b> 내려보내고
	 * {@code node:sqlite}가 문자열·숫자 외 타입에 TypeError를 던져 전역 핸들러가 500을 만든다. Spring도
	 * {@code ColumnValues} 단일 출처가 같은 자리에서 거부한다 — 조용히 문자열화하면 {@code true}·객체가
	 * {@code "true"}·{@code "{a=1}"} 같은 <b>새 sourceId</b>가 되어 두 서버가 갈린다.
	 */
	@Test
	void nonScalarSourceIdsFailClosedWith500LikeNodesDriverDoes() {
		for (String literal : List.of("true", "[\"a\",\"b\"]", "{\"a\":1}")) {
			Wire.Response response = Wire.json(this.port, "POST", "/api/collection/receive",
					Map.of(CollectionWireFixtures.HEADER, CollectionWireFixtures.TOKEN),
					"{\"sourceId\":" + literal + ",\"payload\":\"제목\"}");
			assertEquals(500, response.status(), literal + " sourceId");
			assertEquals("{\"ok\":false,\"reason\":\"internal-error\"}", response.body());
		}
	}

	// --- 5. 한글 왕복 ---------------------------------------------------------------------------

	@Test
	void koreanTitleAndBodySurviveTheRoundTripByteForByte() {
		String sourceId = CollectionWireFixtures.register(this.configs, Map.of());
		String title = "수집 제목 한글 " + CollectionWireFixtures.unique("가");
		String body = "본문 첫째 줄 — 따옴표 \\\" 포함";

		Wire.Response response = receive(sourceId, "\"" + title + "\\n" + body + "\"");
		assertEquals(200, response.status());

		String articleId = CollectionWireFixtures.articleIdOf(response.body());
		Map<String, Object> row = CollectionWireFixtures.contentsOf(this.articles, articleId);
		assertEquals(title, row.get("title"));
		assertEquals(List.of(title, "본문 첫째 줄 — 따옴표 \" 포함"),
				CollectionWireFixtures.blockTexts(this.articles, articleId));
	}

	// --- 6. 반복 x-collection-token 헤더(Node 동형) --------------------------------------------------

	/**
	 * 2026-08-25 실측(express + Node http 파서): 같은 헤더를 두 줄 보내면 {@code req.get}은
	 * {@code "GOOD, BAD"}처럼 {@code ", "}로 <b>결합된 한 문자열</b>을 준다. 결합 문자열은 실제 토큰과
	 * 다르므로 <b>순서와 무관하게 401</b>이고, 같은 값을 두 번 보내도 401이다.
	 *
	 * <p>Spring {@code getHeader}는 <b>첫 값만</b> 주므로 순진한 구현은 (i)에서 통과해 갈린다 —
	 * 계약이 관측하지 않는 축이라 게이트가 잡아 주지 않는다. 이 테스트가 유일한 그물이다.
	 */
	@Test
	void aRepeatedTokenHeaderIsJoinedLikeNodeSoItNeverAuthenticates() {
		String sourceId = CollectionWireFixtures.register(this.configs, Map.of());
		String marker = CollectionWireFixtures.unique("cw-dup-marker");

		Wire.Response correctThenWrong = receiveWithRawTokenHeader(sourceId, marker,
				CollectionWireFixtures.TOKEN + "\r\n" + CollectionWireFixtures.HEADER + ": wire-wrong-token");
		assertEquals(401, correctThenWrong.status(),
				"첫 값만 보면 통과한다 — Node는 결합 문자열이라 401이다");

		Wire.Response wrongThenCorrect = receiveWithRawTokenHeader(sourceId, marker,
				"wire-wrong-token\r\n" + CollectionWireFixtures.HEADER + ": " + CollectionWireFixtures.TOKEN);
		assertEquals(401, wrongThenCorrect.status());

		Wire.Response twiceCorrect = receiveWithRawTokenHeader(sourceId, marker,
				CollectionWireFixtures.TOKEN + "\r\n" + CollectionWireFixtures.HEADER + ": "
						+ CollectionWireFixtures.TOKEN);
		assertEquals(401, twiceCorrect.status(), "같은 값을 두 번 보내도 Node는 401이다");

		assertEquals(0, CollectionWireFixtures.articlesContaining(this.articles, marker),
				"반복 헤더 요청이 기사를 등록했다");
	}

	// --- 도구 ------------------------------------------------------------------------------------

	private Wire.Response receive(String sourceId, String payloadLiteral) {
		return Wire.json(this.port, "POST", "/api/collection/receive",
				Map.of(CollectionWireFixtures.HEADER, CollectionWireFixtures.TOKEN),
				"{\"sourceId\":\"" + sourceId + "\",\"payload\":" + payloadLiteral + "}");
	}

	/**
	 * 헤더 줄을 <b>원문 그대로</b> 조립한다 — {@link Wire}의 헤더 맵은 이름당 한 값이라, 반복 헤더는
	 * 값 안에 다음 헤더 줄을 이어 붙여 만든다(테스트 전용 원시 클라이언트이므로 가능한 조립이다).
	 */
	private Wire.Response receiveWithRawTokenHeader(String sourceId, String marker, String rawHeaderValue) {
		return Wire.json(this.port, "POST", "/api/collection/receive",
				Map.of(CollectionWireFixtures.HEADER, rawHeaderValue),
				"{\"sourceId\":\"" + sourceId + "\",\"payload\":\"" + marker + "\\n본문\"}");
	}

}

/**
 * 토큰 <b>미설정</b> + loopback 바인딩(minimal 프로파일) — 이 서버는 {@code x-collection-token} 헤더를
 * 읽지도 않는다. 그것이 취약점이 아니라 계약이다: 방어는 loopback 바인딩이고 토큰은 밖으로 열 때
 * 필요한 <b>추가</b> 방어다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "app.collection.token=")
class CollectionOpenWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("collection-wire-open");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private ReceiverConfigRepository configs;

	@Autowired
	private ArticleRepository articles;

	@Test
	void withoutAConfiguredTokenTheRequestReachesTheServiceGate() {
		Wire.Response response = Wire.json(this.port, "POST", "/api/collection/receive", Map.of(),
				"{\"sourceId\":\"" + CollectionWireFixtures.unique("cw-never") + "\",\"payload\":\"제목\"}");

		assertEquals(403, response.status(), "401이면 토큰 게이트가 살아 있다는 뜻이다");
		assertEquals("{\"ok\":false,\"reason\":\"unregistered\"}", response.body());
	}

	@Test
	void aRegisteredSourceIsCollectedWithoutAnyTokenHeader() {
		String sourceId = CollectionWireFixtures.register(this.configs, Map.of());
		String title = CollectionWireFixtures.unique("cw-open");

		Wire.Response response = Wire.json(this.port, "POST", "/api/collection/receive", Map.of(),
				"{\"sourceId\":\"" + sourceId + "\",\"payload\":\"" + title + "\\n본문\"}");

		assertEquals(200, response.status());
		assertEquals(List.of("ok", "articleId"), CollectionWireFixtures.keysOf(response.body()));
		Map<String, Object> row = CollectionWireFixtures.contentsOf(this.articles,
				CollectionWireFixtures.articleIdOf(response.body()));
		assertEquals(title, row.get("title"));
		assertEquals("자동기사", row.get("attribute"));
		assertEquals("RDS", row.get("status"));
	}

	@Test
	void anyTokenHeaderIsIgnoredWhenTheServerHasNoTokenConfigured() {
		String sourceId = CollectionWireFixtures.register(this.configs, Map.of());

		Wire.Response response = Wire.json(this.port, "POST", "/api/collection/receive",
				Map.of(CollectionWireFixtures.HEADER, "wire-ignored-token"),
				"{\"sourceId\":\"" + sourceId + "\",\"payload\":\"제목\"}");

		assertEquals(200, response.status(), "토큰 미설정 서버는 헤더 값을 비교하지 않는다(401 아님)");
		assertEquals(List.of("ok", "articleId"), CollectionWireFixtures.keysOf(response.body()));
	}

}

/**
 * 비-loopback 바인딩({@code server.address=0.0.0.0}) + 토큰 미설정(failclosed 프로파일) — 두 수집
 * 라우트에 방어가 하나도 남지 않으므로 서버가 <b>기능 자체를 제공하지 않는다</b>(503).
 *
 * <h2>이 클래스가 잠그는 med 축: 바인드 주소의 단일 출처</h2>
 * {@code app.collection.host}는 반드시 {@code server.address}(= 실제 바인드 주소)에서 파생해야 한다.
 * {@code ${HOST:127.0.0.1}}를 한 벌 더 쓰면 {@code SERVER_ADDRESS}만 설정된 배포에서 Tomcat은 전
 * 인터페이스에 열리는데 fail-closed 판정은 {@code 127.0.0.1}로 남아 <b>수집 2라우트가 무토큰으로
 * 개방</b>된다. 여기서는 {@code server.address}만 바꾸고 <b>행동(503)</b>으로 그 파생을 단언한다 —
 * 문자열 비교로 잠그면 파생 규칙이 바뀌어도 통과하는 공허한 테스트가 된다.
 *
 * <p>이 컨텍스트는 {@code mvnw verify} 안에서 java를 0.0.0.0에 바인드한다. phase 71 step0의
 * {@code --profile failclosed --boot-check} 실측이 정상(health 5.6s · 방화벽 프롬프트 없음)이었으므로
 * step5.md G-3의 판단 기준에 따라 {@code RANDOM_PORT}(실제 바인드)를 유지한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = { "server.address=0.0.0.0", "app.collection.token=" })
class CollectionDisabledWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("collection-wire-failclosed");

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private CollectionProperties properties;

	@Autowired
	private ReceiverConfigRepository configs;

	@Autowired
	private ArticleRepository articles;

	@Test
	void bothCollectionRoutesAre503CollectionDisabledEvenWithATokenHeader() {
		String sourceId = CollectionWireFixtures.register(this.configs, Map.of());
		String marker = CollectionWireFixtures.unique("cw-503-marker");

		for (String path : List.of("/api/collection/receive", "/api/collection/pull")) {
			Wire.Response anonymous = Wire.json(this.port, "POST", path, Map.of(),
					"{\"sourceId\":\"" + sourceId + "\",\"payload\":\"" + marker + "\\n본문\"}");
			assertEquals(503, anonymous.status(), path + " (fail-closed)");
			assertEquals("{\"ok\":false,\"reason\":\"collection-disabled\"}", anonymous.body());
			assertEquals(List.of("ok", "reason"), CollectionWireFixtures.keysOf(anonymous.body()));
			assertEquals("Content-Type: application/json; charset=utf-8", anonymous.line("content-type"));

			Wire.Response withToken = Wire.json(this.port, "POST", path,
					Map.of(CollectionWireFixtures.HEADER, "wire-any-token"),
					"{\"sourceId\":\"" + sourceId + "\",\"payload\":\"" + marker + "\\n본문\"}");
			assertEquals(503, withToken.status(), path + " 토큰 헤더가 있어도 401이 아니라 503이다");
			assertEquals("{\"ok\":false,\"reason\":\"collection-disabled\"}", withToken.body());
		}

		assertEquals(0, CollectionWireFixtures.articlesContaining(this.articles, marker),
				"503으로 닫힌 서버가 기사를 등록했다 — 가드가 서비스 앞이 아니다");
	}

	@Test
	void theBindAddressComesFromServerAddressAndNotFromASecondCopyOfTheHostVariable() {
		// 진단 보조 단언 — 위 행동 테스트가 red일 때 원인을 한 줄로 가리킨다.
		// (판정의 본체는 503 행동이다: 이 값이 맞아도 decide가 안 부르면 열린다.)
		assertEquals("0.0.0.0", this.properties.host(),
				"app.collection.host가 server.address에서 파생되지 않았다 — 출처가 둘이면 fail-closed가 열린 채 남는다");
	}

	/**
	 * fail-closed 서버는 <b>본문을 파싱조차 하지 않는다</b> — 깨진 JSON도 503이다.
	 *
	 * <p>Node는 같은 요청에 <b>500</b>이다({@code express.json()}이 라우트 가드보다 먼저 돈다). 계약이
	 * 관측하지 않는 축이며 안전 방향이다: 방어가 하나도 남지 않은 구성에서는 신뢰할 수 없는 바이트를
	 * 파서에 먹이는 것 자체가 표면이다.
	 */
	@Test
	void aMalformedBodyIsStill503BecauseTheClosedServerNeverParsesIt() {
		for (String path : List.of("/api/collection/receive", "/api/collection/pull")) {
			Wire.Response broken = Wire.json(this.port, "POST", path, Map.of(), "{\"sourceId\": ");

			assertEquals(503, broken.status(), path + " 닫힌 서버는 본문을 읽지 않는다(Node는 500)");
			assertEquals("{\"ok\":false,\"reason\":\"collection-disabled\"}", broken.body());
		}
	}

	@Test
	void failClosedOnlyClosesTheTwoCollectionRoutesAndNotTheServer() {
		Wire.Response health = Wire.send(this.port, "GET", "/api/health");

		assertEquals(200, health.status(), "fail-closed가 서버 전체를 죽이면 안 된다");
		assertEquals("{\"ok\":true}", health.body());
	}

}

/** 세 컨텍스트가 공유하는 픽스처·판독 도구. 상태를 갖지 않는다(각 컨텍스트의 DB는 서로 다르다). */
final class CollectionWireFixtures {

	/** 이 파일 전용 테스트 토큰(운영 비밀 아님) — 애노테이션 상수라 컴파일 타임 리터럴이어야 한다. */
	static final String TOKEN = "wire-collection-token";

	static final String HEADER = "x-collection-token";

	/** JSON 최상위 객체의 키 이름을 등장 순서대로 뽑는다(중첩 없는 응답 전용). */
	private static final Pattern KEY = Pattern.compile("\"([A-Za-z]+)\":");

	/** 저장된 마크업 판독 전용(응답 조립에는 쓰지 않는다 — 와이어 포맷은 서버가 정한다). */
	private static final ObjectMapper MAPPER = JsonMapper.builder().build();

	private CollectionWireFixtures() {
	}

	/** 수신 설정 1행을 리포지토리로 직접 만든다(세션·HTTP 없이 — 이 라우트는 세션 라우트가 아니다). */
	static String register(ReceiverConfigRepository configs, Map<String, Object> extra) {
		String sourceId = unique("cw-src");
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("sourceId", sourceId);
		entry.put("type", "FTP");
		entry.putAll(extra);
		configs.insert(entry);
		return sourceId;
	}

	static String unique(String prefix) {
		return prefix + "-" + Long.toHexString(System.nanoTime());
	}

	static List<String> keysOf(String json) {
		List<String> keys = new ArrayList<>();
		Matcher matcher = KEY.matcher(json);
		while (matcher.find()) {
			keys.add(matcher.group(1));
		}
		return keys;
	}

	static String articleIdOf(String body) {
		Matcher matcher = Pattern.compile("\"articleId\":\"([^\"]+)\"").matcher(body);
		assertTrue(matcher.find(), "응답에 articleId가 없다: " + body);
		return matcher.group(1);
	}

	/** 수집된 기사의 공통정보(투영 27키) — 원본 행 타입은 컨트롤러 계층에 들이지 않는다. */
	static Map<String, Object> contentsOf(ArticleRepository articles, String articleId) {
		ArticleAggregate aggregate = articles.findById(articleId);
		assertNotNull(aggregate, "수집한 기사가 조회되지 않는다: " + articleId);
		assertNotNull(aggregate.contents(), "Contents 행이 없다: " + articleId);
		return ContentsProjection.toPublic(aggregate.contents());
	}

	/** 저장된 {@code markupVersion}의 블록 텍스트(파서·조립 규칙의 되읽기). */
	@SuppressWarnings("unchecked")
	static List<String> blockTexts(ArticleRepository articles, String articleId) {
		ArticleAggregate aggregate = articles.findById(articleId);
		assertNotNull(aggregate, "수집한 기사가 조회되지 않는다: " + articleId);
		Object markup = aggregate.article() == null ? null : aggregate.article().get("markupVersion");
		assertNotNull(markup, "markupVersion이 비어 있다: " + articleId);
		String json = markup.toString();
		assertTrue(json.startsWith("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":["),
				"본문 마크업 shape이 계약과 다르다: " + json);
		Map<String, Object> document = MAPPER.readValue(json, Map.class);
		List<String> texts = new ArrayList<>();
		for (Object block : (List<Object>) document.get("blocks")) {
			texts.add((String) ((Map<String, Object>) block).get("text"));
		}
		return texts;
	}

	/**
	 * 제목·본문·마크업 어디에든 이 표식이 실린 기사 수 — "가드가 서비스 앞이다"의 음성 증거다.
	 * 표식은 요청 payload의 첫 줄이므로, 등록이 일어났다면 제목·마크업 양쪽에서 잡힌다.
	 */
	static int articlesContaining(ArticleRepository articles, String marker) {
		return articles.searchByText(marker).size();
	}

}
