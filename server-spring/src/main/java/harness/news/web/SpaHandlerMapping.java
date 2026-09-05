package harness.news.web;

import jakarta.servlet.http.HttpServletRequest;
import java.nio.file.Path;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.springframework.context.ApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.web.servlet.handler.SimpleUrlHandlerMapping;

/**
 * SPA 핸들러의 매핑 — <b>이 요청을 SPA가 맡는가</b>를 판정하는 유일한 지점이다.
 *
 * <h2>왜 별도 매핑인가(등록 순서가 계약이다)</h2>
 * Boot의 리소스 핸들러 매핑에는 이미 {@code /uploads/**}와 Boot 기본 {@code /**}가 있다. 거기에 {@code /**}를
 * 한 벌 더 등록하면 <b>같은 키를 덮어써</b> 순서가 프레임워크 내부 규칙에 맡겨진다. 대신 우선순위가 한 칸
 * 앞선({@link Ordered#LOWEST_PRECEDENCE} - 2) 매핑을 따로 두고, <b>SPA가 맡지 않기로 한 요청에는
 * {@code null}을 돌려준다</b> — 그러면 요청은 <b>기존 경로 그대로</b> 다음 매핑으로 흘러간다:
 * <ul>
 * <li>{@code /uploads/**} → 기존 정적 서빙(그대로)</li>
 * <li>미정의 {@code /api} 경로 → Boot 기본 {@code /**} → {@code NoResourceFoundException} →
 * {@code GlobalErrorHandler} → {@code HtmlErrors.notFound}(404 바이트 <b>무변</b>)</li>
 * <li>비-GET/HEAD → 위와 같다(SPA는 쓰기 요청을 맡지 않는다)</li>
 * </ul>
 * {@code RequestMappingHandlerMapping}(order 0)이 언제나 먼저이므로 <b>39 라우트는 구조적으로 가려지지
 * 않는다</b>. 이 매핑은 {@code SimpleUrlHandlerMapping}이라 {@code HandlerInventoryTest}가 보는
 * {@code RequestMappingHandlerMapping.getHandlerMethods()}에 잡히지 않는다(인벤토리 밖).
 *
 * <h2>비활성이면 아무것도 등록하지 않는다</h2>
 * {@link #disabled()}는 빈 {@code urlMap}이다 — 핸들러가 하나도 없으므로 어떤 요청도 여기서 멈추지 않는다.
 * 등록해 두고 런타임에 분기하면 404 경로가 두 갈래가 된다(그러면 "비활성일 때 이전과 완전히 같다"를
 * 더 이상 구조로 말할 수 없다).
 *
 * <p>경로 판정은 {@code request.getRequestURI()}(요청줄 원문)를 쓴다 — {@link RoutePolicy}·
 * {@link PathPolicyFilter}가 쓰는 값과 같고, Express {@code req.path}와 같은 자리다.
 */
final class SpaHandlerMapping extends SimpleUrlHandlerMapping {

	/**
	 * Boot 리소스 핸들러 매핑({@code LOWEST_PRECEDENCE - 1})보다 <b>한 칸 앞</b>이다. 뒤에 두면 Boot 기본
	 * {@code /**}가 먼저 잡아 SPA 폴백이 영원히 불리지 않는다.
	 */
	private static final int ORDER = Ordered.LOWEST_PRECEDENCE - 2;

	private SpaHandlerMapping(Map<String, Object> urlMap) {
		setOrder(ORDER);
		setUrlMap(urlMap);
	}

	/** SPA 비활성 — 등록된 핸들러가 0개다. */
	static SpaHandlerMapping disabled() {
		return new SpaHandlerMapping(Map.of());
	}

	/** SPA 활성 — 루트와 그 하위 전부를 하나의 리소스 핸들러가 맡는다. */
	static SpaHandlerMapping serving(Path root, ApplicationContext context) {
		return new SpaHandlerMapping(Map.of("/**", new SpaResourceHandler(root, context)));
	}

	@Override
	protected @Nullable Object getHandlerInternal(HttpServletRequest request) throws Exception {
		if (!SpaFallbackRules.isCandidate(request.getMethod(), request.getRequestURI())) {
			return null;
		}
		return super.getHandlerInternal(request);
	}
}
