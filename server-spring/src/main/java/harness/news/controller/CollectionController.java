package harness.news.controller;

import harness.news.config.CollectionProperties;
import harness.news.service.CollectionAccess;
import harness.news.service.CollectionService;
import harness.news.service.CollectionTokenSource;
import harness.news.service.LogService;
import harness.news.web.JsonHttp;
import harness.news.web.ReasonStatus;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 수집 인제스트 2라우트 — {@code POST /api/collection/receive} · {@code POST /api/collection/pull}.
 * 리포 루트 {@code server/index.js} 1067~1125행과 1:1이다.
 *
 * <h2>사용자 세션 라우트가 아니다</h2>
 * 인벤토리의 {@code auth: "token"}({@code RoutePolicy.AuthClass.TOKEN}, {@code requiresSession=false})이다 —
 * 방어는 <b>바인드 주소</b>와 <b>{@code x-collection-token}</b>뿐이고, 여기서 세션을 읽으면
 * ({@code SessionTokens} 호출 0이어야 한다) 계약 3파일이 전부 401로 red가 된다.
 *
 * <h2>컨트롤러가 하는 일은 셋뿐이다(ADR-006)</h2>
 * <ol>
 *   <li><b>토큰 헤더 판독</b> — 반복 헤더는 Node 파서처럼 합쳐서 넘긴다({@link CollectionAccess#headerToken}).</li>
 *   <li><b>게이트 호출</b> — 가드 순서는 {@link CollectionAccess#decide} 하나가 소유한다(두 라우트가 같은
 *       함수를 부른다 — 복제하면 순서가 갈리고 계약이 그 순서를 관측한다).</li>
 *   <li><b>shape 매핑</b> — 성공 {@code {ok:true, articleId}} · 거부 {@code {ok:false, reason}}
 *       + 사유→상태({@link ReasonStatus}, 폴백 400).</li>
 * </ol>
 * 등록·활성 판정·파싱·저장은 {@link CollectionService}가 소유한다.
 *
 * <h2>동결된 상태코드</h2>
 * <pre>
 * 503 {"ok":false,"reason":"collection-disabled"}  ← 비-loopback + 토큰 미설정(최상단 가드)
 * 401 {"ok":false,"reason":"unauthenticated"}      ← 토큰 설정 서버에 헤더 부재·불일치
 * 403 unregistered · inactive                      ← 전역 표
 * 400 no-active-api-source · fetch-failed          ← 전역 표에 <b>없다</b>(폴백 400이 계약이다)
 * 200 {"ok":true,"articleId":"…"}                  ← payload가 없어도 200이다(입력 검증 없음)
 * </pre>
 * {@code collection-disabled}는 Node도 전역 표({@code STATUS_BY_REASON})에 두지 않고 라우트에서 직접
 * 503을 쓴다 — 여기서도 같다. 표에 올리면 다른 라우트가 그 토큰을 낼 때 조용히 503이 된다.
 *
 * <h2>본문에서 읽는 키는 둘뿐이다</h2>
 * {@code sourceId}·{@code payload}만 꺼낸다(통짜 전달 금지). {@code payload}는 타입을 강제하지 않고 그대로
 * 넘긴다 — 문자열·객체·배열·숫자·부재를 파서가 각각 다르게 다루는 것이 계약이다. {@code sourceId}도
 * 강제변환하지 않는다(리포지토리의 값 바인딩 정책이 단일 출처다 — 비스칼라는 500으로 수렴한다).
 *
 * <p><b>가드가 본문 판독보다 앞이다</b>: 503으로 닫힌 서버는 신뢰할 수 없는 본문을 파싱조차 하지 않는다.
 * Node는 {@code express.json()}이 라우트보다 먼저 돌아 깨진 JSON이 가드 이전에 500이 되는데, 그 축은
 * 계약이 관측하지 않는다(같은 계열의 기존 divergence — 경로 정책 필터의 401도 본문 판독보다 앞이다).
 *
 * <p>응답은 반드시 {@link JsonHttp}로만 쓴다(Content-Type 바이트 패리티 — MVC 메시지 컨버터 금지).
 */
@RestController
public class CollectionController {

	/** Node 라우트가 읽는 유일한 두 키. */
	private static final String SOURCE_ID = "sourceId";

	private static final String PAYLOAD = "payload";

	/** 수집 토큰 헤더 이름(소문자 — 서블릿 컨테이너의 헤더 조회는 대소문자를 가리지 않는다). */
	private static final String TOKEN_HEADER = "x-collection-token";

	/** 서버 구성상 기능 미가용 — 클라이언트 잘못이 아니다({@code spool-disabled} 503과 동형). */
	private static final String DISABLED_REASON = "collection-disabled";

	private static final String UNAUTHENTICATED_REASON = "unauthenticated";

	private final CollectionService collection;

	private final CollectionProperties properties;

	private final CollectionTokenSource tokens;

	private final LogService logs;

	private final JsonHttp json;

	public CollectionController(CollectionService collection, CollectionProperties properties,
			CollectionTokenSource tokens, LogService logs, JsonHttp json) {
		this.collection = collection;
		this.properties = properties;
		this.tokens = tokens;
		this.logs = logs;
		this.json = json;
	}

	/** 수신 인제스트 — {@code {sourceId, payload}}를 파싱해 자동기사로 등록한다. */
	@PostMapping("/api/collection/receive")
	public void receive(HttpServletRequest request, HttpServletResponse response) {
		if (denied(request, response)) {
			return;
		}
		Map<String, Object> body = this.json.readBody(request);
		Object sourceId = body.get(SOURCE_ID);
		respond(request, response, "receive", sourceId,
				this.collection.receive(sourceId, body.get(PAYLOAD)));
	}

	/** 능동 수집 — 등록된 활성 API 소스를 <b>한 번</b> 호출해 응답을 등록한다(재시도 없음). */
	@PostMapping("/api/collection/pull")
	public void pull(HttpServletRequest request, HttpServletResponse response) {
		if (denied(request, response)) {
			return;
		}
		Object sourceId = this.json.readBody(request).get(SOURCE_ID);
		respond(request, response, "pull", sourceId, this.collection.pull(sourceId));
	}

	/**
	 * 가드 — 거부했으면 응답을 쓰고 {@code true}를 돌려준다. 두 라우트가 같은 판정을 쓴다.
	 *
	 * <p>바인드 주소는 설정에서만 온다({@code server.address} 파생) — {@code InetAddress}·소켓에서
	 * 런타임 탐지하면 컨테이너·프록시 환경에서 판정이 갈린다(명시 주입이 포팅 불변식이다).
	 */
	private boolean denied(HttpServletRequest request, HttpServletResponse response) {
		String headerToken = CollectionAccess.headerToken(headerValues(request));
		CollectionAccess.Decision decision =
				CollectionAccess.decide(this.properties.host(), this.tokens.current(), headerToken);
		if (decision == CollectionAccess.Decision.DISABLED) {
			this.json.write(request, response, 503, JsonHttp.fail(DISABLED_REASON));
			return true;
		}
		if (decision == CollectionAccess.Decision.UNAUTHENTICATED) {
			this.json.write(request, response, 401, JsonHttp.fail(UNAUTHENTICATED_REASON));
			return true;
		}
		return false;
	}

	/** 같은 이름의 헤더 <b>전부</b>를 순서대로 준다(첫 값으로 접지 않는다 — Node는 합친 문자열을 본다). */
	private static List<String> headerValues(HttpServletRequest request) {
		return Collections.list(request.getHeaders(TOKEN_HEADER));
	}

	/**
	 * 결과 → 응답 + 로그. 로그는 Node 동형으로 <b>{@code sourceId}와 결과만</b> 담는다 —
	 * {@code payload}(수집 본문)와 토큰은 절대 담지 않는다(LOGS.md 마스킹: 링 버퍼는
	 * {@code GET /api/logs/digest}로 밖으로 나간다).
	 */
	private void respond(HttpServletRequest request, HttpServletResponse response, String route,
			Object sourceId, CollectionService.Result result) {
		if (result.ok()) {
			this.logs.info("collection " + route + " sourceId=" + sourceId + " ok");
			Map<String, Object> payload = JsonHttp.ok();
			payload.put("articleId", result.articleId());
			this.json.write(request, response, 200, payload);
			return;
		}
		this.logs.warn("collection " + route + " sourceId=" + sourceId + " reason=" + result.reason());
		this.json.write(request, response, ReasonStatus.of(result.reason()), JsonHttp.fail(result.reason()));
	}
}
