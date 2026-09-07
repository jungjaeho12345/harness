package harness.news.web;

import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * SPA 정적 서빙의 {@code Content-Type} 원문 — <b>Node({@code send@0.19.2} + {@code mime@1.6.0})의 규칙</b>이다.
 * 컨테이너(Tomcat)의 확장자 표를 쓰지 않는다.
 *
 * <h2>왜 이 클래스가 있는가(phase 76 step3 대조기의 발견)</h2>
 * 2026-09-07 원시 소켓 실측으로 Node와 이 서버를 같은 {@code web/dist}로 나란히 쳤더니 SPA 200 응답의
 * {@code Content-Type}이 전부 갈렸다:
 * <pre>
 * Node                                         이 서버(수정 전)
 * text/html; charset=UTF-8                     text/html
 * text/css; charset=UTF-8                      text/css
 * application/javascript; charset=UTF-8        text/javascript        ← 기저 타입까지 다르다
 * </pre>
 * {@code send}는 {@code mime.lookup(path)}로 기저 타입을 정하고 {@code mime.charsets.lookup}이
 * {@code /^text\/|^application\/(javascript|json)/}에 <b>대문자 {@code UTF-8}</b>을 붙인다(세미콜론 뒤 공백 1개).
 * Tomcat의 표({@code MimeTypeMappings.properties})는 {@code js}·{@code mjs}를 {@code text/javascript}로 적고
 * charset 파라미터를 붙이지 않는다. 대조기는 content-type 원문을 <b>실패 diff</b>로 비교한다 — 이 축을 허용
 * 목록에 넣으면 대조가 공허해진다(step3 변이 N4). 그래서 값을 Node 규칙대로 만들고 {@link RawContentType}
 * seam으로 <b>바이트 그대로</b> 기록한다(서블릿 API는 {@code ;charset=}으로 재조립한다 — {@link RawContentType}).
 *
 * <h2>표는 실측에서만 온다</h2>
 * 아래 확장자 표는 2026-09-07에 리포의 {@code node_modules/mime@1.6.0}에 직접 물어 옮긴 값이다
 * ({@code mime.lookup('x.<ext>')}). 실측하지 않은 확장자를 넣지 않는다 — 표가 Node보다 넓어지면 그 자체가
 * 새 divergence다. 모르는 확장자는 {@code send}와 같이 {@code application/octet-stream}이다
 * ({@code avif}도 {@code mime@1.6.0}에는 없다 — Tomcat은 {@code image/avif}를 안다. 여기서는 Node를 따른다).
 * 확장자 판정도 {@code mime.lookup}과 같다: 마지막 {@code .}·{@code /}·{@code \}} 뒤를 소문자화한다.
 *
 * <p>Node 쪽 정본이 바뀌면(예: express 5 = {@code send@1} + {@code mime-types@3}는 {@code text/javascript}를 낸다)
 * step3 대조기가 실패 diff로 알려 준다 — 그때 이 표를 다시 잰다.
 */
final class SpaContentTypes {

	/** {@code send}의 미지 확장자 기본값({@code mime.default_type}). */
	static final String OCTET_STREAM = "application/octet-stream";

	/** {@code mime.charsets.lookup}이 붙이는 파라미터 원문(대문자 · 세미콜론 뒤 공백 1개). */
	private static final String UTF8_PARAMETER = "; charset=UTF-8";

	/** {@code mime@1.6.0} {@code charsets.lookup}의 정규식 그대로. */
	private static final Pattern UTF8_TYPES = Pattern.compile("^text/|^application/(javascript|json)");

	/** {@code mime@1.6.0} {@code lookup} 실측표(2026-09-07). 값 순서는 의미가 없다. */
	private static final Map<String, String> NODE_MIME = Map.ofEntries(
			Map.entry("html", "text/html"),
			Map.entry("htm", "text/html"),
			Map.entry("css", "text/css"),
			Map.entry("js", "application/javascript"),
			Map.entry("mjs", "application/javascript"),
			Map.entry("json", "application/json"),
			Map.entry("map", "application/json"),
			Map.entry("txt", "text/plain"),
			Map.entry("xml", "application/xml"),
			Map.entry("svg", "image/svg+xml"),
			Map.entry("png", "image/png"),
			Map.entry("jpg", "image/jpeg"),
			Map.entry("jpeg", "image/jpeg"),
			Map.entry("gif", "image/gif"),
			Map.entry("webp", "image/webp"),
			Map.entry("ico", "image/x-icon"),
			Map.entry("woff", "font/woff"),
			Map.entry("woff2", "font/woff2"),
			Map.entry("ttf", "font/ttf"),
			Map.entry("otf", "font/otf"),
			Map.entry("eot", "application/vnd.ms-fontobject"),
			Map.entry("webmanifest", "application/manifest+json"),
			Map.entry("wasm", "application/wasm"),
			Map.entry("mp4", "video/mp4"),
			Map.entry("webm", "video/webm"),
			Map.entry("mp3", "audio/mpeg"),
			Map.entry("pdf", "application/pdf"));

	private SpaContentTypes() {
	}

	/**
	 * 이 파일 이름에 Node({@code send})가 붙일 {@code Content-Type} 헤더 값 원문.
	 *
	 * @param filename 서빙할 리소스의 파일 이름(경로가 섞여 있어도 된다 — {@code mime.lookup}과 같은 규칙으로
	 * 마지막 세그먼트의 확장자만 본다). {@code null}·빈 값이면 {@link #OCTET_STREAM}이다
	 */
	static String nodeOriginal(String filename) {
		String base = NODE_MIME.getOrDefault(extensionLikeMimeLookup(filename), OCTET_STREAM);
		return UTF8_TYPES.matcher(base).find() ? base + UTF8_PARAMETER : base;
	}

	/** {@code mime.lookup}: {@code path.replace(/^.*[\.\/\\]/, '').toLowerCase()} — 마지막 구분자 뒤 전부다. */
	private static String extensionLikeMimeLookup(String filename) {
		if (filename == null) {
			return "";
		}
		int cut = Math.max(filename.lastIndexOf('.'), Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')));
		return filename.substring(cut + 1).toLowerCase(Locale.ROOT);
	}
}
