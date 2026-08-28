package harness.news.controller;

import harness.news.service.Identity;
import harness.news.service.PhotoService;
import harness.news.service.SessionGuard;
import harness.news.web.JsonHttp;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 사진DB 2라우트({@code POST /api/photos} 등록 · {@code GET /api/photos/search} 캡션 검색) — 리포 루트
 * {@code server/index.js} 1048~1065행과 1:1이다.
 *
 * <h2>신뢰 경계(ADR-004) — 본문의 {@code registeredBy}는 읽지 않는다</h2>
 * 등록 핸들러가 본문에서 꺼내는 값은 {@code src}·{@code caption}·{@code sourceArticleId} <b>셋뿐</b>이고
 * (정본의 구조분해와 같다) 신원은 <b>검증된 세션에서 재도출한 {@code userId}</b>를 마지막 인자로만
 * 넘긴다. {@link PhotoService}가 본문 맵을 통째로 받는 API를 노출하지 않는 것과 짝이다 — 위조 통로는
 * 있기만 해도 위조 경로다. 응답은 {@code {ok,id}}뿐이라 이 축은 <b>되읽기로만</b> 관측된다.
 *
 * <h2>거부는 400 고정</h2>
 * {@code invalid-src}는 Node에서도 {@code STATUS_BY_REASON}에 없고 라우트가 직접 400을 쓴다
 * (reason-tokens.md 표 2 #5) — {@link ReasonStatus}는 이 phase에서 무접촉이다(decisions (16)).
 * 거부된 등록은 <b>행을 만들지 않는다</b>(이 테이블은 append-only다).
 *
 * <h2>반복 쿼리 키는 값 리스트 그대로 넘긴다(decisions (14))</h2>
 * express(qs)의 {@code ?q=a&q=b}는 <b>배열</b>이고 정본은 그것을 {@code `%${q}%`} 템플릿에 넣는다
 * ({@code LIKE '%a,b%'}). 첫 값으로 접으면 같은 URL에 두 서버가 다른 행 집합을 준다 — 접는 규칙은
 * {@code NodeString.queryText} 단일 출처이며 <b>서비스가</b> 적용한다.
 *
 * <p>검색 결과 행은 서비스가 준 <b>Photo 스키마 6컬럼 그대로</b> 싣는다(현행 계약 — 투영이 없다).
 */
@RestController
public class PhotosController {

	private static final String UNAUTHENTICATED = "unauthenticated";

	/** 거부 사유의 상태코드 — Node도 라우트에서 직접 쓴다(전역 사유 표를 거치지 않는다). */
	private static final int REJECTED = 400;

	private final SessionGuard sessions;

	private final PhotoService photos;

	private final JsonHttp json;

	public PhotosController(SessionGuard sessions, PhotoService photos, JsonHttp json) {
		this.sessions = sessions;
		this.photos = photos;
		this.json = json;
	}

	/**
	 * 사진 1건 등록(append-only) — 성공 200 {@code {ok,id}} · 거부 400 {@code {ok,reason:"invalid-src"}}.
	 *
	 * <p>본문 값은 만지지 않는다: {@code src} 검증({@code FileRef})도 {@code ?? ''} 기본값도 시각
	 * stamp도 전부 서비스가 소유한다.
	 */
	@PostMapping("/api/photos")
	public void create(HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response);
			return;
		}

		Map<String, Object> body = this.json.readBody(request);
		// 본문에서 꺼내는 것은 셋뿐이다 — registeredBy는 여기서 읽지 않는다(ADR-004).
		Map<String, Object> result = this.photos.register(body.get("src"), body.get("caption"),
				body.get("sourceArticleId"), actor.userId());
		int status = Boolean.TRUE.equals(result.get("ok")) ? 200 : REJECTED;
		this.json.write(request, response, status, result);
	}

	/**
	 * 캡션 부분일치 검색 — 200 {@code {ok:true, items}}. 빈 질의는 필터하지 않는다({@code LIKE '%%'})이며
	 * 거부가 아니다.
	 *
	 * <p>{@code q}가 없으면 {@code null}을 그대로 넘긴다: 정본의 {@code req.query.q ?? ''}와 같은 값이
	 * 되도록 접는 것은 서비스의 {@code NodeString.queryText}이고, 그 규칙이 두 곳에 있으면 한쪽이
	 * 드리프트한다.
	 */
	@GetMapping("/api/photos/search")
	public void search(HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			deny(request, response);
			return;
		}

		Map<String, Object> payload = JsonHttp.ok();
		payload.put("items", this.photos.search(queryValues(request, "q")));
		this.json.write(request, response, 200, payload);
	}

	private void deny(HttpServletRequest request, HttpServletResponse response) {
		this.json.write(request, response, ReasonStatus.of(UNAUTHENTICATED), JsonHttp.fail(UNAUTHENTICATED));
	}

	/**
	 * 반복 쿼리 키를 <b>express(qs)와 같은 모양</b>으로 준다: 한 번 온 키는 문자열, 반복된 키는 값 리스트,
	 * 없으면 {@code null}(= JS의 {@code undefined})이다.
	 *
	 * <p>{@code getParameterValues}로 읽는다 — {@code getParameter(}는 {@code ?session=} 폴백 부활을 막는
	 * 정적 스캔({@code WebWiringTest})이 금지한 API이고 첫 값으로 접으면 의미가 갈린다.
	 */
	private static Object queryValues(HttpServletRequest request, String name) {
		String[] values = request.getParameterValues(name);
		if (values == null || values.length == 0) {
			return null;
		}
		return (values.length == 1) ? values[0] : List.of(values);
	}

	/** 요청의 신원 — 쿠키 우선 · {@code x-session-id} 폴백. 쿼리에서 토큰을 읽을 방법은 구조적으로 없다. */
	private Identity actorOf(HttpServletRequest request) {
		String token = SessionTokens.read(request.getHeader("cookie"),
				request.getHeader(SessionTokens.HEADER_NAME));
		return (token == null) ? null : this.sessions.touchSession(token);
	}

}
