package harness.news.controller;

import harness.news.service.Identity;
import harness.news.service.SessionGuard;
import harness.news.service.UploadService;
import harness.news.web.JsonHttp;
import harness.news.web.ReasonStatus;
import harness.news.web.SessionTokens;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 파일 업로드 1라우트({@code POST /api/upload}) — 리포 루트 {@code server/index.js} 1011~1043행과 1:1이다.
 *
 * <h2>multipart가 아니라 base64 JSON이다</h2>
 * 본문은 {@code {filename, contentBase64}} 둘뿐이라 {@code MultipartResolver}·{@code MultipartFile}·
 * {@code @RequestPart}를 <b>하나도 쓰지 않는다</b>(decisions (2)). 도입하면 존재하지 않는 계약을
 * 구현하는 동시에 Content-Type 협상 표면이 새로 생긴다.
 *
 * <h2>본문 값은 {@code Object}로 그대로 넘긴다</h2>
 * {@code JsonHttp#text}로 먼저 접으면 <b>"숫자 12345"가 "키 없음"과 구분되지 않는다</b> — 둘 다
 * {@code null}이 되어 같은 사유로 뭉개진다. 정본의 판정은 {@code typeof x !== 'string'}이고 그 판정은
 * {@link UploadService}가 소유한다(계약 {@code content-not-string} 케이스가 그 자리를 관측한다).
 *
 * <h2>거부는 400 고정 · 저장 실패는 500</h2>
 * {@code invalid-file}·{@code too-large}는 Node에서도 {@code STATUS_BY_REASON}에 없고 라우트가 직접
 * {@code res.status(400)}을 쓴다(reason-tokens.md 표 2 #3·#4) — {@link ReasonStatus}를 넓히지 않는 이유는
 * 검증되지 않은 전역 표를 늘리는 것 자체가 금지돼 있기 때문이다(decisions (16)). 반대로 발급명 충돌·쓰기
 * 실패는 <b>사유가 아니라 예외</b>다: {@link IOException}을 잡아 400으로 접지 않고 그대로 올려 전역
 * 핸들러가 500 {@code internal-error}로 만든다(Node {@code flag:'wx'} 동형 · 이름 재발급 재시도는
 * ADR-008 (6) 위반이다).
 *
 * <h2>응답에 서버 파일시스템 경로가 없다</h2>
 * {@code path}는 언제나 URL 상대경로 {@code /uploads/<32hex>.<ext>}이고 {@code filename}은 요청 원문의
 * <b>반향</b>이다(대소문자 보존 · 이스케이프·정규화 금지). 저장 루트도 발급명도 이 컨트롤러가 알지
 * 못한다 — 그 둘은 {@code UploadStore}의 소유다.
 */
@RestController
public class UploadController {

	private static final String UNAUTHENTICATED = "unauthenticated";

	/** 거부 2종의 상태코드 — Node도 라우트에서 직접 쓴다(전역 사유 표를 거치지 않는다). */
	private static final int REJECTED = 400;

	/**
	 * 이 라우트 <b>하나만</b>의 요청 본문 상한 — Node {@code express.json({limit:'10mb'})}
	 * ({@code server/index.js} 1011행)의 {@code bytes('10mb')} = <b>10 MiB</b>와 같은 값·같은 부등호다
	 * (경계값 자신은 통과, 1바이트 초과부터 거부).
	 *
	 * <p><b>전역 상한을 도입하지 않는 이유</b>: 정본의 전역 파서(~100kb)를 이식하면 30여 라우트의 거부 경계가
	 * 한꺼번에 움직이는데 그 경계를 관측하는 계약이 하나도 없다 — 조용히 갈릴 축을 새로 만드는 셈이다.
	 * 여기만 막는 것으로 이 phase가 연 표면(base64 본문 = 유일하게 큰 본문을 정상적으로 받는 라우트)은 닫힌다.
	 */
	private static final long MAX_BODY_BYTES = 10L * 1024 * 1024;

	private final SessionGuard sessions;

	private final UploadService uploads;

	private final JsonHttp json;

	public UploadController(SessionGuard sessions, UploadService uploads, JsonHttp json) {
		this.sessions = sessions;
		this.uploads = uploads;
		this.json = json;
	}

	/**
	 * 업로드 한 건 — 성공 200 {@code {ok,path,filename}} · 거부 400 {@code {ok,reason}}.
	 *
	 * @throws IOException 저장 실패. <b>잡지 않는다</b>(클래스 주석 참조)
	 */
	@PostMapping("/api/upload")
	public void upload(HttpServletRequest request, HttpServletResponse response) throws IOException {
		Identity actor = actorOf(request);
		if (actor == null) {
			this.json.write(request, response, ReasonStatus.of(UNAUTHENTICATED), JsonHttp.fail(UNAUTHENTICATED));
			return;
		}

		// 상한 초과는 사유가 아니라 예외다 — 전역 핸들러가 500 internal-error로 만든다(정본과 같은 응답).
		Map<String, Object> body = this.json.readBody(request, MAX_BODY_BYTES);
		// 값은 만지지 않는다 — 문자열 여부 판정도 확장자·크기 게이트도 전부 서비스가 소유한다.
		Map<String, Object> result = this.uploads.upload(body.get("filename"), body.get("contentBase64"));
		int status = Boolean.TRUE.equals(result.get("ok")) ? 200 : REJECTED;
		this.json.write(request, response, status, result);
	}

	/** 요청의 신원 — 쿠키 우선 · {@code x-session-id} 폴백. 쿼리에서 토큰을 읽을 방법은 구조적으로 없다. */
	private Identity actorOf(HttpServletRequest request) {
		String token = SessionTokens.read(request.getHeader("cookie"),
				request.getHeader(SessionTokens.HEADER_NAME));
		return (token == null) ? null : this.sessions.touchSession(token);
	}

}
