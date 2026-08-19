package harness.server;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 세션 계층 배선 — {@link SessionStore} 를 실제 시계(System.currentTimeMillis)로 구성한다.
 * 테스트는 SessionStore 를 주입 시계로 직접 생성해 만료·재도출을 결정적으로 검증한다.
 */
@Configuration
public class SessionConfig {

    @Bean
    public SessionStore sessionStore(UserRepository users) {
        return new SessionStore(users, System::currentTimeMillis);
    }
}
