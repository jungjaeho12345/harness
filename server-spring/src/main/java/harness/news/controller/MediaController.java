package harness.news.controller;

import harness.news.service.Identity;
import harness.news.service.MediaSearchService;
import harness.news.service.SessionGuard;
import harness.news.web.JsonHttp;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 미디어 검색 프록시 1라우트({@code GET /api/media/search}) — 리포 루트 {@code server/index.js}
 * 993~1002행과 1:1이다.
 *
 * <h2>컨트롤러가 하는 일은 셋뿐이다(ADR-006 · ADR-013 · index.json decisions (17))</h2>
 * <ol>
 *   <li><b>토큰 판독</b> — 쿠키 우선 · {@code x-session-id} 폴백({@link SessionTokens}).</li>
 *   <li><b>서비스 호출</b> — 키 판정 · 외부 호출 · 데모 폴백 · 시드 정규화 · 퍼센트 인코딩은 전부
 *       {@link MediaSearchService}가 소유한다. <b>여기에는 URL도 키도 없다</b>(ADR-014).</li>
 *   <li><b>shape 매핑</b> — {@code {ok:true, items, error}} <b>3키</b>를 재조립한다.</li>
 * </ol>
 *
 * <h2>서비스 결과를 그대로 싣지 않는다</h2>
 * 정본이 {@code res.json({ ok: true, items: r.items, error: r.error })}로 <b>골라 싣기</b> 때문이다 —
 * 서비스가 진단 플래그를 하나 더 돌려주기 시작해도 응답 키 집합은 3종으로 고정된다(계약이
 * {@code Object.keys(res.json).sort()}로 그 3종을 동결한다).
 *
 * <h2>반복 쿼리 키는 값 리스트 그대로 넘긴다(decisions (14))</h2>
 * express(qs)는 {@code ?type=image&type=video}를 <b>배열</b>로 주고 정본은 {@code type === 'image'}
 * 엄격 비교라 그 요청은 <b>video</b>다. 첫 값으로 접으면({@code getParameter}의 기본 동작) 같은 URL에
 * 두 서버가 다른 본문을 준다. {@code q}도 마찬가지로 배열이면 콤마 결합 문자열이 시드가 된다 —
 * 접는 규칙은 {@code NodeString.queryText} 단일 출처이며 <b>서비스가</b> 적용한다.
 *
 * <p>{@code error}는 사유 토큰이 아니라 <b>불리언 플래그</b>다 — 외부 호출이 실패해도 상태코드는 200이고
 * {@code ok}는 {@code true}다(정본 그대로).
 */
@RestController
public class MediaController {

	private final SessionGuard sessions;

	private final MediaSearchService media;

	private final JsonHttp json;

	public MediaController(SessionGuard sessions, MediaSearchService media, JsonHttp json) {
		this.sessions = sessions;
		this.media = media;
		this.json = json;
	}

	/**
	 * 이미지·영상 검색 1회 — 키가 없는 서버에서는 외부 호출 없이 결정적 데모 폴백이고 <b>그래도 200</b>이다.
	 *
	 * <p>{@code q}가 없으면 {@code null}을 그대로 넘긴다: 정본의 {@code req.query.q ?? ''}와 같은 값이
	 * 되도록 접는 것은 서비스의 {@code NodeString.queryText}이고(부재 → 빈 문자열), 그 규칙이 두 곳에
	 * 있으면 한쪽이 드리프트한다.
	 */
	@GetMapping("/api/media/search")
	public void search(HttpServletRequest request, HttpServletResponse response) {
		Identity actor = actorOf(request);
		if (actor == null) {
			this.json.write(request, response, ReasonStatus.of("unauthenticated"),
					JsonHttp.fail("unauthenticated"));
			return;
		}

		Map<String, Object> result = this.media.search(queryValues(request, "q"), queryValues(request, "type"));
		Map<String, Object> payload = JsonHttp.ok();
		payload.put("items", result.get("items"));
		payload.put("error", result.get("error"));
		this.json.write(request, response, 200, payload);
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
