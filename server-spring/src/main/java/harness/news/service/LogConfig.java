package harness.news.service;

import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 로그 계층 합성 루트 — cap과 타임존 오프셋이 <b>보이는 자리</b>다.
 *
 * <p>{@link LogService}에 애노테이션을 붙이지 않고 여기서 만드는 이유: 두 설정값이 생성자 인자라
 * 단위 테스트가 cap 3짜리 버퍼나 UTC 오프셋으로 같은 클래스를 그대로 검증할 수 있다(경계 테스트의 전제).
 * 그리고 프로덕션 값이 코드 한 줄에 모여 있어 "cap이 몇이고 창이 어느 타임존인가"를 찾아 헤맬 일이 없다
 * ({@link SessionConfig}와 같은 구성).
 */
@Configuration(proxyBeanMethods = false)
public class LogConfig {

	@Bean
	public LogService logService(Clock clock) {
		return new LogService(clock, LogService.DEFAULT_CAP, LogService.KST_OFFSET_MINUTES);
	}
}
