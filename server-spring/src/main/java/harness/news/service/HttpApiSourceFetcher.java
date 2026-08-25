package harness.news.service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
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
 * <li><b>connect timeout 10초 · request timeout 30초 — Node와의 의도적 divergence다</b>(2026-08-25 ⑤
 * 코드리뷰 반려 폐색). Node {@code fetch}에는 요청 타임아웃이 <b>없다</b>. 완전 동형은 '무한 대기'인데
 * 두 서버에서 그 대가가 다르다: Node는 단일 이벤트 루프라 기다리는 동안에도 다른 요청을 계속 처리하지만,
 * Spring은 요청 하나가 <b>Tomcat 워커 하나</b>를 점유한다(기본 200). 응답을 주지 않는 endpoint 하나 +
 * 반복 pull이면 워커가 고갈돼 <b>29 라우트 전체</b>가 응답하지 못한다. 그래서 <b>가용성 쪽으로</b>
 * 갈렸다. 30초는 넉넉하다 — 계약 픽스처는 loopback 즉답이고 실제 수집 API도 초 단위다. 타임아웃은
 * <b>단일 요청의 상한</b>일 뿐 재시도·백오프가 아니다(ADR-008 (6)은 그대로다 — 실패는 그 자리에서
 * {@code ok=false}로 접히고 다시 가지 않는다).
 * <p><b>실측(JDK 21.0.12, 리포 밖 스크래치패드)</b>: {@code HttpRequest.timeout}은 <b>응답 헤더</b>까지만
 * 덮는다. 헤더를 늦게 보내는 서버에는 상한대로 {@code HttpTimeoutException}이 났지만(513ms/상한 500ms),
 * 헤더를 즉시 보내고 <b>본문을 3초에 걸쳐 흘리는</b> 서버는 상한 500ms에도 3,082ms를 기다려 200을 받았다.
 * 즉 <b>본문을 천천히 흘리는 소스가 워커를 점유하는 잔여 위험은 남는다</b>(정직한 공백 — 그것을 막으려면
 * 타이머나 별도 스레드가 필요하고 그것은 ADR-008 (3)(6) 위반이다).</li>
 * <li><b>응답 본문 상한 16 MiB — 역시 의도적 divergence다.</b> 상한이 없으면 거대 응답이
 * {@code OutOfMemoryError}를 내는데 그것은 아래 {@code catch}가 <b>잡지 못해</b> JVM 전체가 죽는다
 * (Node는 V8 문자열 상한 {@code RangeError}가 {@code fetch-failed}로 우아하게 접힌다 — 이 상한은 그
 * 동작을 되돌려 놓는 쪽이다). 16 MiB는 기사 1건 payload(수십 KB)의 수백 배이고 JVM 힙에 비하면 작다 —
 * 느린 정상 endpoint를 죽이지 않을 만큼 넉넉하되 힙을 지킬 만큼은 낮은 자리다. 초과는 <b>기존 실패
 * 경로와 같은 shape</b>({@code ok=false} · 본문 없음 → 서비스가 {@code fetch-failed})으로 접는다.
 * 새 사유 토큰은 만들지 않는다(전역 사유 표를 넓히면 phase 70이 동결한 400 계약이 깨진다).</li>
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

	/** 연결 단계 상한. */
	private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);

	/** 요청 단계 상한(위 규율 3). */
	private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);

	/** 응답 본문 바이트 상한(위 규율 4). */
	private static final long MAX_BODY_BYTES = 16L * 1024 * 1024;

	/**
	 * 클라이언트는 <b>필드 하나로 재사용</b>한다. 호출마다 새로 만들면 커넥션과 셀렉터 스레드가 누적된다
	 * (반복 pull에서 드러난다). {@code executor(...)}를 주지 않는다 — 워커 풀을 우리가 만들지 않는다.
	 */
	private final HttpClient http;

	private final Duration requestTimeout;

	private final long maxBodyBytes;

	public HttpApiSourceFetcher() {
		this(REQUEST_TIMEOUT, MAX_BODY_BYTES);
	}

	/** 테스트 전용 — 상한을 작게 주입해 실제 왕복으로 경계를 관측한다(프로덕션 배선은 기본 생성자다). */
	HttpApiSourceFetcher(Duration requestTimeout, long maxBodyBytes) {
		this.requestTimeout = requestTimeout;
		this.maxBodyBytes = maxBodyBytes;
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
			HttpRequest.Builder request = HttpRequest.newBuilder(uri).GET().timeout(this.requestTimeout);
			if (apiKey != null && !apiKey.isEmpty()) {
				// 헤더는 이것 하나뿐이다. 값에 CR/LF가 섞이면 빌더가 거부하고 요청은 나가지 않는다.
				request.header("Authorization", "Bearer " + apiKey);
			}
			HttpResponse<InputStream> response = this.http.send(request.build(),
					HttpResponse.BodyHandlers.ofInputStream());
			String body = readCapped(response.body());
			if (body == null) {
				// 상한 초과 — 연결 거부와 <b>같은</b> 실패 shape이다(새 사유 토큰을 만들지 않는다).
				return failed();
			}
			int status = response.statusCode();
			// res.ok === 2xx. 실패여도 본문은 담아 돌려준다(호출자가 쓰지 않아도 진단 여지를 남긴다).
			return new FetchResult(status >= 200 && status < 300, body);
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
	 * 본문을 <b>상한까지만</b> 읽어 UTF-8로 판독한다. 상한을 넘으면 {@code null}을 돌려주고 호출자가 그것을
	 * 기존 실패 shape으로 접는다.
	 *
	 * <p>왜 {@code ofString(UTF_8)}이 아니라 스트림인가: {@code ofString}은 <b>다 읽은 뒤에야</b> 크기를
	 * 알 수 있어 상한을 걸 자리가 없다(그 사이 힙이 먼저 죽는다). 스트림은 읽는 도중에 끊을 수 있다.
	 * 판독은 여전히 <b>언제나 UTF-8</b>이다(규율 5) — {@code new String(bytes, UTF_8)}도
	 * {@code ofString(UTF_8)}과 같이 잘못된 바이트를 U+FFFD로 대체한다.
	 *
	 * <p>잘라서 돌려주지 않는다. 잘린 JSON은 파서에서 다른 제목·본문이 되어 <b>조용히 틀린 기사</b>가
	 * 등록되기 때문이다 — 실패가 낫다.
	 *
	 * <p>try-with-resources로 닫는 것이 중요하다: 상한에서 빠져나갈 때 스트림을 닫아야 그 커넥션이
	 * 취소된다(닫지 않으면 서버가 남은 본문을 계속 밀어 넣는다).
	 */
	private String readCapped(InputStream body) throws IOException {
		try (InputStream stream = body) {
			ByteArrayOutputStream buffer = new ByteArrayOutputStream();
			byte[] chunk = new byte[8192];
			long total = 0;
			int read;
			while ((read = stream.read(chunk)) >= 0) {
				total += read;
				if (total > this.maxBodyBytes) {
					return null;
				}
				buffer.write(chunk, 0, read);
			}
			return buffer.toString(StandardCharsets.UTF_8);
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
