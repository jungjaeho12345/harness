package harness.news.web;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import org.jspecify.annotations.Nullable;
import org.springframework.context.ApplicationContext;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
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
 * <h2>Content-Type은 Node 원문이다(phase 76 step3 대조기의 발견)</h2>
 * 프레임워크는 컨테이너의 확장자 표로 {@code text/html}·{@code text/javascript}를 서블릿 API에 넣고, 컨테이너는
 * 그것을 재조립한다 — Node({@code send})는 {@code text/html; charset=UTF-8}·{@code application/javascript;
 * charset=UTF-8}을 보내므로 SPA 200 응답 전부가 갈렸다(2026-09-07 실측). 값은 {@link SpaContentTypes}가
 * Node 규칙으로 만들고, 기록은 {@link RawContentType} seam 을 지난다: {@link #setHeaders}가 리소스의 파일
 * 이름으로 값을 <b>고정(pin)</b>하고, 그 뒤 프레임워크가 서블릿 API로 하는 모든 Content-Type 지정
 * ({@code setContentType}·{@code setHeader}·{@code addHeader} — 메시지 컨버터가 헤더를 한 번 더 쓴다)은
 * {@link NodeContentTypeResponse}가 가로채 고정값을 다시 seam 으로 쓴다. 고정 전에 지정이 오면 <b>던진다</b>
 * (조용한 폴백은 "기능은 정상인데 패리티가 깨진" 상태를 만든다 — {@link RawContentType}과 같은 규율).
 * 잠금은 {@code SpaServingWireTest.contentTypeLinesAreNodeOriginal}·{@code SpaRealDistWireTest}다.
 * <b>예외는 하나</b>다: 다중 {@code Range} 응답의 {@code multipart/byteranges}는 되돌리지 않는다 — 고정은 파일
 * <b>타입</b>을 Node 원문으로 맞추는 것이지 컨버터가 정한 본문 <b>형식</b>을 덮는 것이 아니다
 * ({@code SpaServingWireTest.aRangeRequestKeepsTheContentTypeHonest}).
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
		super.handleRequest(request, new NodeContentTypeResponse(request, response));
	}

	/**
	 * 리소스가 확정된 유일한 지점 — 여기서 Node 원문 Content-Type을 고정한다. 상위가 이어서 서블릿 API로
	 * 지정하는 값은 래퍼가 가로채므로 컨테이너의 재조립을 타지 않는다. 304 경로는 상위가 이 메서드 앞에서
	 * 돌아가므로(Node 304도 Content-Type이 없다) 여기 오지 않는다.
	 */
	@Override
	protected void setHeaders(HttpServletResponse response, Resource resource, @Nullable MediaType mediaType)
			throws IOException {
		if (response instanceof NodeContentTypeResponse wrapper) {
			wrapper.pin(SpaContentTypes.nodeOriginal(resource.getFilename()));
		}
		super.setHeaders(response, resource, mediaType);
	}

	/**
	 * Content-Type 지정을 전부 {@link RawContentType} seam 으로 돌리는 응답 래퍼. 그 밖의 호출은 그대로 위임한다.
	 * 이름은 대소문자 무관하게 본다({@code ServletServerHttpResponse}는 {@code Content-Type}, 컨테이너 내부는
	 * 소문자 비교를 쓴다).
	 */
	private static final class NodeContentTypeResponse extends HttpServletResponseWrapper {

		private static final String CONTENT_TYPE = "Content-Type";

		/**
		 * 고정을 <b>덮어쓰지 않는</b> 유일한 예외 — 다중 {@code Range} 응답의 본문 형식이다.
		 *
		 * <p>핸들러가 {@code Accept-Ranges: bytes}를 광고하므로 다중 Range 는 도달 가능한 경로이고, 그때
		 * {@code ResourceRegionHttpMessageConverter}는 본문을 {@code multipart/byteranges; boundary=…}로 만든다.
		 * 고정값(파일 타입)으로 되돌리면 <b>헤더와 본문이 어긋난 응답</b>이 나간다(클라이언트가 경계 구분자를
		 * 스크립트로 읽는다). 고정의 목적은 <b>파일 타입을 Node 원문으로 맞추는 것</b>이지 컨버터가 정한 본문
		 * <b>형식</b>을 덮는 것이 아니다. 잠금은 {@code SpaServingWireTest.aRangeRequestKeepsTheContentTypeHonest}.
		 * 단일 Range 는 컨버터가 파일 타입을 그대로 쓰므로 이 예외에 걸리지 않는다(고정값과 같다).
		 */
		private static final String MULTIPART_BYTERANGES = "multipart/byteranges";

		private final @Nullable Object seam;

		private @Nullable String pinned;

		NodeContentTypeResponse(HttpServletRequest request, HttpServletResponse response) {
			super(response);
			this.seam = request.getAttribute(RawContentType.REQUEST_ATTRIBUTE);
		}

		/** Node 원문을 확정하고 즉시 seam 으로 쓴다 — 이후의 서블릿 API 지정은 전부 이 값으로 되돌린다. */
		void pin(String nodeOriginal) {
			this.pinned = nodeOriginal;
			RawContentType.set(this.seam, nodeOriginal);
		}

		@Override
		public void setContentType(String type) {
			rewrite(type);
		}

		@Override
		public void setHeader(String name, String value) {
			if (CONTENT_TYPE.equalsIgnoreCase(name)) {
				rewrite(value);
				return;
			}
			super.setHeader(name, value);
		}

		@Override
		public void addHeader(String name, String value) {
			if (CONTENT_TYPE.equalsIgnoreCase(name)) {
				rewrite(value);
				return;
			}
			super.addHeader(name, value);
		}

		/**
		 * 지정된 값을 <b>고정값으로 되돌린다</b> — 단 본문 형식이 {@code multipart/byteranges}면 그 값을 그대로
		 * 쓴다({@link #MULTIPART_BYTERANGES}). 어느 쪽이든 기록은 {@link RawContentType} seam 을 지난다.
		 */
		private void rewrite(@Nullable String requested) {
			if (this.pinned == null) {
				throw new IllegalStateException("SPA 응답의 Content-Type이 고정되기 전에 지정됐다 — "
						+ "setHeaders 가 먼저 불리지 않는 경로가 생겼다. 서블릿 API로 폴백하면 컨테이너가 헤더를 "
						+ "재조립해 Node와 어긋난 채 조용히 통과한다(SpaContentTypes 참조).");
			}
			RawContentType.set(this.seam, isMultipartByteRanges(requested) ? requested : this.pinned);
		}

		private static boolean isMultipartByteRanges(@Nullable String value) {
			return value != null && value.toLowerCase(Locale.ROOT).startsWith(MULTIPART_BYTERANGES);
		}
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
