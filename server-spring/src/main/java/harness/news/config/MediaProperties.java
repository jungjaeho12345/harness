package harness.news.config;

import harness.news.service.NodeString;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 미디어 검색 프록시가 쓰는 <b>서버 보유 API 키</b> 바인딩({@code app.media.*}) — ADR-014.
 *
 * <p>값은 <b>주입된 환경변수에서만</b> 온다({@code GOOGLE_API_KEY}·{@code GOOGLE_CSE_ID}·
 * {@code YOUTUBE_API_KEY}). 소스에 하드코딩하지 않는 것은 보안 규율이고 정본도 {@code env}에서만 읽는다
 * ({@code src/services/mediaSearch.js} 2행의 CRITICAL 주석).
 *
 * <h2>왜 {@link AppProperties}에 넣지 않는가</h2>
 * {@code AppProperties}는 record이고 {@code new AppProperties(...)} 호출부가 테스트 9곳에 있다. 컴포넌트를
 * 하나 더하면 그 파일들이 전부 함께 바뀐다 — {@link CollectionProperties}·{@link SpoolProperties}가 같은
 * 이유로 분리돼 있고, 무엇보다 <b>설정의 소유 경계</b>가 도메인별로 유지된다.
 *
 * <h2>키 세 개는 두 묶음이다</h2>
 * 이미지 검색(Google CSE)은 {@code googleApiKey}<b>와</b> {@code googleCseId}가 <b>둘 다</b> 있어야 열리고,
 * 영상 검색(YouTube)은 {@code youtubeApiKey} 하나면 열린다 — 정본 {@code buildUrl}의 판정 그대로다. 한쪽만
 * 설정된 배포는 <b>미설정과 같다</b>: 외부 호출 없이 데모 폴백이다.
 *
 * <h2>빈 값·공백은 미설정이다</h2>
 * 바인딩이 값을 주지 않으면 {@code null}이고, {@code ${GOOGLE_API_KEY:}} 기본값이면 빈 문자열이다 — 둘 다
 * 미설정으로 수렴시킨다. <b>공백만 있는 값도 미설정</b>이다: JS {@code truthy}는 공백 한 칸을 '설정됨'으로
 * 보지만({@code CollectionProperties.token}이 그 판정을 그대로 따르는 자리다) 여기서 같은 선택을 하면
 * {@code .env}의 오타 한 줄이 <b>키 자리에 공백을 실은 실제 외부 호출</b>을 만든다 — 키가 없어야 할 배포가
 * 조용히 egress를 시작하는 것이 이 축에서 훨씬 나쁘다(ADR-014: "키가 없으면 외부 호출을 아예 하지
 * 않는다"). 토큰과 달리 이 값들은 <b>서버가 만들어 보내는 쪽</b>이라 클라이언트와 갈릴 여지도 없다.
 *
 * <p>다듬기 판정은 {@link NodeString#trim}이 단일 출처다({@code String.trim()}·{@code String.strip()}은 JS
 * 공백 집합과 갈린다). <b>값 자체는 다듬지 않는다</b> — 미설정 판정에만 쓰고, 설정된 키는 원문 그대로
 * URL에 실어 정본과 같은 요청을 만든다.
 *
 * @param googleApiKey Google Custom Search API 키({@code GOOGLE_API_KEY})
 * @param googleCseId Google CSE 엔진 id({@code GOOGLE_CSE_ID})
 * @param youtubeApiKey YouTube Data API 키({@code YOUTUBE_API_KEY})
 */
@ConfigurationProperties("app.media")
public record MediaProperties(String googleApiKey, String googleCseId, String youtubeApiKey) {

	public MediaProperties {
		googleApiKey = normalize(googleApiKey);
		googleCseId = normalize(googleCseId);
		youtubeApiKey = normalize(youtubeApiKey);
	}

	/** 이미지 검색(Google CSE)이 열리는 조건 — 키와 엔진 id가 <b>둘 다</b> 있어야 한다. */
	public boolean hasImageKeys() {
		return !this.googleApiKey.isEmpty() && !this.googleCseId.isEmpty();
	}

	/** 영상 검색(YouTube)이 열리는 조건. */
	public boolean hasVideoKey() {
		return !this.youtubeApiKey.isEmpty();
	}

	/** {@code null}·빈 문자열·공백뿐인 값을 하나의 '미설정' 표현(빈 문자열)으로 모은다. */
	private static String normalize(String value) {
		if (value == null || NodeString.trim(value).isEmpty()) {
			return "";
		}
		return value;
	}
}
