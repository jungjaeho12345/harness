package harness.news.service;

import java.util.regex.Pattern;

/**
 * 첨부·자료 파일 참조의 스킴 방어 — 리포 루트 {@code src/services/fileRef.js}의 이식(규칙의 단일 출처).
 *
 * <p><b>거부 기반</b>이다: {@code /uploads/} 상대경로 또는 {@code https://}만 허용하고 나머지는 전부 빈
 * 문자열로 무력화한다(저장 시점 심화 방어, ADR-004). 빈 문자열은 거부가 아니라 정상 클리어(× 버튼)다.
 *
 * <p><b>검사 순서가 규칙의 일부다.</b> 예를 들어 백슬래시 거부가 https 허용보다 뒤로 가면
 * {@code https://cdn\evil}이 통과하고(브라우저가 {@code \}를 {@code /}로 정규화한다), 제어문자 거부가
 * 스킴 판정보다 뒤로 가면 {@code java\nscript:}가 스킴 검사를 빠져나간다. 순서를 바꾸지 마라.
 */
public final class FileRef {

	/** 허용되는 유일한 절대 URL 스킴. authority까지 포함해야 한다. */
	private static final Pattern HTTPS = Pattern.compile("^https://", Pattern.CASE_INSENSITIVE);

	/** 그 밖의 스킴({@code javascript:}·{@code data:}·{@code http:} …) 판정. */
	private static final Pattern SCHEME = Pattern.compile("^[a-zA-Z][a-zA-Z0-9+.-]*:");

	/** 접두 검사를 우회하는 traversal 세그먼트. */
	private static final Pattern TRAVERSAL = Pattern.compile("(^|/)\\.\\.(/|$)");

	/** 신뢰하는 상대경로 접두 — 업로드 위치뿐이다. */
	private static final String UPLOADS = "/uploads/";

	/**
	 * 위험한 참조를 빈 문자열로 무력화한다.
	 *
	 * <p>Node가 먼저 {@code String(value)}를 부르므로 문자열이 아닌 입력도 문자열이 된 뒤 규칙을 탄다 —
	 * {@code null}은 문자열 {@code "null"}이 되어 접두 검사에서 걸리고 결국 빈 문자열이 된다.
	 */
	public static String sanitize(Object value) {
		String s = String.valueOf(value);
		if (s.isEmpty()) {
			return ""; // 빈값 = 정상 클리어 — 통과
		}
		if (hasControlOrSpace(s)) {
			return ""; // 브라우저가 제거·정규화해 스킴이 되살아나는 은닉 차단
		}
		if (s.indexOf('\\') >= 0) {
			return ""; // 백슬래시(브라우저가 '/'로 정규화) 거부
		}
		if (s.startsWith("//")) {
			return ""; // 프로토콜상대(//host) 거부
		}
		if (HTTPS.matcher(s).find()) {
			return s; // https://만 허용 — 원문 그대로 돌려준다
		}
		if (SCHEME.matcher(s).find()) {
			return ""; // javascript:/data:/http: 등 전부 거부
		}
		if (!s.startsWith(UPLOADS)) {
			return ""; // 상대경로는 업로드 위치만 신뢰
		}
		if (TRAVERSAL.matcher(s).find()) {
			return ""; // '..' 세그먼트 거부
		}
		return s;
	}

	/** U+0000~U+0020 — 제어문자와 공백. 하나라도 있으면 거부다. */
	private static boolean hasControlOrSpace(String s) {
		for (int i = 0; i < s.length(); i++) {
			if (s.charAt(i) <= 0x20) {
				return true;
			}
		}
		return false;
	}

	private FileRef() {
	}
}
