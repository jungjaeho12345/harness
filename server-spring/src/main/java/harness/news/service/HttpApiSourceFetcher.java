package harness.news.service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import org.springframework.stereotype.Component;

/**
 * {@link ApiSourceFetcher}의 실구현 — JDK {@code java.net.http}로 등록된 수집 endpoint를 <b>한 번</b>
 * 호출한다. Node {@code src/services/collectionService.js} 55~62행(global {@code fetch})의 자리다.
 *
 * <p><b>이 파일은 이 서버에서 아웃바운드 네트워크 호출이 허용된 유일한 자리다.</b>
 * {@code Adr008DisciplineTest}의 네트워크 예외 목록에 <b>파일 단위로</b> 등재돼 있다(예외는 이 파일과
 * 배부 스풀 라이터 둘뿐이며, 예외가 늘어나면 그 사실이 diff와 red로 드러난다). ADR-008의 egress 금지는
 * <b>배부</b> 축이고, 수집 pull은 {@code rcv.md}가 정의한 능동 수집이라 아웃바운드 호출이 기능 그 자체다.
 * 예외는 <b>3군(네트워크)에만</b> 열려 있다 — 여기서도 타이머·재시도·비동기는 금지다.
 *
 * <h2>규율</h2>
 * <ol>
 * <li><b>재시도 0</b>(ADR-008 (6)). {@code HttpClient} 기본값이 그렇고 여기서도 다시 시도하지 않는다.
 * 계약은 사유만 관측하므로 몰래 두 번 가도 응답은 같다 — 그래서 테스트가 <b>서버에서 요청 횟수를 센다</b>.</li>
 * <li><b>리다이렉트 미추종</b>({@link HttpClient.Redirect#NEVER}). Node {@code fetch}는 기본
 * {@code follow}라 <b>의도된 divergence</b>다: 계약이 관측하지 않는 축이고, 등록된 endpoint 밖으로
 * 요청이 새지 않는 <b>안전한 방향</b>으로 갈린다.</li>
 * <li><b>connect timeout 10초 · request timeout 없음.</b> Node {@code fetch}에는 타임아웃이 없어 완전
 * 동형은 '무한 대기'인데 그러면 Tomcat 워커가 고갈된다. 연결 단계만 막는다 — <b>느린 endpoint가 요청
 * 단계에서 워커를 점유하는 위험은 Node와 동일하게 남는다</b>(알려진 잔여 위험).</li>
 * <li><b>본문은 언제나 UTF-8로 읽는다.</b> 기본 {@code ofString()}은 응답이 선언한 charset을 따라가는데,
 * Node {@code res.text()}는 그 선언을 <b>보지 않고</b> 언제나 UTF-8로 판독한다(실측). charset을 틀리게
 * 선언한 소스에서 두 서버의 기사 제목이 갈리는 것을 막는다.</li>
 * <li><b>예외를 밖으로 던지지 않는다.</b> 잘못된 URI·연결 거부·인터럽트 전부 {@code ok=false}로
 * 수렴한다. 서비스가 그것을 {@code fetch-failed}로 옮긴다 — 던지면 계약의 400이 500이 된다.</li>
 * </ol>
 *
 * <h2>하지 않는 것</h2>
 * SSRF 허용 목록·사설 IP 차단은 <b>넣지 않는다</b>(Node에 없고, 계약 픽스처가 loopback을 쓴다 —
 * 막으면 성공 경로가 red다). endpoint 정규화도 하지 않는다(등록된 문자열 그대로 간다).
 * <b>{@code http}/{@code https} 외의 스킴만 거부</b>하는데 그것은 방어 추가가 아니라 Node 동형이다
 * (Node {@code fetch}도 {@code file:}에 {@code TypeError}를 던진다 — 실측). 그 거부는 {@code HttpRequest}
 * 빌더도 함께 해 준다(변이 실측: 이 게이트를 지워도 {@code file:}은 여전히 {@code ok=false}다) — 여기 남기는
 * 이유는 의도를 코드에 적어 두고 거부가 JDK 구현 세부에만 기대지 않게 하는 것이다.
 *
 * <h2>로깅</h2>
 * endpoint·apiKey·응답 본문을 로그·예외 메시지에 담지 않는다. 로그 링 버퍼는
 * {@code GET /api/logs/digest}로 밖으로 나간다 — 여기 들어간 한 조각은 곧 응답이다(LOGS.md · ADR-007).
 * 그래서 이 클래스는 아무것도 남기지 않는다.
 */
