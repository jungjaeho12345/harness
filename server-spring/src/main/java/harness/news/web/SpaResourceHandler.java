package harness.news.web;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import org.jspecify.annotations.Nullable;
import org.springframework.context.ApplicationContext;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.servlet.resource.ResourceHttpRequestHandler;

/**
 * SPA 동일 출처 서빙 핸들러 — Node {@code server/index.js} 1219~1238행({@code express.static} + 폴백)의 동형.
 *
 * <h2>왜 {@code @RequestMapping} 컨트롤러가 아닌가</h2>
 * SPA 경로는 <b>39 라우트 인벤토리 밖</b>이다. 컨트롤러 매핑을 붙이면
 * {@code HandlerInventoryTest.everyHandlerCorrespondsToARowOfTheEndpointInventory}가 즉시 red이고, 그것을
 * 피하려고 인벤토리에 행을 더하는 것은 <b>계약 명세 수정</b>이라 금지다({@code /uploads/**} 선례 —
 * {@link WebConfig#uploadsStaticResources} javadoc). 리소스 핸들러는 {@code SimpleUrlHandlerMapping}에
 * 등록되어 {@code RequestMappingHandlerMapping.getHandlerMethods()}에 잡히지 않으므로 <b>정직하게 인벤토리
 * 밖에</b> 있다. {@code @EnableWebMvc}도 쓰지 않는다(Boot 기본 MVC가 통째로 꺼져 39 라우트가 함께 움직인다).
 *
 * <h2>세 갈래 판정</h2>
 * <ol>
 * <li><b>루트 요청</b>({@code GET /}) → {@code index.html}. {@code Accept}를 보지 <b>않는다</b> —
 * 정본은 {@code express.static}의 {@code index} 옵션이 처리하는 자리이고 {@code Accept}와 무관하다
 * (정본 B5는 {@code Accept: *&#47;*}로 200을 단언한다). 프레임워크는 매핑 안 경로가 빈 문자열이면
 * 리졸버에 닿기 전에 떨구므로({@code ResourceHandlerUtils.shouldIgnoreInputPath}) 이 갈래가 필요하다.</li>
 * <li><b>실재하는 자산</b> → 그 파일. {@code Accept} 무관(B6).</li>
 * <li><b>그 밖</b> → {@link SpaFallbackRules#isSpaFallbackRequest}가 참일 때만 {@code index.html},
 * 아니면 {@code null}이다.</li>
 * </ol>
 *
 * <p><b>{@code null}을 돌려주는 것이 핵심이다</b>: 상위가 {@code NoResourceFoundException}을 던지고
 * {@code GlobalErrorHandler} → {@code HtmlErrors.notFound}가 <b>기존 404 바이트 그대로</b>를 만든다.
 * 여기서 {@code sendError}·{@code setStatus}로 404를 직접 만들면 그 바이트가 갈리고
 * {@code RawContentType}을 거치지 않아 컨테이너가 Content-Type을 재조립한다(ADR-013 ④).
 *
 * <h2>CSP</h2>
 * {@link ContentSecurityPolicy#NODE_ORIGINAL}을 <b>이 핸들러가 응답하는 모든 요청</b>에 싣는다(200·304과
 * 이 핸들러가 낸 404까지 — Node는 helmet 전역이라 모든 응답에 싣는다). {@code /api}·{@code /uploads}는 이
 * 핸들러에 오지 않으므로({@link SpaHandlerMapping}의 게이트) 그 경계가 구조적으로 지켜진다.
 *
 * <h2>손대지 않는 것</h2>
 * 캐시·{@code ETag}·{@code Cache-Control}을 새로 켜지 않는다 — 조건부 요청 304 경로를 새로 열면 표면만
 * 넓어진다({@code /uploads}에서 이미 내린 판단).
 */
final class SpaResourceHandler extends ResourceHttpRequestHandler {

	private static final String INDEX_FILE = "index.html";

	/** 폴백 문서 — 부팅 시 한 번 만든다(요청마다 경로를 조립하지 않는다). */
	private final Resource index;

	SpaResourceHandler(Path root, ApplicationContext context) {
		String location = root.toAbsolutePath().toUri().toString();
		// 위치 문자열은 여기서 '/'로 끝맺는다: UrlResource#createRelative는 마지막 세그먼트를 파일로 보고
		// 잘라내므로 끝 슬래시가 없으면 /x가 SPA 루트의 **형제**로 해석된다(= 루트 밖 파일이 서빙된다).
		// SpaServingWireTest.theSiblingOfTheSpaRootIsNotServed가 그 변이를 잡는다.
		String directoryLocation = location.endsWith("/") ? location : location + "/";
		this.index = new FileSystemResource(root.resolve(INDEX_FILE));
		setApplicationContext(context);
		setLocationValues(List.of(directoryLocation));
		// 리졸버를 명시하는 이유는 SpaResourceResolver 참조(dotfiles · Win32 이름 별칭).
		setResourceResolvers(List.of(new SpaResourceResolver()));
		try {
			afterPropertiesSet();
		}
		catch (Exception ex) {
			// 여기까지 왔다면 index.html 존재는 이미 확인된 상태다(SpaProperties). 그래도 실패하면 배포 형상이
			// 깨진 것이므로 조용히 비활성으로 넘기지 않는다 — 경로는 메시지에 싣지 않는다.
			throw new IllegalStateException("SPA 정적 서빙 초기화 실패", ex);
		}
	}

	@Override
	public void handleRequest(HttpServletRequest request, HttpServletResponse response)
			throws ServletException, IOException {
		response.setHeader(ContentSecurityPolicy.HEADER, ContentSecurityPolicy.NODE_ORIGINAL);
		super.handleRequest(request, response);
	}

	@Override
	protected @Nullable Resource getResource(HttpServletRequest request) throws IOException {
		if (isRootRequest(request)) {
			return this.index;
		}
		Resource asset = super.getResource(request);
		if (asset != null) {
			return asset;
		}
		boolean fallback = SpaFallbackRules.isSpaFallbackRequest(request.getMethod(), request.getRequestURI(),
				request.getHeader("accept"));
		return fallback ? this.index : null;
	}

	/**
	 * 매핑 안 경로가 비었는가(= {@code GET /}). 상위는 이 경우 리졸버에 닿기 전에 {@code null}을 돌려주므로
	 * ({@code !StringUtils.hasText(path)}) 여기서 먼저 가른다. 속성이 없으면 상위가
	 * {@code IllegalStateException}(= 500)을 던지므로, 그 경우도 루트로 수렴시킨다.
	 */
	private static boolean isRootRequest(HttpServletRequest request) {
		Object within = request.getAttribute(HandlerMapping.PATH_WITHIN_HANDLER_MAPPING_ATTRIBUTE);
		if (!(within instanceof String path)) {
			return true;
		}
		return path.isBlank() || "/".equals(path);
	}
}
