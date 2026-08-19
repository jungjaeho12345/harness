package harness.server;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 데이터 계층 배선(합성 루트) — {@link UserRepository} 를 주입된 DB 경로로 구성한다.
 * 경로 미주입이면 {@link UserRepository} 생성자가 부팅을 실패시킨다(리포 news.db 로 조용히 떨어지지 않는다).
 */
@Configuration
public class DataConfig {

    @Bean
    public UserRepository userRepository(AppConfig config) {
        return new UserRepository(config.getDbPath());
    }
}
