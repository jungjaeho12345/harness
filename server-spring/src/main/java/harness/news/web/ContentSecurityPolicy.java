package harness.news.web;

/**
 * SPA 응답에 싣는 {@code Content-Security-Policy} — <b>Node 원문 그대로</b>다(값의 단일 소유 지점).
 *
 * <h2>왜 이 phase가 이것을 붙이는가</h2>
 * Node는 helmet을 전역으로 걸어 <b>브라우저가 실행하는 문서</b>에 CSP를 싣는다({@code server/index.js}
 * 488~507행). 이 서버에는 0건이었고, 그 공백은 SPA를 서빙하지 않는 동안에는 표면이 아니었다.
 * <b>문서를 서빙하기 시작하는 순간 CSP 부재는 '원래 있던 공백'이 아니라 이 phase가 만든 표면의 회귀</b>이며,
 * 그래서 붙인다(ADR-017 결정 1 · index.json {@code excluded} (d)의 분할 재판정).
 *
 * <h2>값은 실측에서만 온다 — 소스를 읽고 조립하지 마라</h2>
 * {@code server/index.js} 494~506행이 <b>명시</b>하는 지시자는 7종이지만, helmet이 실제로 내보내는 헤더에는
 * 기본 지시자 6종이 뒤에 따라 붙어 <b>총 14종</b>이고 구분자는 공백 없는 {@code ;}다. 2026-09-05 원시 소켓
 * 실측(가짜 dist를 주입한 {@code createApp} · {@code GET /login.do}):
 * <pre>
 * Content-Security-Policy: default-src 'self';script-src 'self';img-src 'self' data: https:;connect-src 'self';
 * frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com;frame-ancestors 'self';
 * style-src 'self' 'unsafe-inline';base-uri 'self';font-src 'self' https: data:;form-action 'self';
 * object-src 'none';script-src-attr 'none';upgrade-insecure-requests
 * </pre>
 * (한 줄 · 344바이트. 위 표기는 지면 때문에 접은 것이다.) 7종만 조립하면 Node와 <b>바이트가 갈리고</b>
 * step3 대조기가 SPA 경로군에서 <b>실패 diff</b>를 낸다 — 이 축은 divergence 허용 대상이 아니다.
 *
 * <h2>붙이는 범위와 붙이지 않는 범위</h2>
 * <ul>
 * <li><b>붙인다</b>: SPA 핸들러가 응답하는 것({@code index.html} 폴백 · 정적 자산). Node도 그 응답에 싣는다.</li>
 * <li><b>붙이지 않는다</b>: {@code /api}·{@code /uploads} 응답. 나머지 보안 헤더 10종과 함께 <b>이월</b>이고
 * (index.json {@code excluded} (d) ②), 그 경계는 {@code SpaServingWireTest}가 와이어로 못 박는다 —
 * 경계를 테스트로 고정하지 않으면 다음 사람이 '반쯤 붙은 상태'를 완성된 것으로 오해한다.</li>
 * <li><b>HSTS는 넣지 않는다</b>: Node도 {@code httpsEnforced}일 때만 켠다(489~493행). 평문 HTTP LAN 배치에
 * HSTS를 보내면 <b>이후 접속이 깨진다</b>.</li>
 * </ul>
 *
 * <p><b>계약은 이 축을 보지 못한다</b> — {@code contract/lib/record.js}의 허용 헤더 목록에 보안 헤더가 없다.
 * 2026-09-05 실측(변이 M9: CSP를 아예 붙이지 않음)에서도 {@code --parity}는 <b>313관측 diffs 0</b>이었다.
 * 유일 방어선은 {@code SpaServingWireTest}·{@code SpaRealDistWireTest}다.
 */
final class ContentSecurityPolicy {

	/** 헤더 이름 — Node(helmet)가 보내는 표기 그대로다. */
	static final String HEADER = "Content-Security-Policy";

	/** Node helmet 실측 원문(344바이트 · 지시자 14종 · 구분자는 공백 없는 {@code ;}). */
	static final String NODE_ORIGINAL = "default-src 'self';script-src 'self';img-src 'self' data: https:;"
			+ "connect-src 'self';frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com;"
			+ "frame-ancestors 'self';style-src 'self' 'unsafe-inline';base-uri 'self';font-src 'self' https: data:;"
			+ "form-action 'self';object-src 'none';script-src-attr 'none';upgrade-insecure-requests";

	private ContentSecurityPolicy() {
	}
}
