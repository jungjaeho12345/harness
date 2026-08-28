package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.config.MediaProperties;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * {@link MediaSearchService} — Node {@code src/services/mediaSearch.js}와의 1:1 대조다.
 *
 * <h2>이 파일이 유일 방어선인 이유</h2>
 * 계약 리포트가 이 라우트에서 관측하는 것은 <b>넷뿐</b>이다(실측): {@code bodyKeys=[error,items,ok]} ·
 * {@code error:false} · {@code itemKeys} · {@code itemCount}. <b>제목 문자열·{@code link} URL·
 * {@code videoId} 값·{@code encodeURIComponent} 결과는 리포트에 실리지 않고</b>, 계약 파일 안의
 * {@code deepEqual}은 같은 서버를 두 번 부른 비교라 서버 간 차이를 잡지 못한다(index.json decisions (13)).
 * 게다가 계약 하네스는 자식 프로세스 env에서 API 키를 지우므로 <b>키가 설정된 경로는 계약이 구조적으로
 * 볼 수 없다</b>(ADR-014 트레이드오프) — 그 축 전체가 여기서만 잠긴다.
 *
 * <p>비가시 문자는 전부 이스케이프로 쓴다(소스에 raw 제어 바이트를 심으면 리뷰에서 diff가 감춰진다).
 */
class MediaSearchServiceTest {

	/** 유일하게 식별되는 값이어야 한다 — 부분 문자열 {@code SENTINEL}만으로도 전건을 훑는다. */
	private static final String SENTINEL_KEY = "SENTINEL-Kv9x7Qb3ZmT0-DO-NOT-LEAK";

	private static final String SENTINEL_CX = "SENTINEL-cx-8d41ba";

	private static final String SENTINEL_YT = "SENTINEL-yt-51ffc2";

	private static final String IMAGE_ENDPOINT = "https://www.googleapis.com/customsearch/v1";

	private static final String YOUTUBE_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";

	/** Node {@code DEMO_VIDEO_IDS} — 값도 순서도 정본 그대로다. */
	private static final List<String> DEMO_VIDEO_IDS = List.of("aqz-KE-bpKQ", "jNQXAC9IVRw", "ScMzIvxBSi4",
			"YE7VzlLtp-4");

	/** JS가 공백으로 보는 넷 — {@code String.trim()}·{@code String.strip()} 어느 쪽도 이 넷을 다 지우지 못한다. */
	private static final String NBSP = "\u00A0";

	private static final String BOM = "\uFEFF";

	private static final String FIGURE_SPACE = "\u2007";

	private static final String NARROW_NBSP = "\u202F";

	/** 반대 방향의 대조 — {@code String.strip()}은 지우지만 <b>JS는 공백으로 보지 않는다</b>. */
	private static final String FILE_SEPARATOR = "\u001C";

	private static final Instant FIXED_INSTANT = Instant.parse("2026-08-28T12:00:00Z");

	private static final long ONE_DAY_MS = 24L * 60 * 60 * 1000;

	private static final ObjectMapper MAPPER = JsonMapper.builder().build();

	private final RecordingProxy proxy = new RecordingProxy();

	// --- 키 없음: 외부 호출 0 + 결정적 데모 폴백 ---

	/**
	 * Node {@code buildUrl}이 {@code undefined}를 내면 {@code fetchFn}은 <b>한 번도 불리지 않는다</b>
	 * ({@code src/services/mediaSearch.js} 55행 — 키 누락은 즉시 반환이다).
	 *
	 * <p>이 단언이 red가 되는 변이는 <b>실제 네트워크 egress를 만드는 변이</b>다 — 키가 없는 서버(계약
	 * 하네스 포함)가 googleapis.com으로 나가기 시작한다.
	 */
	@Test
	@DisplayName("키가 없으면 어댑터를 한 번도 부르지 않는다(호출 0)")
	void itNeverTouchesTheAdapterWithoutKeys() {
		MediaSearchService service = keyless();

		for (Object type : Arrays.asList("image", "video", "audio", null)) {
			service.search("q", type);
		}

		assertEquals(List.of(), this.proxy.gets, "키 없는 서버가 밖으로 나갔다(egress)");
		assertEquals(List.of(), this.proxy.posts, "미디어 검색은 POST를 쓰지 않는다");
		assertEquals(0, this.proxy.calls(), "외부 호출 횟수");
	}

