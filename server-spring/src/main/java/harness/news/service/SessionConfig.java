package harness.news.service;

import harness.news.model.UserRepository;
import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 세션 계층 합성 루트.
 *
 * <p>노출하는 빈은 {@link SessionGuard} <b>하나뿐</b>이다. 스토어는 이 메서드 안에서만 만들어지므로
 * 컨트롤러·필터가 주입받을 수 없다 — 스토어를 직접 잡으면 DB 재도출을 건너뛴 신원을 얻게 되고,
 * 그 우회로가 곧 ADR-004 위반이다(리포 루트 {@code src/controllers/index.js}가 raw 세션 서비스를
 * 가드로 감싼 뒤 가드만 넘기는 것과 같은 구성).
 *
 * <p>시계는 앱 전역 {@link Clock} 빈이다(decisions (14)) — 테스트는 이 빈을 고정 시계로 갈아끼워
 * 만료·슬라이딩을 결정적으로 검증한다.
 */
@Configuration(proxyBeanMethods = false)
public class SessionConfig {

	@Bean
	public SessionGuard sessionGuard(UserRepository users, Clock clock) {
		return new SessionGuard(new SessionStore(clock), users);
	}
}
