package harness.news.service;

import harness.news.config.MediaProperties;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * 미디어 검색 프록시 서비스 — 리포 루트 {@code src/services/mediaSearch.js}와 1:1이다. HTTP 비의존
 * (ADR-006)이며 서블릿 타입을 하나도 알지 못한다.
 *
 * <h2>이 라우트는 언제나 200이다</h2>
 * 응답 키는 {@code ok}·{@code items}·{@code error} <b>3종 고정</b>이고 {@code ok}는 언제나 {@code true}다.
 * 실패는 사유 토큰이 아니라 <b>{@code error} 불리언 플래그</b>로만 표현된다. 그래서 이 서비스는
 * <b>예외를 밖으로 던지지 않는다</b> — 어댑터 실패·비2xx·본문 파싱 실패가 전부 {@code {items:[],
 * error:true}} 한 모양으로 접힌다(ADR-014 · ADR-008 (6): 재시도 0, 1회 시도뿐이다).
 *
 * <p>반환 맵은 {@code {items, error}} <b>두 키뿐</b>이다. 정본은 데모 경로에서 {@code demo:true}를 더
 * 붙이지만 <b>라우트가 그것을 떨구고</b> 응답 3키가 계약이므로, 떨궈질 값을 애초에 만들지 않는다.
 *
 * <h2>키가 없으면 밖으로 나가지 않는다</h2>
 * 정본 {@code buildUrl}은 키가 없으면 {@code undefined}를 내고 {@code fetchFn}은 <b>한 번도 불리지
 * 않는다</b>. 그 자리에 결정적 데모 폴백(이미지 6건 · 영상 4건)이 들어간다 — 계약 하네스는 자식 env에서
 * API 키를 지우므로 <b>계약이 관측하는 것은 언제나 이 경로</b>이고, 반대로 <b>키가 설정된 경로는 계약이
 * 구조적으로 볼 수 없다</b>(그 축의 유일 방어선은 {@code MediaSearchServiceTest}다).
 *
 * <h2>키 문자열은 어디로도 새지 않는다(ADR-014)</h2>
 * <b>URL에 키를 합성하는 주체가 이 클래스</b>다. 그 URL은 어댑터로만 나가고 반환값·로그·예외 메시지
 * 어디에도 실리지 않는다 — 이 클래스에 <b>로그 싱크가 없는 것이 그 규율의 일부</b>다(로그 링 버퍼는
 * {@code GET /api/logs/digest}로 밖으로 나간다, ADR-007). 진단 편의로 URL을 남기고 싶어지는 자리가
 * 정확히 여기이고, 한 번 나간 키는 회수할 수 없다.
 *
 * <h2>Node 의미론은 전부 단일 출처 헬퍼를 쓴다</h2>
 * 질의 접기 {@link NodeString#queryText}(반복 쿼리 키의 콤마 결합) · 공백 판정 {@link NodeString#trim} ·
 * 퍼센트 인코딩 {@link NodeUri#encodeURIComponent}. 셋 중 하나라도 표준 API로 바꾸면 두 서버가 갈리는데
 * 계약은 ASCII 질의 하나만 보므로 그 갈림을 관측하지 못한다.
 */
@Service
public class MediaSearchService {

	/** Google Custom Search — 이미지. */
	private static final String GOOGLE_IMAGE_ENDPOINT = "https://www.googleapis.com/customsearch/v1";

	/** YouTube Data API — 영상. */
	private static final String YOUTUBE_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";

	/** 정본 {@code DEMO_VIDEO_IDS} — 임베드 가능한 공개 샘플이며 <b>값도 순서도</b> 계약이다. */
	private static final List<String> DEMO_VIDEO_IDS = List.of("aqz-KE-bpKQ", "jNQXAC9IVRw", "ScMzIvxBSi4",
			"YE7VzlLtp-4");

	/** 정본 {@code String(query ?? '').trim() || '뉴스'}의 오른쪽 항. */
	private static final String DEFAULT_SEED = "뉴스";

	private static final int DEMO_IMAGE_COUNT = 6;

	/**
	 * 응답 본문 판독 전용 매퍼.
	 *
	 * <p>{@code JSON.parse}가 던지는 자리와 던지지 않는 자리를 그대로 옮긴다: 파싱 실패는
	 * {@code error:true}(정본은 {@code await res.json()}의 예외를 {@code catch}가 잡는다)이고, 파싱은
	 * 됐지만 {@code items}가 배열이 아니면 <b>빈 배열 + {@code error:false}</b>다({@code Array.isArray}).
	 */
	private static final ObjectMapper MAPPER = JsonMapper.builder().build();

	private final ExternalProxyClient proxy;

	private final MediaProperties keys;

	public MediaSearchService(ExternalProxyClient proxy, MediaProperties keys) {
		this.proxy = proxy;
		this.keys = keys;
	}

	/**
	 * 미디어 검색 1회.
	 *
	 * @param query 질의. 라우트의 {@code req.query.q ?? ''} 뒤의 값이라 {@code null}(생략)은 빈 문자열과
	 * 같고 <b>키가 반복되면 리스트</b>다
	 * @param type {@code "image"}<b>만</b> 이미지이고 <b>나머지는 전부 video</b>다 — 누락({@code null}) ·
	 * 이상값 · 대소문자 다른 {@code "IMAGE"} · 반복 키(리스트)가 모두 video다. 정본이 {@code type ===
	 * 'image'} 엄격 비교라 <b>리스트는 원소가 하나여도 문자열이 아니다</b>. {@code null}이 정상 입력이므로
	 * 여기서 {@code NullPointerException}이 나면 200이어야 할 라우트가 500이 된다(decisions (24)) —
	 * 그래서 <b>상수를 좌변에 두고</b> 집합 조회를 하지 않는다
	 * @return 순서 있는 {@code {items, error}}. {@code items}는 <b>매 호출 새 리스트</b>이고(호출자가
	 * 변형해도 안전하다) 예외는 절대 나가지 않는다
	 */
	public Map<String, Object> search(Object query, Object type) {
		boolean image = "image".equals(type); // 좌변이 상수라 type이 null이어도 안전하다
		String url = buildUrl(image, query);
		if (url == null) {
			// 키 누락 — 외부 호출 없이 데모 샘플이다(정본 55행: buildUrl이 undefined면 즉시 반환).
			return result(demoResults(image, query), false);
		}
		ExternalProxyClient.Result response;
		try {
			response = this.proxy.get(url);
		}
		catch (RuntimeException ex) {
			// 어댑터는 던지지 않는 것이 계약이지만, 던져도 200을 지킨다. 사유를 담지 않는다 —
			// 메시지에 URL(=키)이 섞여 있다.
			return result(new ArrayList<>(), true);
		}
		if (response == null || !response.ok()) {
			return result(new ArrayList<>(), true); // 정본 empty()
		}
		List<Object> items = parseItems(response.body());
		if (items == null) {
			return result(new ArrayList<>(), true); // 본문 파싱 실패 — res.json()의 예외 자리
		}
		return result(items, false);
	}

	/**
	 * type별 요청 URL. 키가 없으면 {@code null}이고 <b>그때 외부 호출은 일어나지 않는다</b>.
	 *
	 * <p>파라미터 순서·이름·구분자가 정본과 <b>문자 단위로</b> 같아야 한다. 키는 인코딩하지 않는다(정본이
	 * 템플릿에 그대로 끼워 넣는다). 질의는 <b>시드 정규화 전의 원 질의</b>다 — {@code '뉴스'} 폴백은
	 * {@link #demoResults}의 것이지 URL의 것이 아니다.
	 */
	private String buildUrl(boolean image, Object query) {
		String encodedQuery = NodeUri.encodeURIComponent(NodeString.queryText(query));
		if (image) {
			if (!this.keys.hasImageKeys()) {
				return null;
			}
			return GOOGLE_IMAGE_ENDPOINT + "?key=" + this.keys.googleApiKey() + "&cx=" + this.keys.googleCseId()
					+ "&searchType=image&q=" + encodedQuery;
		}
		if (!this.keys.hasVideoKey()) {
			return null;
		}
		return YOUTUBE_ENDPOINT + "?key=" + this.keys.youtubeApiKey() + "&part=snippet&type=video&q="
				+ encodedQuery;
	}

	/**
	 * 응답 본문에서 {@code items}를 꺼낸다.
	 *
	 * @return 배열이면 그 원소들, 배열이 아니거나 본문이 객체가 아니면 <b>빈 리스트</b>, 파싱 자체가
	 * 실패하면 {@code null}(호출자가 {@code error:true}로 접는다)
	 */
	private static List<Object> parseItems(String body) {
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
		List<Object> items = new ArrayList<>();
		if (parsed instanceof Map<?, ?> object && object.get("items") instanceof List<?> array) {
			items.addAll(array);
		}
		return items;
	}

	/**
	 * 데모 폴백 — 질의를 시드로 쓰는 <b>결정적</b> 샘플이다(같은 질의는 언제나 같은 결과).
	 *
	 * <p>원소 맵은 정본 리터럴 순서를 그대로 재현한다(image {@code title,link} · video
	 * {@code title,videoId,url}). 계약이 관측하는 것은 키 집합과 개수뿐이지만 <b>제목·링크·videoId 값은
	 * 관측하지 않으므로</b> 여기서 갈리면 아무도 모른다 — 그래서 값 전체를 테스트가 잠근다.
	 */
	private static List<Object> demoResults(boolean image, Object query) {
		String seed = seed(query);
		List<Object> items = new ArrayList<>();
		if (image) {
			String encodedSeed = NodeUri.encodeURIComponent(seed);
			for (int i = 0; i < DEMO_IMAGE_COUNT; i++) {
				Map<String, Object> item = new LinkedHashMap<>();
				item.put("title", seed + " 이미지 " + (i + 1) + " (데모)");
				item.put("link", "https://picsum.photos/seed/" + encodedSeed + "-" + i + "/320/200");
				items.add(item);
			}
			return items;
		}
		for (int i = 0; i < DEMO_VIDEO_IDS.size(); i++) {
			String id = DEMO_VIDEO_IDS.get(i);
			Map<String, Object> item = new LinkedHashMap<>();
			item.put("title", seed + " 관련 영상 " + (i + 1) + " (데모)");
			item.put("videoId", id);
			item.put("url", "https://www.youtube.com/watch?v=" + id);
			items.add(item);
		}
		return items;
	}

	/**
	 * 정본 {@code String(query ?? '').trim() || '뉴스'}.
	 *
	 * <p>{@code trim}은 {@link NodeString#trim} 단일 출처다 — {@link String#trim()}은 NBSP·BOM을 남기고
	 * {@link String#strip()}은 그 둘을 남기면서 U+001C~U+001F를 지운다. JS는 정확히 그 반대다.
	 */
	private static String seed(Object query) {
		String trimmed = NodeString.trim(NodeString.queryText(query));
		return trimmed.isEmpty() ? DEFAULT_SEED : trimmed;
	}

	/** 반환 shape 단일 지점 — 키 순서 {@code items,error}가 정본 리터럴 순서다. */
	private static Map<String, Object> result(List<Object> items, boolean error) {
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("items", items);
		body.put("error", error);
		return body;
	}

}