	@Test
	@DisplayName("image 폴백은 6건이고 각 원소의 키·값이 정본과 같다")
	void itBuildsSixDemoImagesWithExactValues() {
		Map<String, Object> result = keyless().search("뉴스", "image");

		List<?> items = items(result);
		assertEquals(6, items.size(), "itemCount");
		for (int i = 0; i < 6; i++) {
			Map<?, ?> item = (Map<?, ?>) items.get(i);
			assertEquals(List.of("title", "link"), new ArrayList<>(item.keySet()), "원소 키와 순서");
			assertEquals("뉴스 이미지 " + (i + 1) + " (데모)", item.get("title"));
			assertEquals("https://picsum.photos/seed/%EB%89%B4%EC%8A%A4-" + i + "/320/200", item.get("link"));
		}
		assertEquals(false, result.get("error"));
	}

	@Test
	@DisplayName("video 폴백은 고정 videoId 4건이고 순서까지 정본과 같다")
	void itBuildsFourDemoVideosWithExactValues() {
		Map<String, Object> result = keyless().search("뉴스", "video");

		List<?> items = items(result);
		assertEquals(4, items.size(), "itemCount");
		for (int i = 0; i < 4; i++) {
			Map<?, ?> item = (Map<?, ?>) items.get(i);
			assertEquals(List.of("title", "videoId", "url"), new ArrayList<>(item.keySet()), "원소 키와 순서");
			assertEquals("뉴스 관련 영상 " + (i + 1) + " (데모)", item.get("title"));
			assertEquals(DEMO_VIDEO_IDS.get(i), item.get("videoId"));
			assertEquals("https://www.youtube.com/watch?v=" + DEMO_VIDEO_IDS.get(i), item.get("url"));
		}
		assertEquals(false, result.get("error"));
	}

	/**
	 * 시드 정규화 {@code String(query ?? '').trim() || '뉴스'} — <b>{@code NodeString.trim} 단일 출처</b>다.
	 *
	 * <p>{@link String#trim()}은 U+00A0(NBSP)·U+FEFF(BOM)·U+2007·U+202F를 남기고,
	 * {@link String#strip()}은 그 셋을 남기면서 반대로 U+001C~U+001F를 지운다. 그래서 두 방향을 함께 못
	 * 박는다 — <b>공백으로 봐야 하는 넷</b>은 {@code '뉴스'}로 접히고, <b>공백이 아닌 U+001C</b>는 그대로
	 * 시드가 된다(Node 실측: U+001C 한 글자를 {@code trim()}해도 그 글자가 남는다).
	 */
	@Test
	@DisplayName("시드 정규화는 NodeString.trim이다(NBSP·BOM은 공백, U+001C는 공백이 아니다)")
	void itNormalisesTheSeedWithNodeWhitespace() {
		MediaSearchService service = keyless();

		for (Object blank : Arrays.asList(null, "", "   ", NBSP, BOM, FIGURE_SPACE, NARROW_NBSP, "\t\n",
				" " + NBSP + BOM + " ", List.of())) {
			assertEquals("뉴스 관련 영상 1 (데모)", firstTitle(service.search(blank, "video")),
					"공백만 있는 질의는 '뉴스' 시드다: " + escaped(blank));
		}

		assertEquals("x 관련 영상 1 (데모)", firstTitle(service.search("  x  ", "video")), "앞뒤 공백만 걷어낸다");
		assertEquals(FILE_SEPARATOR + " 관련 영상 1 (데모)", firstTitle(service.search(FILE_SEPARATOR, "video")),
				"U+001C는 JS 공백이 아니다 — String.strip()으로 바꾸면 여기가 red다");
	}

