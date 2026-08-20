package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * transport 계층(web·controller)의 배선 규율을 정적 스캔으로 잠근다 — 실행 경로가 아니라
 * <b>소스에 존재하는 것 자체</b>를 금지하는 축들이다.
 *
 * <ol>
 *   <li><b>쿼리 파라미터를 읽지 않는다.</b> {@code ?session=} 폴백은 URL·로그 누출 표면 때문에
 *       제거됐고 <b>부재가 계약</b>이다(2026-08 감사의 권한 상승 3건 중 하나). 세션 토큰 판독기는
 *       요청 객체를 아예 받지 않지만, 컨트롤러가 직접 쿼리를 읽는 경로도 함께 막는다.</li>
 *   <li><b>content-type을 서블릿 API로 정하지 않는다.</b> {@code setContentType}·
 *       {@code setCharacterEncoding}을 부르는 순간 컨테이너가 헤더를 재조립해 Node와 1바이트 어긋난다
 *       (ContentTypeWireTest 참조). 지정은 {@link RawContentType} 한 곳뿐이다.</li>
 * </ol>
 */
class WebWiringTest {

	private static final List<Path> TRANSPORT_SOURCES = List.of(
			Path.of("src", "main", "java", "harness", "news", "web"),
			Path.of("src", "main", "java", "harness", "news", "controller"));

	/** 주석은 스캔 대상이 아니다 — 금지된 API를 <b>설명</b>하는 문장은 있어야 한다(그게 근거다). */
	private static final Pattern COMMENTS = Pattern.compile("/\\*.*?\\*/|//[^\\n]*", Pattern.DOTALL);

	private List<String> scan(Pattern forbidden) throws IOException {
		List<String> hits = new ArrayList<>();
		for (Path root : TRANSPORT_SOURCES) {
			assertTrue(Files.isDirectory(root),
					"스캔 대상이 없다 — 작업 디렉토리가 모듈 루트가 아니다: " + root.toAbsolutePath());
			try (Stream<Path> files = Files.walk(root)) {
				for (Path file : files.filter(Files::isRegularFile).toList()) {
					String code = COMMENTS.matcher(Files.readString(file, StandardCharsets.UTF_8)).replaceAll("");
					if (forbidden.matcher(code).find()) {
						hits.add(file.toString());
					}
				}
			}
		}
		return hits;
	}

	@Test
	void transportNeverReadsQueryParameters() throws IOException {
		List<String> hits = scan(Pattern.compile("getParameter\\(|getParameterMap\\(|getQueryString\\("));

		assertEquals(List.of(), hits, "쿼리 파라미터 판독은 ?session= 폴백 부활의 첫 걸음이다");
	}

	@Test
	void contentTypeIsNeverSetThroughTheServletApi() throws IOException {
		// setContentTypeNoCharset(coyote 직접 기록)은 이 패턴에 걸리지 않는다 — 그것만이 허용 경로다.
		List<String> hits = scan(Pattern.compile("\\.setContentType\\(|\\.setCharacterEncoding\\("));

		assertEquals(List.of(), hits, "서블릿 API로 content-type을 정하면 컨테이너가 헤더를 재조립한다");
	}
}
