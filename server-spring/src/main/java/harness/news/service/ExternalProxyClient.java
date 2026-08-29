package harness.news.service;

/**
 * 서버 보유 키로 나가는 <b>사용자 트리거 동기 1회</b> 외부 조회의 seam — Node
 * {@code createMediaSearch({ fetchFn })} · {@code createTranslate({ fetchFn })}의 주입 지점과 같은 자리다
 * ({@code src/services/mediaSearch.js} 57행 · {@code src/services/translate.js} 45행).
 *
 * <p>이 인터페이스가 있는 이유는 계층이다(ADR-006·ADR-013): 미디어 검색 서비스와 번역 서비스는 URL 조립·
 * 응답 파싱·폴백 판정을 알고, "밖으로 나가는 방법"은 어댑터가 안다. 그래서 서비스 테스트가 네트워크 없이
 * 돈다. 반대로 <b>이 어댑터는 도메인을 모른다</b> — 데모 폴백·{@code no-key} 판정·응답 파싱을 여기 넣지
 * 마라(그것은 서비스의 것이다).
 *
 * <h2>규율 셋</h2>
 * <ol>
 * <li><b>1회 시도</b>다(ADR-008 (6) · ADR-014). 재시도·백오프·큐는 구현체에도 없다 — 실패는 서비스가
 * 값으로 접는다(미디어 {@code {items:[], error:true}} · 번역 {@code {ok:false, reason:'error',
 * translatedText:원문}}).</li>
 * <li><b>실패는 예외가 아니라 {@code ok=false}</b>다. 연결 거부·잘못된 URL·비-http 스킴·타임아웃·본문
 * 상한 초과가 전부 같은 shape으로 접힌다 — 어댑터가 던지는 순간 미디어의 200이 500이 되고 번역의
 * graceful degrade(키가 없어도 200)가 무너진다.</li>
 * <li><b>헤더를 붙이지 않는다.</b> 키는 <b>URL 쿼리</b>에 있다(Google CSE·YouTube·Translate v2가 전부
 * {@code ?key=} 방식이고 Node도 헤더를 하나도 붙이지 않는다 — 실측). {@code Authorization: Bearer}는 수집
 * pull 어댑터({@link ApiSourceFetcher})의 것이며 두 축을 섞지 마라.</li>
 * </ol>
 *
 * <p>이 파일은 <b>네트워크 타입을 import하지 않는다</b>. 실제 JDK {@code java.net.http} 구현은
 * {@code HttpExternalProxyClient}이며 <b>ADR-008 정적 게이트의 네트워크 예외 ②</b>다(예외 ①은 수집 pull의
 * {@code HttpApiSourceFetcher}).
 */
public interface ExternalProxyClient {

	/**
	 * URL을 <b>GET으로 1회</b> 호출한다 — 미디어 검색(CSE·YouTube)의 모양이다.
	 *
	 * @param url 서비스가 조립한 절대 URL(키가 쿼리에 실려 있다). 정규화하지 않는다
	 * @return 성공 여부와 본문 텍스트. 2xx가 아니면 {@code ok=false}다
	 */
	Result get(String url);

	/**
	 * URL을 <b>POST로 1회</b> 호출한다 — 번역(Translate v2)의 모양이다. <b>본문은 비어 있다</b>
	 * (Node {@code fetchFn(url, {method:'POST'})}는 본문 자리가 아예 없고 파라미터는 전부 URL 쿼리에
	 * 있다 — 와이어 실측: {@code content-length: 0}).
	 *
	 * @param url 서비스가 조립한 절대 URL(키가 쿼리에 실려 있다)
	 * @return 성공 여부와 본문 텍스트
	 */
	Result post(String url);

	/**
	 * 호출 결과 — Node {@code fetch} 응답 중 두 서비스가 실제로 쓰는 두 가지({@code res.ok} ·
	 * {@code await res.json()}의 재료)만 담는다. 상태코드·헤더는 판정에 쓰이지 않으므로 여기 두지 않는다
	 * (쓰지 않는 값을 나르면 그 값에 의존하는 코드가 생긴다 — {@link ApiSourceFetcher.FetchResult}와 같은
	 * 판단이다).
	 *
	 * <p><b>URL을 여기 담지 마라.</b> record는 {@code toString()}이 모든 컴포넌트를 찍고, 이 URL에는
	 * 서버 보유 키가 들어 있다 — 한 번 로그나 응답으로 나가면 회수할 수 없다(ADR-007 링 버퍼는
	 * {@code GET /api/logs/digest}로 밖으로 나간다).
	 */
	record Result(boolean ok, String body) {
	}

}