@Component
public class HttpApiSourceFetcher implements ApiSourceFetcher {

	/** 연결 단계 상한. 요청 단계는 열어 둔다(위 규율 3). */
	private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);

	/**
	 * 클라이언트는 <b>필드 하나로 재사용</b>한다. 호출마다 새로 만들면 커넥션과 셀렉터 스레드가 누적된다
	 * (반복 pull에서 드러난다). {@code executor(...)}를 주지 않는다 — 워커 풀을 우리가 만들지 않는다.
	 */
	private final HttpClient http;

	public HttpApiSourceFetcher() {
		this.http = HttpClient.newBuilder()
				.connectTimeout(CONNECT_TIMEOUT)
				.followRedirects(HttpClient.Redirect.NEVER)
				.build();
	}

	@Override
	public FetchResult fetch(String endpoint, String apiKey) {
		URI uri = httpUri(endpoint);
		if (uri == null) {
			return failed();
		}
		try {
			HttpRequest.Builder request = HttpRequest.newBuilder(uri).GET();
			if (apiKey != null && !apiKey.isEmpty()) {
				// 헤더는 이것 하나뿐이다. 값에 CR/LF가 섞이면 빌더가 거부하고 요청은 나가지 않는다.
				request.header("Authorization", "Bearer " + apiKey);
			}
			HttpResponse<String> response = this.http.send(request.build(),
					HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
			int status = response.statusCode();
			// res.ok === 2xx. 실패여도 본문은 담아 돌려준다(호출자가 쓰지 않아도 진단 여지를 남긴다).
			return new FetchResult(status >= 200 && status < 300, response.body());
		}
		catch (InterruptedException ex) {
			// 인터럽트 상태를 복원하고 실패로 접는다 — 삼키면 상위가 취소 신호를 못 본다.
			Thread.currentThread().interrupt();
			return failed();
		}
		catch (IOException | RuntimeException ex) {
			// 연결 거부·DNS 실패·헤더 값 거부 등. 사유를 담지 않는다(endpoint·키가 메시지에 섞여 있다).
			return failed();
		}
	}

	/**
	 * {@code http}/{@code https} 절대 URI만 통과시킨다. 파싱 실패·스킴 없음·다른 스킴은 {@code null}이며
	 * 그때 요청은 <b>만들어지지도 않는다</b>.
	 *
	 * <p>스킴 비교는 {@link Locale#ROOT} 소문자화 후에 한다: URI 스킴은 대소문자를 가리지 않으므로
	 * 원문 비교면 {@code HTTP://}로 등록된 정상 소스를 막고, 기본 로케일 소문자화면 터키어 로케일에서
	 * {@code I}가 점 없는 {@code ı}가 되어 판정이 환경에 따라 갈린다.
	 */
	private static URI httpUri(String endpoint) {
		if (endpoint == null || endpoint.isEmpty()) {
			return null;
		}
		URI uri;
		try {
			uri = URI.create(endpoint);
		}
		catch (IllegalArgumentException ex) {
			return null;
		}
		String scheme = uri.getScheme();
		if (scheme == null) {
			return null;
		}
		String normalized = scheme.toLowerCase(Locale.ROOT);
		return ("http".equals(normalized) || "https".equals(normalized)) ? uri : null;
	}

	private static FetchResult failed() {
		return new FetchResult(false, null);
	}

}
