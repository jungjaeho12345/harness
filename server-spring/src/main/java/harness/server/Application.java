package harness.server;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

/**
 * 기사 작성기 Spring WAS 서버 — 포팅 로드맵 P1(auth/session 도메인 묶음, phase 68).
 *
 * <p>신뢰 경계는 서버(ADR-004): acting 신원은 검증된 세션에서만 도출하고, 클라이언트가 보낸
 * role/body 는 신뢰하지 않는다. DB 는 비파괴(행 삭제 0, soft delete 만) — 이 서버는 DDL/DELETE 를
 * 실행하지 않는다.
 *
 * <p>Spring Security auto-config 는 클래스패스에 두지 않는다(starter-security 미도입) — BCrypt 는
 * spring-security-crypto 로만 쓴다. CORS/CSRF Origin 가드/CSP/HTTPS 강제/전역 레이트리밋은 넣지 않는다
 * (동일 출처 배치에서 no-op 이며 어설픈 재현이 로그인 POST 를 403 시킨다). /api/login 전용 레이트리밋만 둔다.
 */
@SpringBootApplication
@EnableConfigurationProperties(AppConfig.class)
public class Application {

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