	@Test
	@DisplayName("데모 링크의 시드는 encodeURIComponent다(URLEncoder가 아니다)")
	void itEncodesTheDemoLinkSeedLikeNode() {
		MediaSearchService service = keyless();

		assertEquals("https://picsum.photos/seed/a%20b-0/320/200", firstLink(service.search("a b", "image")));
		assertEquals("https://picsum.photos/seed/!'()~*-0/320/200", firstLink(service.search("!'()~*", "image")));
		assertEquals("https://picsum.photos/seed/a%2Cb-0/320/200", firstLink(service.search("a,b", "image")));
	}

	/**
	 * 반복 쿼리 키({@code ?q=a&q=b})는 <b>값 리스트를 그대로</b> 받아 Node {@code String(...)} 의미론으로
	 * 접는다 — 첫 값만 쓰면 같은 질의에 두 서버가 다른 시드를 쓴다(index.json decisions (14)).
	 */
	@Test
	@DisplayName("반복 쿼리 키: q=[a,b]는 시드 'a,b' · type=[image,video]는 video")
	void itFoldsRepeatedQueryKeysLikeNode() {
		MediaSearchService service = keyless();

		assertEquals("a,b 관련 영상 1 (데모)", firstTitle(service.search(List.of("a", "b"), "video")),
				"배열은 콤마 결합이다(Java List.toString의 ', '가 아니다)");
		assertEquals(4, items(service.search("q", List.of("image", "video"))).size(),
				"type 반복 키는 배열이라 'image'와의 === 비교에서 갈린다 → video 4건");
		assertEquals(4, items(service.search("q", List.of("image"))).size(),
				"원소가 하나여도 배열은 문자열 'image'가 아니다 → video");
	}

	@Test
	@DisplayName("type 정규화: 'image'만 image이고 나머지는 전부 video(대소문자 엄격)")
	void itNormalisesTypeStrictly() {
		MediaSearchService service = keyless();

		assertEquals(6, items(service.search("q", "image")).size(), "'image'만 image다");
		for (Object type : Arrays.asList(null, "", "  ", "video", "audio", "IMAGE", "Image", "image ", 1,
				Boolean.TRUE, List.of())) {
			assertEquals(4, items(service.search("q", type)).size(), "video 폴백이어야 한다: " + type);
		}
	}

	/**
	 * {@code type}·{@code q} 미전달은 <b>정상 경로</b>다(쿼리 파라미터는 원래 없을 수 있다).
	 *
	 * <p>여기서 {@code NullPointerException}이 나면 200이어야 할 라우트가 500이 된다 —
	 * {@code Set.of(...).contains(null)} 함정과 같은 축이고 phase 68·69·70에서 반복됐다(decisions (24)).
	 */
	@Test
	@DisplayName("q·type이 모두 null이어도 500이 아니라 video 데모 폴백이다")
	void itSurvivesNullQueryAndNullType() {
		Map<String, Object> result = keyless().search(null, null);

		assertEquals(4, items(result).size());
		assertEquals("뉴스 관련 영상 1 (데모)", firstTitle(result));
		assertEquals(false, result.get("error"));
	}

	@Test
	@DisplayName("응답 맵은 [items, error] 두 키뿐이다 — demo 플래그를 만들지 않는다")
	void itReturnsExactlyTwoOrderedKeys() {
		for (Map<String, Object> result : List.of(keyless().search("q", "image"), keyless().search("q", "video"),
				keyed().search("q", "image"), failing().search("q", "image"))) {
			assertEquals(List.of("items", "error"), new ArrayList<>(result.keySet()),
					"라우트가 떨굴 값을 애초에 만들지 않는다(응답 3키가 계약이다)");
		}
	}

	@Test
	@DisplayName("같은 인자로 두 번 부른 결과가 완전히 같다(데모 폴백 결정성)")
	void itIsDeterministic() {
		MediaSearchService service = keyless();

		assertEquals(service.search("q", "image"), service.search("q", "image"));
		assertEquals(service.search("q", "video"), service.search("q", "video"));
		assertEquals(service.search(null, null), service.search(null, null));
	}

