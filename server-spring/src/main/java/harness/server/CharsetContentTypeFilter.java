package harness.server;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import java.io.IOException;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * 응답 Content-Type 에 {@code charset=utf-8} 을 싣는다(application/json·text/html). Express 가 항상
 * charset 을 싣는 것과 <b>와이어 레벨 일치</b>시키는 것이 이식 목표다(ADR-001 계약 동결). setContentType 을
 * 가로채 charset 이 없으면 붙인다.
 *
 * <p>참고: 서블릿 컨테이너는 Content-Type 을 재직렬화하며 {@code ; charset} 의 OWS 공백·charset 토큰
 * 대소문자를 정규화한다(예: {@code application/json;charset=UTF-8}). 그 HTTP 상 무의미한 바이트 차이는
 * 계약 하네스(contract-run-spring.mjs)가 compareReports 직전 대칭 정규화로 흡수한다 — 미디어 타입과
 * charset 유무/값 비교는 유지된다.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CharsetContentTypeFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        chain.doFilter(request, new CharsetResponse(response));
    }

    private static final class CharsetResponse extends HttpServletResponseWrapper {
        CharsetResponse(HttpServletResponse response) {
            super(response);
        }

        private static String withCharset(String type) {
            if (type == null) {
                return null;
            }
            String lower = type.toLowerCase();
            boolean target = lower.startsWith("application/json") || lower.startsWith("text/html");
            if (target && !lower.contains("charset")) {
                return type + "; charset=utf-8";
            }
            return type;
        }

        @Override
        public void setContentType(String type) {
            super.setContentType(withCharset(type));
        }

        @Override
        public void setHeader(String name, String value) {
            if ("Content-Type".equalsIgnoreCase(name)) {
                super.setHeader(name, withCharset(value));
            } else {
                super.setHeader(name, value);
            }
        }
    }
}
