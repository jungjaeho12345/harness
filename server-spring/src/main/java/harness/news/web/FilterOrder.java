package harness.news.web;

/**
 * 엣지 필터의 실행 순서 — <b>한 곳에만</b> 있는 숫자다(등록부마다 적으면 언젠가 어긋난다).
 *
 * <p>순서는 Node의 미들웨어 등록 순서와 동형이며(server/index.js), 각 경계가 "무엇보다 먼저 끝나야 하는가"로
 * 정해진다. 값 사이를 10씩 띄운 이유는 뒤 phase가 사이에 끼워 넣을 자리를 남기기 위함이다.
 *
 * <table>
 *   <caption>순서와 근거</caption>
 *   <tr><td>{@value #CORS}</td><td>CORS</td>
 *       <td>preflight(OPTIONS)는 <b>여기서 끝난다</b> — CSRF 가드·세션 판정·핸들러 매핑 어디에도 도달하지 않는다.
 *           비허용 출처 preflight가 403이 되면 계약(2xx + ACAO 부재)이 깨진다.</td></tr>
 *   <tr><td>{@value #CSRF_ORIGIN}</td><td>CSRF Origin/Referer 가드</td>
 *       <td>교차 출처 쓰기는 <b>세션을 보기 전에</b> 403이다. 뒤로 밀면 같은 요청이 401(미인증)로 응답돼
 *           사유 토큰이 바뀐다.</td></tr>
 *   <tr><td>(30)</td><td>로그인 IP 레이트리밋</td>
 *       <td><b>step7 예약 자리</b>. Node에서도 CSRF 통과 이후·라우트 진입 시점에 센다.</td></tr>
 *   <tr><td>{@value #PATH_POLICY}</td><td>경로 정책(미인증 401)</td>
 *       <td>가장 라우트에 가깝다 — Node가 라우트 <b>안에서</b> 하는 세션 검사와 같은 위치다.
 *           표에 없는 경로는 통과시켜 컨테이너 404로 흘려보낸다.</td></tr>
 * </table>
 */
final class FilterOrder {

	/** CORS(preflight 종결) — 가장 먼저. */
	static final int CORS = 10;

	/** CSRF Origin/Referer 가드 — 상태 변경 메서드만 본다. */
	static final int CSRF_ORIGIN = 20;

	/** 경로 정책(선언된 보호 경로의 미인증 401) — 디스패처 직전. */
	static final int PATH_POLICY = 40;

	private FilterOrder() {
	}
}
