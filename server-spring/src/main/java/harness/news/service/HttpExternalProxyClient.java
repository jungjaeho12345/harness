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
 * {@link ExternalProxyClient}의 실구현 — JDK {@code java.net.http}로 외부 API를 <b>한 번</b> 호출한다.
 * Node {@code src/services/mediaSearch.js} 57행({@code fetchFn(url)})과 {@code src/services/translate.js}
 * 45행({@code fetchFn(req.url, {method:'POST'})})의 자리다.
 *
 * <h2>왜 이 파일이 ADR-008 네트워크 예외 ②인가</h2>
 * <b>{@code ADR-014}가 결정한 서버 보유 키 프록시</b>다. 미디어 검색(Google CSE·YouTube)과 번역
 * (Google Translate v2)은 <b>사용자 트리거 동기 1회</b> 조회이며 — 앱이 스스로 시점을 정하지 않는다 —
 * API 키를 클라이언트에 내리지 않기 위해 <b>서버가 대신 나가는 것이 기능 그 자체</b>다. ADR-008이 금지하는
 * egress는 <b>배부 축의 자동 송출</b>(앱이 시점을 정해 내보내는 것)이고 이 호출은 그 축이 아니다.
 * <b>{@code ADR-005}를 인용하지 마라</b> — 그 ADR은 SSE 단방향 무효화 스트림 결정이고, Node 주석
 * ({@code mediaSearch.js} 1행 · {@code translate.js} 2행)의 'ADR-005 서버 프록시'는 {@code ADR-014}
 * 트레이드오프가 기록한 <b>오인용</b>이다.
 *
 * <p>같은 예외 목록의 {@code HttpApiSourceFetcher}(예외 ①)와는 <b>역할이 다르다</b>: 그쪽은 {@code rcv.md}가
 * 정의한 <b>수집 pull</b>(등록된 소스에서 기사를 당겨온다 · GET + {@code Authorization: Bearer})이고,
 * 이쪽은 사용자 질의를 대신 던지는 프록시(GET/POST · 키는 <b>URL 쿼리</b>)다. 그래서 그 인터페이스를
 * 확장하지 않고 별도 파일로 둔다 — 확장하면 '수집 pull 어댑터'라는 예외 정당화가 미디어·번역까지 덮는
 * 것처럼 오독되고, 그 fake 구현들({@code CollectionServiceTest} 등)이 함께 움직인다.
 *
 * <p>예외는 <b>3군(네트워크)에만</b> 열려 있다 — 여기서도 타이머·자동 재시도·비동기·파일 쓰기는 금지이고
 * {@code Adr008DisciplineTest}가 그 사실을 자기 검사로 못 박는다
 * ({@code theExemptionAppliesOnlyToItsOwnFileAndItsOwnGroup}).
 *
 * <h2>규율 — 71a 안전 파라미터의 명문 승계</h2>
 * 아래 값은 {@code HttpApiSourceFetcher}(2026-08-25 ⑤ 코드리뷰 반려 폐색)에서 <b>그대로</b> 가져온 것이며
 * 임의로 완화·강화하지 않는다.
 * <ol>
 * <li><b>{@code HttpClient}는 필드 하나로 재사용</b>한다. 호출마다 새로 만들면 커넥션과 셀렉터 스레드가
 * 누적된다(검색은 타이핑마다 불릴 수 있는 라우트다). {@code executor(...)}는 주지 않는다 — 워커 풀을
 * 우리가 만들지 않는다(ADR-008 (6)).</li>
 * <li><b>connect timeout 10초 · request timeout 30초 — Node와의 의도적 divergence다.</b> Node
 * {@code fetch}에는 요청 타임아웃이 없다. 완전 동형은 '무한 대기'인데 두 서버에서 대가가 다르다: Node는
 * 단일 이벤트 루프라 기다리는 동안에도 다른 요청을 처리하지만, Spring은 요청 하나가 <b>Tomcat 워커
 * 하나</b>를 점유한다(기본 200). 응답하지 않는 외부 API + 사용자 재시도면 워커가 고갈돼 <b>전 라우트가
 * 죽는다</b>. 그래서 가용성 쪽으로 갈렸다. 타임아웃은 <b>단일 요청의 상한</b>일 뿐 재시도·백오프가 아니다.
 * <p><b>잔여 위험(정직한 공백 — 71a와 동일)</b>: {@code HttpRequest.timeout}은 응답 <b>헤더</b>까지만
 * 덮는다(JDK 21.0.12 실측). 헤더를 즉시 보내고 본문을 천천히 흘리는 상대는 상한을 넘겨도 계속 읽히며
 * 그동안 워커를 점유한다. 그것을 막으려면 타이머나 별도 스레드가 필요하고 그것이 ADR-008 (3)(6)
 * 위반이다 — 그래서 열어 둔다.</li>
 * <li><b>리다이렉트 미추종</b>({@link HttpClient.Redirect#NEVER}). Node {@code fetch}는 기본
 * {@code follow}라 <b>의도된 divergence</b>이고, 여기서는 이유가 더 무겁다 — 이 URL에는 <b>서버 보유
 * 키</b>가 실려 있어 따라가면 키가 리다이렉트 대상으로 새어 나간다.</li>
 * <li><b>응답 본문 상한 16 MiB</b>. 상한이 없으면 거대 응답이 {@code OutOfMemoryError}를 내는데 그것은
 * 아래 {@code catch}가 <b>잡지 못해</b> JVM 전체가 죽는다. 초과는 <b>기존 실패 경로와 같은 shape</b>
 * ({@code ok=false} · 본문 없음)으로 접는다 — 잘라서 돌려주면 서비스 파서가 조용히 다른 검색 결과·다른
 * 번역문을 만든다.</li>
 * <li><b>본문은 언제나 UTF-8로 읽는다.</b> 기본 {@code ofString()}은 응답이 선언한 charset을 따라가는데
 * (charset이 <b>없을 때만</b> UTF-8로 접는다 — 71a 실측), Node {@code res.text()}는 그 선언을 <b>보지
 * 않고</b> 언제나 UTF-8로 판독한다(2026-08-28 재실측: {@code charset=euc-kr}로 잘못 선언된 UTF-8 본문이
 * 원문 그대로 나왔다). 여기서 갈리면 두 서버의 <b>번역문 자체</b>가 달라진다.</li>
 * <li><b>동기 {@code send}만 쓴다.</b> 비동기 호출은 요청 스레드 밖에서 도는 코드를 만들고 그것이
 * ADR-008 2군(비동기·재시도)의 금지 대상이다 — 이 파일은 <b>그 군의 예외가 아니다</b>. 정적 게이트의
 * 비동기 패턴 목록에는 이 철자가 없어 그것을 잡지 못하므로({@code Adr008DisciplineTest}는 step2 소유라
 * 이 step이 고치지 않는다) {@code HttpExternalProxyClientTest}가 소스 수준에서 금지를 못 박는다.</li>
 * <li><b>예외를 밖으로 던지지 않는다.</b> 잘못된 URL·연결 거부·인터럽트 전부 {@code ok=false}로 수렴한다.
 * 서비스가 그것을 데모 폴백/원문 폴백으로 옮긴다 — 던지면 200이어야 할 응답이 500이 된다.</li>
 * </ol>
 *
 * <h2>하지 않는 것</h2>
 * SSRF 허용 목록·사설 IP 차단은 <b>넣지 않는다</b>(Node에 없다 — 방어를 추가하면 두 서버가 같은 입력에
 * 다른 결과를 준다). URL 정규화도 하지 않는다(서비스가 조립한 문자열 그대로 간다).
 * <b>{@code http}/{@code https} 외의 스킴만 거부</b>하는데 그것은 방어 추가가 아니라 Node 동형이다
 * (Node {@code fetch}도 {@code file:}에 {@code TypeError}를 던진다 — 실측). 도메인 판정(데모 폴백 ·
 * {@code no-key} · 응답 파싱)도 여기 없다 — 이 파일은 '밖으로 나가는 방법'만 안다(ADR-006).
 *
 * <h2>로깅</h2>
 * URL·API 키·응답 본문을 로그·예외 메시지에 담지 않는다. <b>이 클래스에는 로그 싱크가 없다</b> — 로그 링
 * 버퍼는 {@code GET /api/logs/digest}로 밖으로 나가므로(LOGS.md · ADR-007) 거기 들어간 키 한 조각은 곧
 * 응답이다. 실패 사유를 남기지 않는 것은 진단 편의보다 <b>키를 밖에 내지 않는 것</b>이 무겁기 때문이다.
 */
@Component
public class HttpExternalProxyClient implements ExternalProxyClient {

	/** 연결 단계 상한(규율 2). */
	private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);

	/** 요청 단계 상한(규율 2). */
	private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);

	/** 응답 본문 바이트 상한(규율 4). */
	private static final long MAX_BODY_BYTES = 16L * 1024 * 1024;

	/** 클라이언트는 필드 하나로 재사용한다(규율 1). */
	private final HttpClient http;

	private final Duration requestTimeout;

	private final long maxBodyBytes;

	public HttpExternalProxyClient() {
		this(REQUEST_TIMEOUT, MAX_BODY_BYTES);
	}

	/** 테스트 전용 — 상한을 작게 주입해 실제 왕복으로 경계를 관측한다(프로덕션 배선은 기본 생성자다). */
	HttpExternalProxyClient(Duration requestTimeout, long maxBodyBytes) {
		this.requestTimeout = requestTimeout;
		this.maxBodyBytes = maxBodyBytes;
		this.http = HttpClient.newBuilder()
				.connectTimeout(CONNECT_TIMEOUT)
				.followRedirects(HttpClient.Redirect.NEVER)
				.build();
	}

	@Override
	public Result get(String url) {
		return send(url, false);
	}

	@Override
	public Result post(String url) {
		return send(url, true);
	}

	/**
	 * 1회 호출의 단일 지점 — GET과 POST의 차이는 <b>메서드 한 줄</b>뿐이다(둘로 나누면 타임아웃·상한·
	 * 판독·예외 처리가 두 벌이 되고 한쪽만 고쳐지는 날이 온다).
	 *
	 * @param post {@code true}면 본문 없는 POST(Node 실측: {@code content-length: 0} · 헤더 없음)
	 */
	private Result send(String url, boolean post) {
		URI uri = httpUri(url);
		if (uri == null) {
			return failed();
		}
		try {
			HttpRequest.Builder request = HttpRequest.newBuilder(uri).timeout(this.requestTimeout);
			if (post) {
				request.POST(HttpRequest.BodyPublishers.noBody());
			}
			else {
				request.GET();
			}
			// 헤더는 하나도 붙이지 않는다 — 키는 URL 쿼리에 있다(Node 동형).
			HttpResponse<InputStream> response = this.http.send(request.build(),
					HttpResponse.BodyHandlers.ofInputStream());
			String body = readCapped(response.body());
			if (body == null) {
				// 상한 초과 — 연결 거부와 같은 실패 shape이다(새 사유를 만들지 않는다).
				return failed();
			}
			int status = response.statusCode();
			// res.ok === 2xx. 실패여도 본문은 담아 돌려준다(호출자가 쓰지 않아도 진단 여지를 남긴다).
			return new Result(status >= 200 && status < 300, body);
		}
		catch (InterruptedException ex) {
			// 인터럽트 상태를 복원하고 실패로 접는다 — 삼키면 상위가 취소 신호를 못 본다.
			Thread.currentThread().interrupt();
			return failed();
		}
		catch (IOException | RuntimeException ex) {
			// 연결 거부·DNS 실패·타임아웃 등. 사유를 담지 않는다(URL과 키가 메시지에 섞여 있다).
			return failed();
		}
	}

	/**
	 * 본문을 <b>상한까지만</b> 읽어 UTF-8로 판독한다. 상한을 넘으면 {@code null}을 돌려주고 호출자가 그것을
	 * 기존 실패 shape으로 접는다.
	 *
	 * <p>왜 {@code ofString(UTF_8)}이 아니라 스트림인가: {@code ofString}은 <b>다 읽은 뒤에야</b> 크기를
	 * 알 수 있어 상한을 걸 자리가 없다(그 사이 힙이 먼저 죽는다). 판독은 여전히 <b>언제나 UTF-8</b>이다.
	 *
	 * <p>try-with-resources로 닫는 것이 중요하다: 상한에서 빠져나갈 때 스트림을 닫아야 그 커넥션이
	 * 취소된다(닫지 않으면 상대가 남은 본문을 계속 밀어 넣는다).
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
	 * 원문 비교면 {@code HTTP://}로 조립된 정상 URL을 막고, 기본 로케일 소문자화면 터키어 로케일에서
	 * {@code I}가 점 없는 {@code ı}가 되어 판정이 환경에 따라 갈린다.
	 */
	private static URI httpUri(String url) {
		if (url == null || url.isEmpty()) {
			return null;
		}
		URI uri;
		try {
			uri = URI.create(url);
		}
		catch (IllegalArgumentException ex) {
			// 메시지에 URI 전문(=키)이 들어 있다 — 밖으로 내보내지 않는다.
			return null;
		}
		String scheme = uri.getScheme();
		if (scheme == null) {
			return null;
		}
		String normalized = scheme.toLowerCase(Locale.ROOT);
		return ("http".equals(normalized) || "https".equals(normalized)) ? uri : null;
	}

	private static Result failed() {
		return new Result(false, null);
	}

}
