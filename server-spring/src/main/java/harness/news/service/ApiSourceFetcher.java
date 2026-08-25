package harness.news.service;

/**
 * 등록된 수집 API 소스를 <b>한 번</b> 호출하는 seam — Node {@code createCollectionService({ fetchFn })}의
 * 주입 지점과 같은 자리다.
 *
 * <p>이 인터페이스가 있는 이유는 계층이다(ADR-006·ADR-013): {@link CollectionService}는 등록·활성 판정과
 * 파싱·등록만 알고, "밖으로 나가는 방법"은 어댑터가 안다. 그래서 서비스 테스트가 네트워크 없이 돈다.
 *
 * <p>규율 셋.
 * <ol>
 *   <li><b>1회 시도</b>다. 재시도·백오프·큐는 구현체에도 없다(ADR-008 (6) — 실패는 사유 반환이 계약이며
 *       계약 케이스 {@code pull-fetch-failed}가 그것을 동결한다).</li>
 *   <li><b>실패는 예외가 아니라 {@code ok=false}</b>다. 그래도 서비스는 구현체의 예외까지 잡아
 *       {@code fetch-failed}로 수렴시킨다(어댑터가 던지는 순간 400이 500이 되기 때문이다).</li>
 *   <li><b>헤더는 {@code apiKey}가 있을 때 {@code Authorization: Bearer <apiKey>} 하나뿐</b>이다. 값이
 *       없으면 {@code null}이 넘어오고 헤더도 없다 — 빈 문자열 키는 값이 없는 것과 같다(JS truthy).</li>
 * </ol>
 *
 * <p>이 파일은 네트워크 타입을 import하지 않는다. 실제 JDK {@code java.net.http} 구현은
 * {@code HttpApiSourceFetcher}이며 <b>ADR-008 정적 게이트가 허용하는 유일한 네트워크 파일</b>이다.
 */
public interface ApiSourceFetcher {

	/**
	 * 등록된 endpoint를 1회 호출한다.
	 *
	 * @param endpoint 수신 설정의 {@code apiEndpoint}(정규화하지 않는다 — 등록된 문자열 그대로)
	 * @param apiKey 있으면 Bearer 토큰, 없으면 {@code null}
	 * @return 성공 여부와 본문 텍스트. 2xx가 아니면 {@code ok=false}다.
	 */
	FetchResult fetch(String endpoint, String apiKey);

	/**
	 * 호출 결과 — Node {@code fetch} 응답 중 서비스가 쓰는 두 가지({@code res.ok}·{@code res.text()})만
	 * 담는다. 상태코드·헤더는 판정에 쓰이지 않으므로 여기 두지 않는다(쓰지 않는 값을 나르면 그 값에
	 * 의존하는 코드가 생긴다).
	 */
	record FetchResult(boolean ok, String body) {
	}

}
