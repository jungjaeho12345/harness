package harness.news.config;

import harness.news.service.NodeString;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 번역 프록시가 쓰는 <b>서버 보유 API 키</b> 바인딩({@code app.translate.*}) — ADR-014.
 *
 * <p>값은 <b>주입된 환경변수에서만</b> 온다({@code GOOGLE_TRANSLATE_API_KEY}). 소스 하드코딩 금지는
 * 보안 규율이고 정본도 {@code env}에서만 읽는다({@code src/services/translate.js} 3행의 CRITICAL 주석).
 * provider는 Google Cloud Translation v2이며 <b>키를 헤더가 아니라 쿼리 파라미터</b>({@code ?key=})로
 * 보낸다 — 그래서 이 값은 URL 문자열에 합성되고, 그만큼 로그·예외·응답으로 샐 자리가 많다
 * ({@code TranslationServiceTest}의 3면 비유출 단언이 그 자리를 잠근다).
 *
 * <h2>왜 {@link MediaProperties}에 합치지 않는가</h2>
 * 미디어 검색 키 3종과 번역 키 1종은 <b>다른 도메인의 설정</b>이고 정본에서도 다른 서비스가 다른
 * 환경변수를 읽는다. 합치면 {@code MediaProperties} 생성자 호출부(테스트 여러 곳)가 번역과 무관하게
 * 함께 움직이고, 무엇보다 "이 서비스가 어떤 키를 아는가"라는 경계가 흐려진다
 * ({@link CollectionProperties}·{@link SpoolProperties}가 같은 이유로 분리돼 있다).
 * {@code AppProperties}에 넣는 것은 금지다(그 record는 부팅 필수값의 자리다).
 *
 * <h2>빈 값·공백은 미설정이다</h2>
 * 바인딩이 값을 주지 않으면 {@code null}이고 {@code ${GOOGLE_TRANSLATE_API_KEY:}} 기본값이면 빈
 * 문자열이다 — 둘 다 미설정으로 수렴한다. <b>공백만 있는 값도 미설정</b>이며, 이것은
 * {@link MediaProperties}와 같은 <b>의도된 divergence</b>다: JS {@code !key}는 공백 한 칸을 '설정됨'으로
 * 보지만 그러면 {@code .env}의 오타 한 줄이 <b>키 자리에 공백을 실은 실제 외부 호출</b>을 만든다
 * (ADR-014: "키가 없으면 외부 호출을 아예 하지 않는다"). 미설정 판정에만 다듬기를 쓰고 <b>설정된 키 값
 * 자체는 원문 그대로</b> URL에 싣는다. 다듬기 판정은 {@link NodeString#trim} 단일 출처다.
 *
 * @param googleApiKey Google Cloud Translation v2 API 키({@code GOOGLE_TRANSLATE_API_KEY})
 */
@ConfigurationProperties("app.translate")
public record TranslateProperties(String googleApiKey) {

	public TranslateProperties {
		googleApiKey = (googleApiKey == null || NodeString.trim(googleApiKey).isEmpty()) ? "" : googleApiKey;
	}

	/** 번역 외부 호출이 열리는 조건. 거짓이면 {@code no-key}이고 어댑터는 <b>한 번도 불리지 않는다</b>. */
	public boolean hasKey() {
		return !this.googleApiKey.isEmpty();
	}

}
