package harness.server;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 도메인 계층 배선 — 실제 시계(System.currentTimeMillis)로 서비스/레이트리밋을 구성한다.
 * 테스트는 주입 시계로 직접 생성해 잠금·레이트리밋 창을 결정적으로 검증한다.
 */
@Configuration
public class DomainConfig {

    @Bean
    public UserService userService(UserRepository users) {
        return new UserService(users, System::currentTimeMillis);
    }

    @Bean
    public LoginRateLimiter loginRateLimiter() {
        return new LoginRateLimiter(System::currentTimeMillis);
    }
}
