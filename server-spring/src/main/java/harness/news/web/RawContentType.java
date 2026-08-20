package harness.news.web;

import org.apache.catalina.connector.Response;

/**
 * Content-Type 헤더를 <b>바이트 그대로</b> 지정하는 유일한 지점.
 *
 * <h2>왜 서블릿 API를 쓰지 않는가(실측)</h2>
 * Node(express {@code res.json})는 {@code application/json; charset=utf-8}을 보낸다. 그런데 서블릿 API로는
 * 그 문자열을 그대로 내보낼 수 없다:
 * <ul>
 *   <li>{@code response.setContentType(...)}·{@code setHeader("Content-Type", ...)}는 둘 다 컨테이너의
 *       {@code Response#setContentType}으로 흘러 미디어 타입을 <b>파싱</b>하고, 커밋 시점에
 *       {@code org.apache.coyote.Response#getContentType()}이 {@code 타입 + ";charset=" + 인코딩명}으로
 *       <b>재조립</b>한다 — 세미콜론 뒤 공백이 사라진다({@code application/json;charset=utf-8}).</li>
 *   <li>아무것도 지정하지 않으면 charset 파라미터 자체가 없다({@code application/json} — step0 실측).</li>
 * </ul>
 * 계약 리포트 diff는 이 헤더를 <b>문자열로 정확 비교</b>하므로(scripts/contract-diff.mjs) 공백 1바이트가
 * 전 관측을 red로 만든다. 기능 테스트는 이 차이를 통과시킨다(거짓 green) — 그래서 별도의 잠금이 필요하다.
 *
 * <h2>해법</h2>
 * 서블릿 API를 건너뛰고 coyote 응답에 {@code setContentTypeNoCharset}으로 <b>완성된 문자열</b>을 넣는다.
 * 인코딩(charset)은 설정하지 않으므로 {@code getContentType()}이 문자열을 덧붙이지 않고 그대로 내보낸다
 * (본문은 이미 UTF-8 바이트로 직접 쓴다). coyote 응답 참조는 {@link CoyoteResponseValve}가 요청 속성으로
 * 넘겨준다 — <b>리플렉션이 없다</b>(컨테이너 API가 바뀌면 런타임이 아니라 컴파일이 깨진다).
 *
 * <h2>폴백이 없는 이유</h2>
 * seam이 없으면 {@code setContentType}으로 조용히 되돌아가는 대신 <b>예외를 던진다</b>. 조용한 폴백은
 * "기능은 정상인데 전 관측의 패리티가 깨진" 상태를 만들고, 그 상태는 계약 스위트를 돌리기 전까지 보이지
 * 않는다(흡수 검토한 클라우드 구현의 실제 형태 — index.json decisions (18)). 시끄러운 실패는 첫 요청에서
 * 500으로 드러난다. {@code RawContentTypeTest}가 이 규율을 잠근다.
 */
final class RawContentType {

	/** {@link CoyoteResponseValve}가 컨테이너 응답을 넣어 두는 요청 속성 이름. */
	static final String REQUEST_ATTRIBUTE = "harness.news.web.containerResponse";

	private RawContentType() {
	}

	/**
	 * 컨테이너 응답에 Content-Type 문자열을 그대로 기록한다.
	 *
	 * @param seam 요청 속성 {@link #REQUEST_ATTRIBUTE}의 값
	 * @param contentType 와이어에 나갈 문자열 원문
	 * @throws IllegalStateException seam이 없거나 Tomcat 응답이 아닐 때(폴백하지 않는다)
	 */
	static void set(Object seam, String contentType) {
		if (!(seam instanceof Response response)) {
			throw new IllegalStateException("Content-Type 바이트 기록 경로가 없다: 요청 속성 "
					+ REQUEST_ATTRIBUTE + " 가 Tomcat 응답이 아니다(값=" + describe(seam) + "). "
					+ "CoyoteResponseValve 가 등록되지 않았거나 컨테이너가 Tomcat이 아니다 — "
					+ "여기서 서블릿 API로 폴백하면 Node와 헤더가 1바이트 어긋난 채 조용히 통과한다.");
		}
		response.getCoyoteResponse().setContentTypeNoCharset(contentType);
	}

	private static String describe(Object seam) {
		return (seam == null) ? "없음" : seam.getClass().getName();
	}
}
