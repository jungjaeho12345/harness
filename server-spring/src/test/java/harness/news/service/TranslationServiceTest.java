package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.config.TranslateProperties;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * {@link TranslationService} — Node {@code src/services/translate.js}와의 1:1 대조다.
 *
 * <h2>이 파일이 유일 방어선인 축</h2>
 * 계약이 이 라우트에서 관측하는 것은 <b>키 없는 서버의 4관측</b>뿐이다({@code no-key} ·
 * {@code no-key-target-lang} · {@code missing-article} 404 · 미인증 401). 계약 하네스는 자식 env에서 API
 * 키를 지우므로 <b>키가 설정된 경로 전체</b>가 구조적으로 관측 불가이고(ADR-014 트레이드오프), 정본이
 * 키 판정보다 <b>먼저</b> 도는 <b>빈 본문 분기</b>(2키 응답)도 계약 픽스처에 본문이 있어 도달하지 않는다
 * (index.json decisions (15) · (22)⑨).
 *
 * <h2>상태코드로 성공을 판정할 수 없는 라우트다</h2>
 * 키 누락·외부 실패는 <b>200 + {@code ok:false}</b>이고 4xx/5xx가 아니다 — 클라이언트
 * ({@code httpModel})는 상태코드를 해석하지 않고 JSON의 {@code ok}만 읽으므로 감싸는 순간 조용히 깨진다
 * (reason-tokens.md 표 3 #13). 그래서 여기서는 <b>서비스가 절대 던지지 않는다</b>는 것을 경로마다 못
 * 박는다(라우트는 서비스가 준 객체를 그대로 200으로 내려보낸다).
 */
class TranslationServiceTest {

	/** 유일하게 식별되는 값이어야 한다 — 부분 문자열 {@code SENTINEL}만으로 전건을 훑는다. */
	private static final String SENTINEL_KEY = "SENTINEL-Kv9x7Qb3ZmT0-DO-NOT-LEAK";

	private static final String ENDPOINT = "https://translation.googleapis.com/language/translate/v2";

	/** 정본이 쓰는 기사 본문 — 계약 픽스처와 같은 완결 마커가 들어 있다. */
	private static final String BODY = "본문 (끝)";

	private static final Instant FIXED_INSTANT = Instant.parse("2026-08-28T12:00:00Z");

	private static final long ONE_DAY_MS = 24L * 60 * 60 * 1000;

	private static final ObjectMapper MAPPER = JsonMapper.builder().build();

	/** 정상 provider 응답(Google Translate v2 shape). */
	private static final String OK_BODY =
			"{\"data\":{\"translations\":[{\"translatedText\":\"the body\",\"detectedSourceLanguage\":\"ko\"}]}}";

	private final RecordingProxy proxy = new RecordingProxy();

	// --- 1) 빈 본문: 키보다 먼저 도는 분기(계약 밖) -----------------------------------------

	/**
	 * 정본 39행 {@code if (!text) return { ok: true, translatedText: '' };} — <b>키 판정보다 먼저</b>다.
	 * 그래서 키가 설정된 서버에서도 <b>외부 호출이 0회</b>이고 응답은 <b>정확히 2키</b>({@code reason}이
	 * 없다).
	 *
	 * <p>이 분기를 지우면 응답이 {@code no-key} 3키가 되는데 <b>계약은 그 차이를 보지 못한다</b>(픽스처
	 * 기사에는 본문이 있다). 본문·제목이 모두 빈 기사에서만 도달하는 자리다.
	 */
	@Test
	@DisplayName("빈 본문은 2키 응답이고 키가 있어도 외부로 나가지 않는다")
	void anEmptyBodyReturnsTwoKeysWithoutAnyCall() {
		for (TranslateProperties keys : List.of(new TranslateProperties(""), new TranslateProperties(SENTINEL_KEY))) {
			this.proxy.reset();
			TranslationService service = new TranslationService(this.proxy, keys);

			Map<String, Object> result = service.translate("", "ko");

			assertEquals(List.of("ok", "translatedText"), new ArrayList<>(result.keySet()), "키와 순서");
			assertEquals(true, result.get("ok"));
			assertEquals("", result.get("translatedText"));
			assertEquals(0, this.proxy.calls(), "빈 본문에서 외부 호출이 일어났다");
		}
	}

	@Test
	@DisplayName("본문이 null이어도 빈 본문과 같다(500으로 새지 않는다)")
	void aNullBodyIsTheSameAsAnEmptyOne() {
		Map<String, Object> result = keyed().translate(null, null);

		assertEquals(List.of("ok", "translatedText"), new ArrayList<>(result.keySet()));
		assertEquals("", result.get("translatedText"));
		assertEquals(0, this.proxy.calls());
	}

	// --- 2) 키 없음: graceful degrade -------------------------------------------------------

	/**
	 * 키 누락은 <b>3키</b>({@code ok,reason,translatedText})이고 원문이 그대로 돌아온다 — 계약이 관측하는
	 * 유일한 성공 경로다. 여기서도 <b>외부 호출은 0회</b>여야 한다(ADR-014: 키가 없으면 아예 나가지 않는다).
	 */
	@Test
	@DisplayName("키가 없으면 no-key 3키 + 원문 폴백이고 외부 호출은 0회다")
	void withoutAKeyItDegradesToNoKey() {
		Map<String, Object> result = keyless().translate(BODY, "ko");

		assertEquals(List.of("ok", "reason", "translatedText"), new ArrayList<>(result.keySet()), "키와 순서");
		assertEquals(false, result.get("ok"));
		assertEquals("no-key", result.get("reason"));
		assertEquals(BODY, result.get("translatedText"), "원문 폴백");
		assertEquals(List.of(), this.proxy.posts, "키 없는 서버가 밖으로 나갔다(egress)");
		assertEquals(0, this.proxy.calls());
	}

	/**
	 * 공백뿐인 키는 <b>미설정</b>으로 접는다 — {@link TranslateProperties}가 소유한 <b>의도된
	 * divergence</b>다(JS {@code !key}는 공백 한 칸을 '설정됨'으로 본다). 근거는 ADR-014: {@code .env}의
	 * 오타 한 줄이 조용한 egress가 되지 않게 한다.
	 */
	@Test
	@DisplayName("공백뿐인 키는 미설정이다(의도된 divergence · 방향은 안전측)")
	void aWhitespaceOnlyKeyIsUnconfigured() {
		TranslationService service = new TranslationService(this.proxy, new TranslateProperties("   "));

		assertEquals("no-key", service.translate(BODY, "ko").get("reason"));
		assertEquals(0, this.proxy.calls());
	}

	// --- 3) 키 있음: 요청 URL(계약이 못 보는 축) --------------------------------------------

	/**
	 * 요청 URL은 정본과 <b>문자 단위로</b> 같아야 한다 — 파라미터 이름·순서({@code key,q,target,format}) ·
	 * 값 인코딩까지.
	 *
	 * <p>값 인코딩은 {@code encodeURIComponent}가 <b>아니라</b> {@code URLSearchParams}
	 * ({@code application/x-www-form-urlencoded})다: 공백이 {@code +}이고 {@code (}·{@code )}가 퍼센트
	 * 인코딩된다(기대값은 Node 실측 문자열이다). 두 인코더를 헷갈리면 <b>모든 번역 요청</b>이 정본과
	 * 다른 URL로 나간다.
	 *
	 * <p>메서드는 <b>POST</b>다(GET이 아니다). 본문은 비어 있고 파라미터는 전부 URL에 있다.
	 */
	@Test
	@DisplayName("요청 URL이 정본과 문자 단위로 같고 POST 1회다")
	void theRequestUrlMatchesTheCanonicalOneExactly() {
		this.proxy.next = new ExternalProxyClient.Result(true, OK_BODY);

		keyed().translate(BODY, "en");

		assertEquals(List.of(ENDPOINT + "?key=" + SENTINEL_KEY + "&q=%EB%B3%B8%EB%AC%B8+%28%EB%81%9D%29"
				+ "&target=en&format=text"), this.proxy.posts);
		assertEquals(List.of(), this.proxy.gets, "번역은 GET을 쓰지 않는다");
		assertEquals(1, this.proxy.calls(), "외부 호출은 1회뿐이다(재시도 0 — ADR-008)");
	}

	@Test
	@DisplayName("키·질의의 특수문자도 form 인코딩된다(Node 실측 문자열)")
	void specialCharactersAreFormEncoded() {
		TranslationService service = new TranslationService(this.proxy, new TranslateProperties("k+e y"));
		this.proxy.next = new ExternalProxyClient.Result(true, OK_BODY);

		service.translate("a&b=c", "");

		assertEquals(List.of(ENDPOINT + "?key=k%2Be+y&q=a%26b%3Dc&target=&format=text"), this.proxy.posts);
	}

	/**
	 * {@code targetLang}은 정본이 <b>{@code ??}만</b> 적용하고 나머지는 그대로 넘긴다 — 강제 정규화하지
	 * 않는다. {@code null}(부재)만 {@code 'ko'}이고 <b>빈 문자열은 빈 문자열 그대로</b> URL에 실린다.
	 *
	 * <p>반복 키·배열은 JS {@code String(value)} = 콤마 결합이다({@link NodeString#queryText} 단일 출처).
	 */
	@Test
	@DisplayName("targetLang은 ?? 병합만 적용하고 값을 정규화하지 않는다")
	void theTargetLanguageIsPassedThroughAfterNullishCoalescingOnly() {
		Map<Object, String> table = new LinkedHashMap<>();
		table.put(NULL_TARGET, "ko"); // 부재·null → 기본값
		table.put("", ""); // 빈 문자열은 그대로다
		table.put("en-US", "en-US");
		table.put(5, "5");
		table.put(true, "true");
		table.put(List.of("en", "fr"), "en%2Cfr"); // JS Array#toString = 'en,fr'

		for (Map.Entry<Object, String> row : table.entrySet()) {
			this.proxy.reset();
			this.proxy.next = new ExternalProxyClient.Result(true, OK_BODY);
			Object target = (row.getKey() == NULL_TARGET) ? null : row.getKey();

			keyed().translate("q", target);

			assertEquals(ENDPOINT + "?key=" + SENTINEL_KEY + "&q=q&target=" + row.getValue() + "&format=text",
					this.proxy.posts.get(0), "targetLang=" + row.getKey());
		}
	}

	// --- 4) 키 있음: 응답 파싱 ---------------------------------------------------------------

	@Test
	@DisplayName("성공은 번역문과 감지 언어를 3키로 돌려준다")
	void aSuccessCarriesTheTranslationAndDetectedLanguage() {
		this.proxy.next = new ExternalProxyClient.Result(true, OK_BODY);

		Map<String, Object> result = keyed().translate(BODY, "en");

		assertEquals(List.of("ok", "translatedText", "sourceLang"), new ArrayList<>(result.keySet()), "키와 순서");
		assertEquals(true, result.get("ok"));
		assertEquals("the body", result.get("translatedText"));
		assertEquals("ko", result.get("sourceLang"));
	}

	/**
	 * provider가 감지 언어를 주지 않으면 <b>{@code sourceLang} 키 자체가 없다</b>.
	 *
	 * <p>정본은 {@code sourceLang: undefined}를 담지만 {@code res.json()} =
	 * {@code JSON.stringify}가 <b>{@code undefined} 값을 통째로 떨군다</b> — 와이어에 나가는 것은 2키다.
	 * {@code null}을 실으면 클라이언트가 "언어 감지에 실패했다"는 값을 받게 되어 다른 계약이 된다.
	 */
	@Test
	@DisplayName("감지 언어가 없으면 sourceLang 키 자체가 없다(null이 아니다)")
	void withoutADetectedLanguageTheKeyIsAbsent() {
		this.proxy.next = new ExternalProxyClient.Result(true,
				"{\"data\":{\"translations\":[{\"translatedText\":\"t\"}]}}");

		Map<String, Object> result = keyed().translate(BODY, "en");

		assertEquals(List.of("ok", "translatedText"), new ArrayList<>(result.keySet()));
		assertFalse(result.containsKey("sourceLang"), "키가 없어야 한다");
		assertEquals("{\"ok\":true,\"translatedText\":\"t\"}", MAPPER.writeValueAsString(result), "와이어 전문");
	}

	/**
	 * 반대로 provider가 <b>명시적으로 {@code null}</b>을 주면 그 키는 남는다({@code JSON.stringify}는
	 * {@code null}을 떨구지 않는다 — Node 실측 {@code {"ok":true,"translatedText":"t","sourceLang":null}}).
	 */
	@Test
	@DisplayName("감지 언어가 명시적 null이면 키는 남고 값이 null이다")
	void anExplicitNullDetectedLanguageKeepsTheKey() {
		this.proxy.next = new ExternalProxyClient.Result(true,
				"{\"data\":{\"translations\":[{\"translatedText\":\"t\",\"detectedSourceLanguage\":null}]}}");

		Map<String, Object> result = keyed().translate(BODY, "en");

		assertEquals(List.of("ok", "translatedText", "sourceLang"), new ArrayList<>(result.keySet()));
		assertNull(result.get("sourceLang"));
	}

	/** 여러 번역이 오면 <b>첫 원소</b>만 쓴다(정본 {@code translations?.[0]}). */
	@Test
	@DisplayName("번역이 여러 건이면 첫 원소만 쓴다")
	void onlyTheFirstTranslationIsUsed() {
		this.proxy.next = new ExternalProxyClient.Result(true,
				"{\"data\":{\"translations\":[{\"translatedText\":\"a\"},{\"translatedText\":\"b\"}]}}");

		assertEquals("a", keyed().translate(BODY, "en").get("translatedText"));
	}

	// --- 5) 키 있음: 실패는 전부 같은 모양 --------------------------------------------------

	/**
	 * 비2xx · 본문 없음 · 파싱 실패 · shape 이상 · 어댑터 예외가 <b>전부</b>
	 * {@code {ok:false, reason:'error', translatedText:원문}} 한 모양으로 접힌다(정본 {@code catch} 포함).
	 * 어떤 경우에도 <b>던지지 않고</b> 호출은 <b>1회</b>다.
	 */
	@Test
	@DisplayName("실패·비정상 shape은 전부 error 3키로 접히고 던지지 않는다")
	void everyFailureFoldsIntoTheSameErrorShape() {
		List<Runnable> arrangements = List.of(
				() -> this.proxy.next = new ExternalProxyClient.Result(false, "denied"),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, null),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "not json"),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "{}"),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "null"),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "\"str\""),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "{\"data\":{}}"),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "{\"data\":{\"translations\":[]}}"),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "{\"data\":{\"translations\":\"x\"}}"),
				() -> this.proxy.next = new ExternalProxyClient.Result(true,
						"{\"data\":{\"translations\":[{\"translatedText\":5}]}}"),
				() -> this.proxy.next = null,
				() -> this.proxy.failure = new IllegalStateException("boom " + ENDPOINT + "?key=" + SENTINEL_KEY));

		for (int i = 0; i < arrangements.size(); i++) {
			this.proxy.reset();
			arrangements.get(i).run();

			Map<String, Object> result = keyed().translate(BODY, "en");

			assertEquals(List.of("ok", "reason", "translatedText"), new ArrayList<>(result.keySet()), "케이스 " + i);
			assertEquals(false, result.get("ok"), "케이스 " + i);
			assertEquals("error", result.get("reason"), "케이스 " + i);
			assertEquals(BODY, result.get("translatedText"), "원문 폴백 — 케이스 " + i);
			assertEquals(1, this.proxy.calls(), "1회 시도뿐이다(재시도 금지) — 케이스 " + i);
		}
	}

	// --- 6) 본문 도출은 서비스가 소유한다 ----------------------------------------------------

	/**
	 * 라우트는 <b>id와 targetLang만</b> 넘긴다 — 본문 도출({@link ArticleText})은 서비스 안에서 끝난다.
	 * 컨트롤러가 원본 행을 만지면 {@code ControllerProjectionBoundaryTest}가 red다.
	 *
	 * <p>번역 대상은 <b>서버 DB에서만</b> 온다(ADR-004) — 요청 body의 {@code text}는 쓰지 않는다.
	 */
	@Test
	@DisplayName("기사 진입점은 본문을 DB 행에서 도출해 번역한다")
	void theArticleEntryPointDerivesTheBodyItself() {
		this.proxy.next = new ExternalProxyClient.Result(true, OK_BODY);
		Map<String, Object> found = article("{\"blocks\":[{\"text\":\"" + BODY + "\"}]}", "제목");

		Map<String, Object> result = keyed().translateArticle(found, null);

		assertEquals("the body", result.get("translatedText"));
		assertEquals(List.of(ENDPOINT + "?key=" + SENTINEL_KEY + "&q=%EB%B3%B8%EB%AC%B8+%28%EB%81%9D%29"
				+ "&target=ko&format=text"), this.proxy.posts, "본문은 블록 문서에서, targetLang 기본값은 ko다");
	}

	/** 본문도 제목도 빈 기사는 <b>빈 본문 분기</b>로 간다 — 2키 응답 + 외부 호출 0회다. */
	@Test
	@DisplayName("본문도 제목도 빈 기사는 2키 응답이고 외부로 나가지 않는다")
	void anArticleWithNoTextAtAllTakesTheEmptyBranch() {
		Map<String, Object> result = keyed().translateArticle(article(null, null), "en");

		assertEquals(List.of("ok", "translatedText"), new ArrayList<>(result.keySet()));
		assertEquals("", result.get("translatedText"));
		assertEquals(0, this.proxy.calls());
	}

	@Test
	@DisplayName("기사 행이 비어 있어도 던지지 않는다")
	void anEmptyAggregateIsSafe() {
		assertEquals("", keyed().translateArticle(Map.of(), "ko").get("translatedText"));
		assertEquals("", keyed().translateArticle(null, "ko").get("translatedText"));
	}

	// --- 7) 키 문자열 비유출(3면) ------------------------------------------------------------

	/**
	 * (a) <b>반환 맵 직렬화 전문</b>에 키가 0건이다.
	 *
	 * <p><b>URL에 키를 합성하는 주체가 이 서비스</b>다 — 어댑터에만 같은 단언이 있으면 부족하다. 진단
	 * 편의로 실패 응답에 URL을 담는 순간({@code {ok:false, reason:'error', url:...}}) 그것은 곧 응답
	 * 본문이고, 한 번 나간 서버 보유 키는 회수할 수 없다.
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

		for (Field field : TranslationService.class.getDeclaredFields()) {
			assertFalse(field.getType().getSimpleName().contains("Log"), "로그 타입 필드가 생겼다: " + field);
		}
		for (Constructor<?> constructor : TranslationService.class.getDeclaredConstructors()) {
			for (Class<?> parameter : constructor.getParameterTypes()) {
				assertFalse(parameter.getSimpleName().contains("Log"), "생성자가 로그 싱크를 받는다: " + constructor);
			}
		}
		for (Method method : TranslationService.class.getDeclaredMethods()) {
			assertFalse(method.toGenericString().contains("Log"), "메서드 시그니처에 로그 타입이 있다: " + method);
		}
	}

	/**
	 * (c) <b>예외 메시지와 원인 체인</b>에 키가 0건이고, 애초에 예외가 밖으로 나가지 않는다.
	 *
	 * <p>어댑터는 <b>URL 전문을 메시지에 담은 예외</b>를 던진다({@code URI.create}의
	 * {@code IllegalArgumentException}·{@code ConnectException}이 실제로 그렇게 한다). 서비스가 그것을
	 * 그대로 올리면 전역 핸들러가 500과 함께 메시지를 남기고 그 자리에 서버 보유 키가 남는다 — 게다가
	 * 이 라우트는 <b>실패해도 200이어야</b> 한다.
	 */
	@Test
	@DisplayName("예외 메시지·원인 체인에 키가 0건이고 서비스는 던지지 않는다")
	void theApiKeyNeverReachesAnExceptionMessageOrItsCauseChain() {
		this.proxy.reset();
		this.proxy.failure = new IllegalStateException("connect failed",
				new IllegalArgumentException("bad URI: " + ENDPOINT + "?key=" + SENTINEL_KEY));

		Throwable thrown = null;
		Map<String, Object> result = null;
		try {
			result = keyed().translate(BODY, "en");
		}
		catch (Throwable ex) {
			thrown = ex;
		}

		for (Throwable cause = thrown; cause != null; cause = cause.getCause()) {
			assertFalse(String.valueOf(cause.getMessage()).contains("SENTINEL"),
					"예외 원인 체인의 메시지에 키가 실렸다: " + cause);
		}
		assertNull(thrown, "서비스가 예외를 밖으로 던졌다 — 200이 500이 된다: " + thrown);
		assertEquals("error", result.get("reason"));
	}

	// --- 유틸 --------------------------------------------------------------------------------

	/** {@code null}을 맵 키로 쓸 수 없어 세우는 표식 — "targetLang 미전달"을 뜻한다. */
	private static final Object NULL_TARGET = new Object();

	/** 키가 설정된 서비스로 <b>성공·비2xx·파싱 실패·shape 이상·어댑터 예외</b> 경로를 전부 돌린 반환 맵들. */
	private List<Map<String, Object>> exerciseEveryPathWithTheKey() {
		List<Map<String, Object>> results = new ArrayList<>();
		List<Runnable> arrangements = List.of(
				() -> this.proxy.next = new ExternalProxyClient.Result(true, OK_BODY),
				() -> this.proxy.next = new ExternalProxyClient.Result(false, "denied"),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "not json"),
				() -> this.proxy.next = new ExternalProxyClient.Result(true, "{\"data\":{\"translations\":[]}}"),
				() -> this.proxy.failure = new IllegalStateException("boom " + ENDPOINT + "?key=" + SENTINEL_KEY));
		for (Runnable arrange : arrangements) {
			for (Object target : Arrays.asList("en", null, "")) {
				this.proxy.reset();
				arrange.run();
				results.add(keyed().translate(BODY, target));
			}
		}
		// 빈 본문·기사 진입점도 같은 그물에 넣는다(외부 호출이 없는 경로에서도 키는 새면 안 된다).
		this.proxy.reset();
		results.add(keyed().translate("", "en"));
		results.add(keyed().translateArticle(article("{\"blocks\":[{\"text\":\"x\"}]}", null), "en"));
		return results;
	}

	private static boolean scanForKey(LogService log) {
		return log.digest(FIXED_INSTANT.toEpochMilli() + ONE_DAY_MS).stream()
				.anyMatch((record) -> String.valueOf(record).contains("SENTINEL"));
	}

	private TranslationService keyless() {
		return new TranslationService(this.proxy, new TranslateProperties(""));
	}

	private TranslationService keyed() {
		return new TranslationService(this.proxy, new TranslateProperties(SENTINEL_KEY));
	}

	/** {@code ArticleReadService.getById}가 돌려주는 모양. */
	private static Map<String, Object> article(String markupVersion, String title) {
		Map<String, Object> row = new LinkedHashMap<>();
		row.put("articleId", "A-1");
		row.put("title", title);
		row.put("markupVersion", markupVersion);
		Map<String, Object> found = new LinkedHashMap<>();
		found.put("article", row);
		return found;
	}

	/** 네트워크 없는 어댑터 대역 — 호출 URL을 그대로 기록한다. */
	private static final class RecordingProxy implements ExternalProxyClient {

		private final List<String> gets = new ArrayList<>();

		private final List<String> posts = new ArrayList<>();

		private Result next = new Result(true, OK_BODY);

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
			this.next = new Result(true, OK_BODY);
			this.failure = null;
		}

	}

}
