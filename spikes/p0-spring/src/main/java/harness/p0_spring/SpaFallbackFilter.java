package harness.p0_spring;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * SPA 폴백 배선 (CONTRACT.md "정적 서빙 + SPA 폴백") — 규칙 판정은 SpaFallback(순수) 이 소유한다.
 * 정적 파일이 실존하면 리소스 핸들러가 서빙, "/" 는 index.html(Express static index 동형),
 * 그 외 폴백 규칙 일치 시 index.html 로 forward(FORWARD 디스패치는 이 필터를 다시 타지 않는다).
 */
@Component
public class SpaFallbackFilter extends OncePerRequestFilter {

    private final Path distDir;

    public SpaFallbackFilter(@Value("${app.spa-dir}") String spaDir) {
        this.distDir = Paths.get(spaDir).toAbsolutePath().normalize();
    }

    private boolean staticFileExists(String requestPath) {
        try {
            Path candidate = distDir.resolve(requestPath.substring(1)).normalize();
            // 경로 탐색 방지 — dist 밖 파일은 존재하지 않는 것으로 본다.
            return candidate.startsWith(distDir) && Files.isRegularFile(candidate);
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String method = req.getMethod();
        String path = req.getRequestURI();
        if (("GET".equals(method) || "HEAD".equals(method)) && path != null && !SpaFallback.isExcludedPath(path)) {
            if ("/".equals(path)) {
                req.getRequestDispatcher("/index.html").forward(req, res);
                return;
            }
            if (!staticFileExists(path) && SpaFallback.isFallbackRequest(method, path, req.getHeader("Accept"))) {
                req.getRequestDispatcher("/index.html").forward(req, res);
                return;
            }
        }
        chain.doFilter(req, res);
    }
}
