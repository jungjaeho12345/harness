package harness.news.service;

import harness.news.config.TranslateProperties;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * 번역 프록시 서비스 — 리포 루트 {@code src/services/translate.js}와 1:1이다. HTTP 비의존(ADR-006)이며
 * 서블릿 타입을 하나도 알지 못한다.
 *
 * <h2>상태코드로 성공을 판정할 수 없는 라우트다</h2>
 * 키 누락도, 외부 실패도 <b>200</b>이고 본문만 {@code ok:false}다. 4xx/5xx로 감싸면 클라이언트
 * ({@code httpModel})가 조용히 깨진다 — 그쪽은 상태코드를 해석하지 않고 JSON의 {@code ok}만 읽는다
 * (reason-tokens.md 표 3 #13). 그래서 이 서비스는 <b>어떤 경로에서도 던지지 않는다</b>: 어댑터 예외까지
 * 값으로 접는다. 그리고 {@code no-key}·{@code error}는 상태 매핑이 아니라 <b>200 본문의 필드</b>이므로
 * {@code ReasonStatus} 표에 넣지 않는다(index.json decisions (16)).
 *
 * <h2>분기 순서가 계약이다(정본 순서 그대로)</h2>
 * <ol>
 * <li><b>빈 본문</b> → {@code {ok:true, translatedText:''}} <b>2키</b>({@code reason} 없음). 키 판정보다
 * <b>먼저</b>라 키가 설정된 서버에서도 외부 호출이 <b>0회</b>다. 본문·제목이 모두 빈 기사에서만 도달하며
 * 계약 픽스처는 본문이 있어 <b>관측되지 않는다</b>.</li>
 * <li><b>키 없음</b> → {@code {ok:false, reason:'no-key', translatedText:원문}} 3키. 외부 호출 0회
 * (ADR-014: 키가 없으면 아예 나가지 않는다).</li>
 * <li><b>호출 실패·비정상 shape</b> → {@code {ok:false, reason:'error', translatedText:원문}} 3키.
 * <b>1회 시도뿐</b>이다(ADR-008 (6) — 재시도·백오프 금지).</li>
 * <li><b>성공</b> → {@code {ok:true, translatedText:번역문}} + provider가 감지 언어를 줄 때만
 * {@code sourceLang}. 감지 언어가 없으면 <b>키 자체가 없다</b>(정본은 {@code undefined}를 담지만
 * {@code JSON.stringify}가 그 키를 떨군다).</li>
 * </ol>
 *
 * <h2>키 문자열은 어디로도 새지 않는다(ADR-014)</h2>
 * <b>URL에 키를 합성하는 주체가 이 클래스</b>다. 그 URL은 어댑터로만 나가고 반환값·로그·예외 메시지
 * 어디에도 실리지 않는다 — 이 클래스에 <b>로그 싱크가 없는 것이 그 규율의 일부</b>다(로그 링 버퍼는
 * {@code GET /api/logs/digest}로 밖으로 나간다, ADR-007). 진단 편의로 URL을 남기고 싶어지는 자리가
 * 정확히 여기이고, 한 번 나간 키는 회수할 수 없다.
 */
@Service
public class TranslationService {

	/** Google Cloud Translation v2 — 정본 {@code ENDPOINT}. */
	private static final String ENDPOINT = "https://translation.googleapis.com/language/translate/v2";

	/** 정본 {@code req.body?.targetLang ?? 'ko'}의 오른쪽 항. */
	private static final String DEFAULT_TARGET_LANG = "ko";

	private static final String DATA = "data";

	private static final String TRANSLATIONS = "translations";

	private static final String TRANSLATED_TEXT = "translatedText";

	private static final String DETECTED_SOURCE_LANGUAGE = "detectedSourceLanguage";

	/**
	 * 응답 본문 판독 전용 매퍼 — 정본 {@code await res.json()}의 자리다. 파싱 실패는 예외가 아니라
	 * {@code reason:'error'}다({@code catch}가 잡는 자리와 같다).
	 */
	private static final ObjectMapper MAPPER = JsonMapper.builder().build();

	private final ExternalProxyClient proxy;

	private final TranslateProperties keys;

	public TranslationService(ExternalProxyClient proxy, TranslateProperties keys) {
		this.proxy = proxy;
		this.keys = keys;
	}

	/**
	 * 기사 한 건의 본문을 번역한다 — <b>본문 도출부터 여기서 끝난다</b>.
	 *
	 * <p>라우트는 기사 id와 {@code targetLang}만 넘긴다(컨트롤러가 원본 행을 만지면 투영 경계 게이트가
	 * red다). 번역 대상은 <b>서버 DB에서만</b> 온다 — 요청 body의 {@code text}는 쓰지 않는다(ADR-004).
	 *
	 * @param found {@code ArticleReadService.getById}의 결과. {@code null}이어도 던지지 않는다(존재하지
	 * 않는 기사를 404로 만드는 판단은 HTTP 계층의 것이다)
	 */
	public Map<String, Object> translateArticle(Map<String, Object> found, Object targetLang) {
		return translate(ArticleText.of(found), targetLang);
	}

	/**
	 * 텍스트 하나를 번역한다.
	 *
	 * @param text 번역 대상. 비어 있으면 외부 호출 없이 2키 응답이다
	 * @param targetLang 대상 언어. 정본은 <b>{@code ??}만</b> 적용하므로 {@code null}(부재)만
	 * {@code 'ko'}가 되고 빈 문자열·숫자·배열은 <b>그대로</b> 간다 — 강제 정규화하지 마라(키 없는
	 * 서버에서는 관측 불가이나 키가 설정된 배포에서 갈린다)
	 * @return 순서 있는 맵. <b>예외는 절대 나가지 않는다</b>
	 */
	public Map<String, Object> translate(String text, Object targetLang) {
		if (text == null || text.isEmpty()) {
			// 1) 빈/누락 text — 키 판정보다 먼저다(외부 호출 0회 · reason 없는 2키).
			Map<String, Object> body = new LinkedHashMap<>();
			body.put("ok", true);
			body.put(TRANSLATED_TEXT, "");
			return body;
		}
		if (!this.keys.hasKey()) {
			return degraded("no-key", text); // 2) 키 누락 — 외부 호출 없이 원문 폴백
		}

		ExternalProxyClient.Result response;
		try {
			response = this.proxy.post(buildUrl(text, targetLang));
		}
		catch (RuntimeException ex) {
			// 어댑터는 던지지 않는 것이 계약이지만, 던져도 200을 지킨다. 사유에 예외 메시지를 담지
			// 않는다 — 그 메시지에는 URL(=키)이 섞여 있다.
			return degraded("error", text);
		}
		if (response == null || !response.ok()) {
			return degraded("error", text); // 정본 !res || !res.ok
		}
		Map<String, Object> parsed = parseTranslation(response.body());
		return (parsed == null) ? degraded("error", text) : parsed;
	}

	/**
	 * 요청 URL — 정본 {@code new URLSearchParams({key, q, target, format}).toString()}이다.
	 *
	 * <p>파라미터 <b>순서·이름·구분자·인코딩</b>이 문자 단위로 같아야 한다. 인코더는
	 * {@link NodeUri#encodeFormComponent}({@code x-www-form-urlencoded})이며
	 * <b>{@code encodeURIComponent}가 아니다</b> — 공백이 {@code +}이고 {@code (}·{@code )}·{@code !}·
	 * {@code '}·{@code ~}가 퍼센트 인코딩된다. 키도 같은 인코더를 통과한다(정본이 그렇다).
	 */
	private String buildUrl(String text, Object targetLang) {
		return ENDPOINT + "?key=" + NodeUri.encodeFormComponent(this.keys.googleApiKey())
				+ "&q=" + NodeUri.encodeFormComponent(text)
				+ "&target=" + NodeUri.encodeFormComponent(targetText(targetLang))
				+ "&format=text";
	}

	/**
	 * 정본의 {@code targetLang ?? 'ko'} 뒤에 {@code URLSearchParams}가 적용하는 {@code String(value)}.
	 *
	 * <p>반복 키·배열의 콤마 결합은 {@link NodeString#queryText} 단일 출처다.
	 * <b>알려진 잔여 divergence</b>(둘 다 계약 밖이고 실사용 값 공간 밖이다): JS는 일반 객체를
	 * {@code "[object Object]"}로, 정수인 실수를 {@code "5"}로 적는데 Java는 각각 맵 {@code toString}과
	 * {@code "5.0"}이다. 언어 태그 자리에 객체·실수를 보내면 어느 쪽이든 provider가 거부해
	 * {@code reason:'error'}로 수렴한다.
	 */
	private static String targetText(Object targetLang) {
		return (targetLang == null) ? DEFAULT_TARGET_LANG : NodeString.queryText(targetLang);
	}

	/**
	 * 정본 {@code parseResponse} — {@code body?.data?.translations?.[0]}에서 문자열
	 * {@code translatedText}를 꺼낸다.
	 *
	 * @return 성공 shape({@code ok,translatedText[,sourceLang]}) 또는 비정상이면 {@code null}
	 */
	private static Map<String, Object> parseTranslation(String body) {
		if (body == null) {
			return null; // 본문 없이 res.json()을 부르면 JS도 던진다
		}
		Object parsed;
		try {
			parsed = MAPPER.readValue(body, Object.class);
		}
		catch (RuntimeException ex) {
			return null; // Jackson 3의 파싱 예외는 unchecked다
		}
		if (!(parsed instanceof Map<?, ?> root) || !(root.get(DATA) instanceof Map<?, ?> data)
				|| !(data.get(TRANSLATIONS) instanceof List<?> translations) || translations.isEmpty()
				|| !(translations.get(0) instanceof Map<?, ?> first)
				|| !(first.get(TRANSLATED_TEXT) instanceof String translated)) {
			return null;
		}

		Map<String, Object> result = new LinkedHashMap<>();
		result.put("ok", true);
		result.put(TRANSLATED_TEXT, translated);
		if (first.containsKey(DETECTED_SOURCE_LANGUAGE)) {
			// 키가 없으면 JS는 undefined를 담고 JSON.stringify가 그 키를 통째로 떨군다 — 그래서
			// "없음"은 null이 아니라 키 부재다. 반대로 명시적 null은 그대로 실린다.
			result.put("sourceLang", first.get(DETECTED_SOURCE_LANGUAGE));
		}
		return result;
	}

	/** 실패 shape 단일 지점 — 키 순서 {@code ok,reason,translatedText}가 정본 리터럴 순서다. */
	private static Map<String, Object> degraded(String reason, String text) {
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("ok", false);
		body.put("reason", reason);
		body.put(TRANSLATED_TEXT, text);
		return body;
	}

}
