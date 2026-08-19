package harness.spring_auth;

import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * Content-Type 헤더를 **바이트 정확히** 지정하는 유일한 지점(패리티 shim).
 *
 * 왜 필요한가: Node express는 'application/json; charset=utf-8'처럼 세미콜론 뒤에 **공백**을 넣어 보낸다.
 *   그런데 서블릿 컨테이너(Tomcat/Jetty 공통)의 setContentType/setHeader는 content-type을 파싱해
 *   'application/json;charset=utf-8'(공백 없음)으로 재조립한다 — 계약 리포트가 이 헤더를 값으로 비교하므로
 *   그 1바이트 차이가 contract-diff를 깨뜨린다. 어떤 서블릿 API 경로로도 공백을 복원할 수 없다(실측).
 *
 * 해결: Tomcat coyote Response의 MimeHeaders에 Content-Type을 **직접** 써 넣는다. 이때 서블릿
 *   setContentType은 호출하지 않으므로 coyote.getContentType()==null이 되어 커밋 시 Tomcat이 이 값을
 *   덮어쓰지 않는다(재조립 우회). ResponseFacade의 내부 필드 접근이라 reflection을 쓴다 — 컨테이너가
 *   Tomcat이 아니거나(예: MockMvc) 구조가 다르면 조용히 setContentType 폴백한다(기능은 유지, 이 경우
 *   바이트 패리티만 포기 — 통합 판정은 실제 Tomcat 대상 계약 스위트가 한다).
 * 리플렉션 핸들은 최초 1회 해석 후 캐시한다.
 */
final class ResponseContentType {

	private static volatile Field facadeResponseField;
	private static volatile Method getCoyoteResponse;
	private static volatile Method getMimeHeaders;
	private static volatile Method setValue;
	private static volatile boolean fallbackOnly;

	private ResponseContentType() {
	}

	static void set(HttpServletResponse res, String contentType) {
		if (!fallbackOnly && trySetViaCoyote(res, contentType)) {
			return;
		}
		// 폴백 — Tomcat이 아니거나 리플렉션 실패. 컨테이너가 정규화할 수 있으나 기능은 유지된다.
		res.setContentType(contentType);
	}

	private static boolean trySetViaCoyote(HttpServletResponse res, String contentType) {
		try {
			HttpServletResponse raw = res;
			while (raw instanceof HttpServletResponseWrapper w) {
				raw = (HttpServletResponse) w.getResponse();
			}
			Field field = facadeResponseField;
			if (field == null || !field.getDeclaringClass().isInstance(raw)) {
				field = raw.getClass().getDeclaredField("response");
				field.setAccessible(true);
				facadeResponseField = field;
			}
			Object connResp = field.get(raw);
			Method coyoteM = getCoyoteResponse;
			if (coyoteM == null || !coyoteM.getDeclaringClass().isInstance(connResp)) {
				coyoteM = connResp.getClass().getMethod("getCoyoteResponse");
				getCoyoteResponse = coyoteM;
			}
			Object coyote = coyoteM.invoke(connResp);
			Method mimeM = getMimeHeaders;
			if (mimeM == null || !mimeM.getDeclaringClass().isInstance(coyote)) {
				mimeM = coyote.getClass().getMethod("getMimeHeaders");
				getMimeHeaders = mimeM;
			}
			Object mime = mimeM.invoke(coyote);
			Method setValueM = setValue;
			if (setValueM == null || !setValueM.getDeclaringClass().isInstance(mime)) {
				setValueM = mime.getClass().getMethod("setValue", String.class);
				setValue = setValueM;
			}
			Object messageBytes = setValueM.invoke(mime, "Content-Type");
			messageBytes.getClass().getMethod("setString", String.class).invoke(messageBytes, contentType);
			return true;
		} catch (Exception e) {
			// 이 런타임에서는 coyote 경로가 불가 — 이후로는 폴백만 쓴다(요청마다 실패 재시도 방지).
			fallbackOnly = true;
			return false;
		}
	}
}
