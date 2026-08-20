package harness.news.web;

import jakarta.servlet.ServletException;
import java.io.IOException;
import org.apache.catalina.connector.Request;
import org.apache.catalina.connector.Response;
import org.apache.catalina.valves.ValveBase;

/**
 * 컨테이너 응답을 요청 속성으로 노출하는 valve — {@link RawContentType}의 seam이다.
 *
 * <p>서블릿이 받는 {@code HttpServletResponse}는 파사드({@code ResponseFacade})라 내부 응답에 닿을 수
 * 없다. valve는 파사드 이전 단계에서 {@link Response} 자체를 받으므로, 여기서 요청 속성에 넣어 두면
 * <b>리플렉션 없이</b> 컨테이너 응답에 접근할 수 있다(파사드의 private 필드를 리플렉션으로 뚫는 방식보다
 * 안전하다: API가 바뀌면 컴파일이 깨지고, 조용한 폴백이 생길 자리가 없다).
 *
 * <p>이 valve는 아무것도 바꾸지 않는다 — 참조를 넘겨줄 뿐이고 헤더를 언제 쓸지는 응답 작성자가 정한다
 * (서블릿이 끝난 뒤 후처리로 헤더를 고치는 방식은 응답이 이미 커밋된 경우 조용히 실패한다).
 */
final class CoyoteResponseValve extends ValveBase {

	CoyoteResponseValve() {
		super(true); // 비동기 요청 지원 — 이 valve는 상태를 갖지 않으므로 async를 막을 이유가 없다.
	}

	@Override
	public void invoke(Request request, Response response) throws IOException, ServletException {
		request.setAttribute(RawContentType.REQUEST_ATTRIBUTE, response);
		getNext().invoke(request, response);
	}
}
