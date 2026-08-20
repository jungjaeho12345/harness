package harness.news.controller;

import harness.news.web.JsonHttp;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 헬스체크 — 인증 불요, 항상 200 {@code {"ok":true}}.
 *
 * <p>본문 shape이 계약이다: 계약 러너와 Electron 셸 프로브가 상태코드가 아니라 본문까지 판정한다
 * (docs/api-contract/endpoints.json `health`). 키를 추가하는 것도 계약 위반이라 응답을 단일 키로 고정한다.
 *
 * <p>값을 {@code return}하지 않고 {@link JsonHttp}로 쓰는 이유: 메시지 컨버터 경로는 Content-Type을
 * 서블릿 API로 지정해 컨테이너가 헤더를 재조립한다({@code application/json} — charset 파라미터 없음).
 * 계약 리포트 diff는 헤더 문자열을 정확 비교하므로 그 순간 패리티가 깨진다. 이 라우트는 로그인 0회·
 * 부수효과 0이라 <b>그 축을 가장 싸게 잠그는 관측점</b>이다(index.json decisions (8)⑤).
 */
@RestController
public class HealthController {

	private final JsonHttp json;

	public HealthController(JsonHttp json) {
		this.json = json;
	}

	@GetMapping("/api/health")
	public void health(HttpServletRequest request, HttpServletResponse response) {
		this.json.write(request, response, 200, JsonHttp.ok());
	}
}