	/** Node {@code empty()}·{@code demoResults}가 매번 새 객체를 만드는 이유 — 호출자가 변형해도 안전해야 한다. */
	@Test
	@DisplayName("items는 매 호출 새 리스트다(호출자가 변형해도 다음 호출이 오염되지 않는다)")
	void itHandsOutAFreshItemsListEachCall() {
		MediaSearchService service = keyless();

		Map<String, Object> first = service.search("q", "image");
		List<Object> mutable = itemsForMutation(first);
		mutable.clear();
		mutable.add("polluted");

		Map<String, Object> second = service.search("q", "image");
		assertNotSame(first.get("items"), second.get("items"));
		assertEquals(6, items(second).size(), "이전 호출의 변형이 다음 호출에 새어 들어왔다");
	}

	// --- 키 있음: 계약이 구조적으로 볼 수 없는 경로(축약 금지) ---

	@Test
	@DisplayName("image 키가 있으면 정본 URL로 정확히 1회 GET한다")
	void itCallsTheImageEndpointOnceWithTheCanonicalUrl() {
		Map<String, Object> result = keyed().search("a b", "image");

		assertEquals(
				List.of(IMAGE_ENDPOINT + "?key=" + SENTINEL_KEY + "&cx=" + SENTINEL_CX
						+ "&searchType=image&q=a%20b"),
				this.proxy.gets, "URL이 문자 단위로 정본과 같아야 한다(파라미터 순서 포함)");
		assertEquals(1, this.proxy.calls(), "1회 시도다(ADR-008 (6) — 재시도 0)");
		assertEquals(false, result.get("error"));
	}

	@Test
	@DisplayName("video 키가 있으면 정본 URL로 정확히 1회 GET한다")
	void itCallsTheYoutubeEndpointOnceWithTheCanonicalUrl() {
		Map<String, Object> result = keyed().search("뉴스", null);

		assertEquals(
				List.of(YOUTUBE_ENDPOINT + "?key=" + SENTINEL_YT
						+ "&part=snippet&type=video&q=%EB%89%B4%EC%8A%A4"),
				this.proxy.gets);
		assertEquals(1, this.proxy.calls());
		assertEquals(false, result.get("error"));
	}

	/**
	 * URL의 {@code q}는 <b>데모 시드가 아니라 원 질의</b>다 — Node {@code buildUrl}은
	 * {@code encodeURIComponent(query ?? '')}로 <b>다듬지 않은</b> 값을 쓴다(시드 정규화는
	 * {@code demoResults} 안에만 있다).
	 */
	@Test
	@DisplayName("URL의 q는 시드 정규화 전의 원 질의다('뉴스' 폴백이 새어 들어가지 않는다)")
	void itSendsTheRawQueryNotTheDemoSeed() {
		keyed().search("  ", "image");

		assertEquals(List.of(IMAGE_ENDPOINT + "?key=" + SENTINEL_KEY + "&cx=" + SENTINEL_CX
				+ "&searchType=image&q=%20%20"), this.proxy.gets);
	}

	@Test
	@DisplayName("이미지 키는 둘 다 있어야 한다 — 하나만 있으면 호출 없이 데모 폴백이다")
	void itRequiresBothImageKeys() {
		MediaSearchService onlyApiKey = service(new MediaProperties(SENTINEL_KEY, "", ""));
		assertEquals(6, items(onlyApiKey.search("q", "image")).size());

		MediaSearchService onlyCx = service(new MediaProperties("", SENTINEL_CX, ""));
		assertEquals(6, items(onlyCx.search("q", "image")).size());

		MediaSearchService onlyYoutube = service(new MediaProperties("", "", SENTINEL_YT));
		assertEquals(6, items(onlyYoutube.search("q", "image")).size(), "youtube 키는 이미지 경로를 열지 않는다");

		assertEquals(0, this.proxy.calls(), "부분 설정은 미설정과 같다 — 밖으로 나가지 않는다");
	}

	@Test
	@DisplayName("공백뿐인 키는 미설정으로 수렴한다(설정 오타가 조용한 egress가 되지 않는다)")
	void itTreatsBlankKeysAsUnset() {
		MediaSearchService blank = service(new MediaProperties("   ", "\t", NBSP));

		assertEquals(6, items(blank.search("q", "image")).size());
		assertEquals(4, items(blank.search("q", "video")).size());
		assertEquals(0, this.proxy.calls());
	}

