package harness.news.web;

import harness.news.config.AppProperties;
import harness.news.config.SpaProperties;
import harness.news.service.LogService;
import harness.news.service.SessionGuard;
import jakarta.servlet.Filter;
import java.time.Clock;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

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

	/**
	 * 업로드 파일 정적 서빙({@code GET /uploads/<32hex>.<ext>}) — Node {@code server/index.js} 562행
	 * {@code app.use('/uploads', express.static(uploadDir))}와 같은 자리다.
	 *
	 * <h2>왜 {@code @RequestMapping} 핸들러가 아닌가</h2>
	 * {@code /uploads/**}는 <b>39 라우트 인벤토리 밖</b>이다. 컨트롤러 매핑을 붙이면
	 * {@code HandlerInventoryTest.everyHandlerCorrespondsToARowOfTheEndpointInventory}가 "인벤토리에 없는
	 * 경로에 핸들러가 붙었다"로 즉시 red를 낸다(그 게이트를 우회하려고 인벤토리에 행을 추가하는 것은 계약
	 * 명세 수정이라 금지다). 리소스 핸들러는 {@code SimpleUrlHandlerMapping}에 등록되어
	 * {@code RequestMappingHandlerMapping.getHandlerMethods()}에 잡히지 않으므로 <b>정직하게 인벤토리 밖에</b>
	 * 있다. Boot 기본 {@code /**} 핸들러보다 구체적인 패턴이라 이쪽이 먼저 잡힌다.
	 *
	 * <h2>미인증 200이 계약이다</h2>
	 * Node의 마운트는 <b>세션 게이트보다 앞</b>이고 비밀은 32-hex 파일명뿐인 <b>capability URL 모델</b>이다.
	 * {@code RoutePolicy}에 {@code /uploads} 행을 추가해 세션을 요구하면 발행 HTML에 재임베드된 이미지가
	 * 외부에서 깨진다(계약 파일이 CRITICAL로 명시한 축 · {@code UploadsStaticWireTest}가 잠근다).
	 *
	 * <h2>경로 규율</h2>
	 * 루트는 {@link AppProperties#uploadsDirPath()} <b>한 지점</b>에서 온다(저장측 {@code UploadStore}와
	 * 같은 지점 — 갈리면 업로드는 성공하는데 서빙은 404다). 위치 문자열은 <b>여기서</b> {@code /}로 끝맺는다:
	 * {@code UrlResource#createRelative}는 마지막 세그먼트를 파일로 보고 잘라내므로 끝 슬래시가 없으면
	 * {@code /uploads/x}가 uploads의 <b>형제</b>로 해석된다. (2026-08-28 실측: 이 버전의
	 * {@code ResourceHandlerUtils}는 끝 슬래시가 없으면 WARN 로그와 함께 스스로 붙인다 — 그 상류 보정에
	 * 기대지 않고 우리가 못 박는다. 반대로 위치를 <b>부모 디렉토리</b>로 잘못 도출하면 형제 파일이 실제로
	 * 서빙된다 — {@code UploadsStaticWireTest.theSiblingOfTheUploadsRootIsNotServed}가 그 변이를 잡는다.)
	 * 경로 탈출은 기본 {@code PathResourceResolver}가 위치 밖 리소스를 거부해 막고, 그 사실은 와이어
	 * 테스트가 요청줄 원문으로 확인한다(인코딩·이중 인코딩·백슬래시 변형 9종).
	 *
	 * <p>{@code @EnableWebMvc}는 쓰지 않는다(Boot 기본 MVC 설정이 통째로 꺼져 기존 39 라우트가 함께 움직인다).
	 * 캐시·ETag·{@code Cache-Control}도 손대지 않는다 — 계약 리포트가 싣지 않는 헤더이고 조건부 요청 304
	 * 경로를 새로 열면 표면만 넓어진다(index.json open_questions (4)).
	 */
	@Bean
	public WebMvcConfigurer uploadsStaticResources(AppProperties properties) {
		String location = properties.uploadsDirPath().toAbsolutePath().toUri().toString();
		// toUri()는 "존재하는 디렉토리"일 때만 끝 슬래시를 붙인다 — uploads 루트는 lazy mkdir이라 부팅
		// 시점엔 대개 없다. 존재 여부에 따라 서빙 범위가 달라지면 안 되므로 여기서 못 박는다.
		String directoryLocation = location.endsWith("/") ? location : location + "/";
		return new WebMvcConfigurer() {
			@Override
			public void addResourceHandlers(ResourceHandlerRegistry registry) {
				// 리졸버를 명시하는 이유는 UploadsResourceResolver 참조(Win32 이름 별칭 = 정본에 없는 200).
				// 캐시는 켜지 않는다(resourceChain(false)) — 조건부 요청·캐시 헤더 표면을 새로 열지 않는다.
				registry.addResourceHandler("/uploads/**")
						.addResourceLocations(directoryLocation)
						.resourceChain(false)
						.addResolver(new UploadsResourceResolver());
			}
		};
	}

	/**
	 * SPA 동일 출처 서빙({@code GET /} · {@code /assets/**} · {@code .do} 폴백) — Node
	 * {@code server/index.js} 1219~1238행과 같은 자리다(ADR-017 결정 1).
	 *
	 * <h2>활성 판정은 여기서 <b>한 번</b> 한다</h2>
	 * {@link SpaProperties#spaRootPath()}는 {@code <dir>/index.html} <b>파일</b>을 본다(디렉토리가 아니다 —
	 * 파일이 없는데 폴백을 켜면 404가 500으로 뒤집힌다). 요청마다 stat 하지 않는다: 부트 이후 dist를
	 * 새로 빌드했다면 재기동해야 반영된다(Node도 같다 — 개발 흐름은 Vite :5173이라 실사용 영향이 없다).
	 *
	 * <p><b>미설정이 기본(비활성)</b>이고 그때는 핸들러를 하나도 등록하지 않으므로 런타임 동작이 이 step
	 * 이전과 완전히 같다. 계약 하네스는 {@code SPA_DIR}을 자식에게 넘기지 않으므로 313관측 × 2축이 바로 그
	 * 상태로 돈다({@link SpaProperties} javadoc).
	 *
	 * <p>부팅 로그는 <b>활성일 때만</b> INFO 1줄이다(Node 1354행과 같은 자리·같은 문구). 대부분의 부트는
	 * 비활성이라 매번 남기면 링 버퍼 소음이 된다. 경로는 비밀이 아니다(Node 주석).
	 */
	@Bean
	public SpaHandlerMapping spaHandlerMapping(SpaProperties properties, ApplicationContext context, LogService logs) {
		return properties.spaRootPath()
				.map((root) -> {
					logs.info("serving SPA from " + root);
					return SpaHandlerMapping.serving(root, context);
				})
				.orElseGet(SpaHandlerMapping::disabled);
	}

	/** 세션 쿠키 조립기 — dev/prod 두 변형 중 하나로 고정해서 만든다. */
	@Bean
	public SessionCookies sessionCookies(AppProperties properties) {
		return new SessionCookies(properties.production());
	}

	/**
	 * CORS와 CSRF 가드가 공유하는 허용 출처 목록(ADR-009) — 두 경계가 각자 목록을 들면 한쪽만 넓어졌을 때
	 * 조용히 뚫린다.
	 */
	@Bean
	public AllowedOrigins allowedOrigins(AppProperties properties) {
		return AllowedOrigins.of(properties);
	}

	/**
	 * 엣지 필터 등록 — 순서는 {@link FilterOrder} 한 곳에서만 정한다.
	 * 필터는 빈이 아니라 여기서 직접 만든다(빈으로 두면 Boot가 자동 등록해 순서·중복 등록이 갈라진다).
	 */
	@Bean
	public FilterRegistrationBean<Filter> corsFilter(AllowedOrigins origins) {
		return register(new CorsFilter(origins), FilterOrder.CORS);
	}

	/**
	 * 액세스 로그 — 링 버퍼는 {@link LogService} 빈 하나(프로세스 로컬 in-memory)이며
	 * {@code GET /api/logs/digest}가 같은 버퍼를 읽는다.
	 */
	@Bean
	public FilterRegistrationBean<Filter> requestLogFilter(LogService logs, Clock clock) {
		return register(new RequestLogFilter(logs, clock), FilterOrder.REQUEST_LOG);
	}

	@Bean
	public FilterRegistrationBean<Filter> csrfOriginFilter(AllowedOrigins origins, JsonHttp json) {
		return register(new CsrfOriginFilter(origins, json), FilterOrder.CSRF_ORIGIN);
	}

	/**
	 * 로그인 IP 레이트리밋 — 카운터는 이 빈 하나(프로세스 로컬 in-memory)다. 시각은 주입된 시계에서만 읽는다.
	 */
	@Bean
	public FilterRegistrationBean<Filter> loginRateLimitFilter(Clock clock) {
		return register(new LoginRateLimitFilter(new LoginRateLimit(clock)), FilterOrder.LOGIN_RATE_LIMIT);
	}

	@Bean
	public FilterRegistrationBean<Filter> pathPolicyFilter(SessionGuard sessions, JsonHttp json) {
		return register(new PathPolicyFilter(sessions, json), FilterOrder.PATH_POLICY);
	}

	private static FilterRegistrationBean<Filter> register(Filter filter, int order) {
		FilterRegistrationBean<Filter> registration = new FilterRegistrationBean<>(filter);
		registration.addUrlPatterns("/*");
		registration.setOrder(order);
		return registration;
	}
}
