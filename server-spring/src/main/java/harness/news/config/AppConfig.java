package harness.news.config;

import java.time.Clock;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 앱 전역 빈 배선 — 설정 바인딩 활성화 + 시계 주입 seam. */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(AppProperties.class)
public class AppConfig {

	/**
	 * 시계 단일 출처. 세션 만료·계정 잠금·로그 다이제스트 창은 전부 이 빈을 주입받는다 —
	 * {@code System.currentTimeMillis()} 직접 호출은 금지다(테스트 결정성의 전제, decisions (14)).
	 * 저장 표현이 epoch ms라 시스템 UTC 시계를 쓴다.
	 */
	@Bean
	public Clock clock() {
		return Clock.systemUTC();
	}
}