	@Test
	@DisplayName("성공 응답의 items가 배열이면 그대로 싣는다")
	void itPassesThroughAnItemsArray() {
		this.proxy.next = new ExternalProxyClient.Result(true, "{\"items\":[{\"link\":\"a\"},{\"link\":\"b\"}]}");

		Map<String, Object> result = keyed().search("q", "image");

		assertEquals(2, items(result).size());
		assertEquals(Map.of("link", "a"), items(result).get(0));
		assertEquals(false, result.get("error"));
	}

	@Test
	@DisplayName("items가 배열이 아니면 빈 배열이고 error는 false다(Array.isArray 동형)")
	void itYieldsAnEmptyArrayWhenItemsIsNotAnArray() {
		for (String body : List.of("{\"items\":{\"a\":1}}", "{\"items\":\"x\"}", "{\"items\":null}", "{}", "null",
				"123", "\"text\"", "[]")) {
			this.proxy.reset();
			this.proxy.next = new ExternalProxyClient.Result(true, body);

			Map<String, Object> result = keyed().search("q", "image");

			assertEquals(List.of(), items(result), "본문: " + body);
			assertEquals(false, result.get("error"), "파싱은 성공했으므로 error는 false다: " + body);
		}
	}

	@Test
	@DisplayName("ok=false·파싱 실패·어댑터 예외는 전부 {items:[], error:true}로 접힌다")
	void itFoldsEveryFailureIntoTheEmptyErrorShape() {
		List<Runnable> failures = List.of(() -> this.proxy.next = new ExternalProxyClient.Result(false, "{}"),
				() -> this.proxy.next = new ExternalProxyClient.Result(false, null),
				() -> this.proxy.next = null,
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "not json"),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, ""),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, null),
				() -> this.proxy.failure = new IllegalStateException("boom"));

		for (Runnable arrange : failures) {
			this.proxy.reset();
			arrange.run();

			Map<String, Object> result = keyed().search("q", "image");

			assertEquals(List.of("items", "error"), new ArrayList<>(result.keySet()));
			assertEquals(List.of(), result.get("items"));
			assertEquals(true, result.get("error"));
			assertEquals(1, this.proxy.calls(), "실패에 재시도·폴백 호출을 붙이지 않는다(ADR-008 (6))");
		}
	}

	// --- 키 문자열 비유출(ADR-014) ---

	/**
	 * (a) <b>반환 맵 직렬화 전문</b>에 키가 0건이다.
	 *
	 * <p>어댑터에만 이 단언이 있으면 부족하다 — <b>URL에 키를 합성하는 주체가 이 서비스</b>이고, 그 URL이
	 * 진단 편의로 반환값에 실리는 순간({@code {items:[], error:true, url:...}} 같은 형태) 그것은 곧 응답
	 * 본문이다. 서버 보유 키가 한 번 밖으로 나가면 회수할 수 없다.
	 */
	@Test
	@DisplayName("반환 맵 직렬화 전문에 키가 0건이다(성공·실패 양쪽)")
	void theApiKeyNeverAppearsInTheReturnedValue() {
		for (Map<String, Object> result : exerciseEveryPathWithTheKey()) {
			String serialized = MAPPER.writeValueAsString(result);
			assertFalse(serialized.contains("SENTINEL"), "반환 맵 JSON에 키가 실렸다: " + serialized);
			assertFalse(String.valueOf(result).contains("SENTINEL"), "반환 맵 toString에 키가 실렸다");
		}
	}

	/**
	 * (b) <b>로그 링 버퍼 전 줄</b>에 키가 0건이다 — 링 버퍼는 {@code GET /api/logs/digest}로 밖으로
	 * 나간다(ADR-007). 거기 들어간 한 조각은 곧 응답이다.
	 *
	 * <p><b>정직한 평가</b>: 이 서비스는 {@link LogService}를 주입받지 않으므로 버퍼 단언은 구조적
	 * 트립와이어다(누군가 로거를 넣는 날 살아난다). 그래서 훑는 절차의 비공허성을 자기 검사로 먼저
	 * 증명하고, 표준 출력·표준 에러와 리플렉션 표면까지 함께 못 박는다.
	 */
	@Test
	@DisplayName("로그 링 버퍼·표준 출력 어디에도 키가 없고 로그 싱크 자체가 없다")
	void neitherTheLogRingBufferNorProcessOutputEverSeesTheApiKey() {
		Clock fixed = Clock.fixed(FIXED_INSTANT, ZoneOffset.UTC);
		LogService probe = new LogService(fixed, LogService.DEFAULT_CAP, LogService.KST_OFFSET_MINUTES);
		probe.info("probe " + SENTINEL_KEY);
		assertTrue(scanForKey(probe), "훑는 절차가 공허하다 — 일부러 넣은 센티넬조차 못 찾는다");

		LogService ring = new LogService(fixed, LogService.DEFAULT_CAP, LogService.KST_OFFSET_MINUTES);
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		ByteArrayOutputStream err = new ByteArrayOutputStream();
		PrintStream originalOut = System.out;
		PrintStream originalErr = System.err;
		try {
			System.setOut(new PrintStream(out, true, StandardCharsets.UTF_8));
			System.setErr(new PrintStream(err, true, StandardCharsets.UTF_8));
			exerciseEveryPathWithTheKey();
		}
		finally {
			System.setOut(originalOut);
			System.setErr(originalErr);
		}

		assertFalse(scanForKey(ring), "로그 링 버퍼에 키가 실렸다");
		assertEquals(0, ring.digest(FIXED_INSTANT.toEpochMilli() + ONE_DAY_MS).size(),
				"이 서비스는 아무것도 남기지 않는다 — 줄이 생겼다면 로그 싱크가 생겼다는 뜻이다");
		assertFalse(out.toString(StandardCharsets.UTF_8).contains("SENTINEL"), "표준 출력에 키가 실렸다");
		assertFalse(err.toString(StandardCharsets.UTF_8).contains("SENTINEL"), "표준 에러에 키가 실렸다");

		for (Field field : MediaSearchService.class.getDeclaredFields()) {
			assertFalse(field.getType().getSimpleName().contains("Log"), "로그 타입 필드가 생겼다: " + field);
		}
		for (Constructor<?> constructor : MediaSearchService.class.getDeclaredConstructors()) {
			for (Class<?> parameter : constructor.getParameterTypes()) {
				assertFalse(parameter.getSimpleName().contains("Log"), "생성자가 로그 싱크를 받는다: " + constructor);
			}
		}
		for (Method method : MediaSearchService.class.getDeclaredMethods()) {
			assertFalse(method.toGenericString().contains("Log"), "메서드 시그니처에 로그 타입이 있다: " + method);
		}
	}

	/**
	 * (c) <b>예외 메시지와 원인 체인</b>에 키가 0건이고, 애초에 예외가 밖으로 나가지 않는다.
	 *
	 * <p>여기서 어댑터는 <b>URL 전문을 메시지에 담은 예외</b>를 던진다({@code URI.create}의
	 * {@code IllegalArgumentException}과 {@code ConnectException}이 실제로 그렇게 한다). 서비스가 그 예외를
	 * 그대로 올리면 전역 에러 핸들러가 500과 함께 메시지를 남기고, 그 자리에 서버 보유 키가 남는다.
	 */
	@Test
	@DisplayName("예외 메시지·원인 체인에 키가 0건이고 서비스는 던지지 않는다")
	void theApiKeyNeverReachesAnExceptionMessageOrItsCauseChain() {
		for (Object type : Arrays.asList("image", "video")) {
			this.proxy.reset();
			this.proxy.failure = new IllegalStateException("connect failed",
					new IllegalArgumentException("bad URI: " + IMAGE_ENDPOINT + "?key=" + SENTINEL_KEY));

			Throwable thrown = null;
			Map<String, Object> result = null;
			try {
				result = keyed().search("q", type);
			}
			catch (Throwable ex) {
				thrown = ex;
			}

			for (Throwable cause = thrown; cause != null; cause = cause.getCause()) {
				assertFalse(String.valueOf(cause.getMessage()).contains("SENTINEL"),
						"예외 원인 체인의 메시지에 키가 실렸다: " + cause);
			}
			assertNull(thrown, "서비스가 예외를 밖으로 던졌다 — 200이 500이 된다: " + thrown);
			assertEquals(true, result.get("error"));
		}
	}

	// --- 유틸 ---

	/** 키가 설정된 서비스로 <b>성공·비2xx·파싱 실패·어댑터 예외</b> 경로를 전부 돌린 반환 맵들. */
	private List<Map<String, Object>> exerciseEveryPathWithTheKey() {
		List<Map<String, Object>> results = new ArrayList<>();
		List<Runnable> arrangements = List.of(
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "{\"items\":[{\"link\":\"a\"}]}"),
				() -> this.proxy.next = new ExternalProxyClient.Result(false, "denied"),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "not json"),
				() -> this.proxy.failure = new IllegalStateException(
						"boom " + IMAGE_ENDPOINT + "?key=" + SENTINEL_KEY));
		for (Runnable arrange : arrangements) {
			for (Object type : Arrays.asList("image", "video")) {
				this.proxy.reset();
				arrange.run();
				results.add(keyed().search("검색어 b", type));
			}
		}
		return results;
	}

	private static boolean scanForKey(LogService log) {
		return log.digest(FIXED_INSTANT.toEpochMilli() + ONE_DAY_MS).stream()
				.anyMatch((record) -> String.valueOf(record).contains("SENTINEL"));
	}

	private MediaSearchService keyless() {
		return service(new MediaProperties("", "", ""));
	}

	private MediaSearchService keyed() {
		return service(new MediaProperties(SENTINEL_KEY, SENTINEL_CX, SENTINEL_YT));
	}

	/** 어댑터가 실패를 돌려주는 구성 — 응답 키 검사용. */
	private MediaSearchService failing() {
		this.proxy.next = new ExternalProxyClient.Result(false, null);
		return keyed();
	}

	private MediaSearchService service(MediaProperties keys) {
		return new MediaSearchService(this.proxy, keys);
	}

	private static List<?> items(Map<String, Object> result) {
		return (List<?>) result.get("items");
	}

	@SuppressWarnings("unchecked")
	private static List<Object> itemsForMutation(Map<String, Object> result) {
		return (List<Object>) result.get("items");
	}

	private static String firstTitle(Map<String, Object> result) {
		return (String) ((Map<?, ?>) items(result).get(0)).get("title");
	}

	private static String firstLink(Map<String, Object> result) {
		return (String) ((Map<?, ?>) items(result).get(0)).get("link");
	}

	/** 비가시 문자를 보이게 적는다(실패 메시지가 빈칸처럼 보이면 진단이 불가능하다). */
	private static String escaped(Object value) {
		String raw = String.valueOf(value);
		StringBuilder out = new StringBuilder();
		for (int i = 0; i < raw.length(); i++) {
			char c = raw.charAt(i);
			if (c < 0x20 || c > 0x7E) {
				out.append(String.format("\\u%04X", (int) c));
			}
			else {
				out.append(c);
			}
		}
		return out.toString();
	}

	/** 네트워크 없는 어댑터 대역 — 호출 URL을 그대로 기록한다. */
	private static final class RecordingProxy implements ExternalProxyClient {

		private final List<String> gets = new ArrayList<>();

		private final List<String> posts = new ArrayList<>();

		private Result next = new Result(true, "{\"items\":[]}");

		private RuntimeException failure;

		@Override
		public Result get(String url) {
			this.gets.add(url);
			return answer();
		}

		@Override
		public Result post(String url) {
			this.posts.add(url);
			return answer();
		}

		private Result answer() {
			if (this.failure != null) {
				throw this.failure;
			}
			return this.next;
		}

		private int calls() {
			return this.gets.size() + this.posts.size();
		}

		private void reset() {
			this.gets.clear();
			this.posts.clear();
			this.next = new Result(true, "{\"items\":[]}");
			this.failure = null;
		}

	}

}
