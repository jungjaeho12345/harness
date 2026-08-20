package harness.news.web;

import harness.news.config.AppProperties;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * transport 계층 배선.
 *
 * <p>여기가 <b>프로덕션 분기 판정의 유일한 지점</b>이다: 컨트롤러는 어느 환경인지 묻지 않고 이미 만들어진
 * 쿠키 조립기를 받는다(각 라우트가 환경을 판정하기 시작하면 한 곳만 빠뜨려도 프로덕션에서 Secure 없는
 * 쿠키가 나간다).
 */
@Configuration(proxyBeanMethods = false)
public class WebConfig {

	/**
	 * Content-Type 바이트 기록 seam 등록 — 자세한 근거는 {@link RawContentType}.
	 * valve가 없으면 JSON 응답이 첫 요청부터 500으로 실패한다(조용한 헤더 오차보다 낫다).
	 */
	@Bean
	public WebServerFactoryCustomizer<TomcatServletWebServerFactory> coyoteResponseSeam() {
		return factory -> factory.addContextValves(new CoyoteResponseValve());
	}

	/** 세션 쿠키 조립기 — dev/prod 두 변형 중 하나로 고정해서 만든다. */
	@Bean
	public SessionCookies sessionCookies(AppProperties properties) {
		return new SessionCookies(properties.production());
	}
}
