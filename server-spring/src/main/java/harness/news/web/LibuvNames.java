package harness.news.web;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;
import org.springframework.web.util.UriUtils;

/**
 * <b>libuv가 보는 파일 이름만</b> 통과시키는 판정 — 정적 서빙 리졸버가 공유한다
 * ({@link UploadsResourceResolver} · {@link SpaResourceResolver}).
 *
 * <h2>왜 필요한가: 정본과 이 서버는 같은 파일시스템을 서로 다르게 본다</h2>
 * 정본은 {@code express.static} → {@code fs.stat}이고 그 아래는 libuv다. libuv는 경로를 {@code \\?\} 장문
 * 형태로 열어 <b>Win32 레거시 이름 정규화를 받지 않는다</b>. 반면 Java의 파일 접근은 그 정규화를 그대로
 * 받는다. 2026-08-29 {@code fs.statSync} 직접 실측(같은 win32 호스트):
 * <pre>
 * "x.png"        ok      "x.png."       ENOENT     "CON"   ENOENT
 * "X.PNG"        ok      "x.png "       ENOENT     "NUL"   ENOENT
 * "x.png::$DATA" ok      "x.png:s"      ENOENT     "AUX"   ENOENT
 * </pre>
 * 그래서 손대지 않으면 <b>정본이 404를 내는 표기가 여기서는 200</b>이 된다. 같은 파일에 URL 별칭이
 * 늘어나는 것 자체가 표면이다 — URL 기준의 차단·캐시·감사 로그가 전부 갈린다.
 *
 * <p>예약 장치명은 더 나쁘다: {@code NUL}은 <b>실재하는 장치</b>로 열려 리소스 조회가 예외를 던지고 전역
 * 핸들러가 <b>500</b>을 만든다(정본은 404). 없는 파일이 500이 되는 것은 상태코드 divergence인 동시에 서버
 * 로그를 남기는 자리라 무한히 반복 호출당할 수 있다. <b>SPA 서빙도 같은 파일시스템 위에 있으므로 같은
 * 판정을 쓴다</b>(2026-09-05 phase 76 step2 — 이 클래스를 {@code UploadsResourceResolver}에서 뽑아냈다.
 * 두 리졸버가 각자 규칙을 들면 한쪽만 늙는다).
 *
 * <h2>맞추지 <b>않는</b> 것</h2>
 * {@code ::$DATA}(대체 데이터 스트림 기본 표기)와 {@code .PNG}(대소문자 무시)는 <b>정본도 200</b>이다.
 * 여기서 막으면 오히려 divergence가 늘어나므로 건드리지 않는다 — 이 판정의 규칙은 <b>정본 실측을
 * 재현하는 것</b>이지 강화가 아니다.
 */
final class LibuvNames {

	/**
	 * Win32 예약 장치명 — 확장자가 붙어도({@code CON.txt}) 장치로 해석된다. 2026-08-29 실측상 정본은 이
	 * 전부에 404다. {@code CLOCK$}는 이 호스트의 Java에서도 이미 404였으므로 넣지 않는다(실측하지 않은
	 * 이름을 목록에 넣지 않는다 — 목록이 정본보다 넓어지면 그 자체가 새 divergence다).
	 */
	private static final Set<String> RESERVED_DEVICE_NAMES = Set.of(
			"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
			"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
			"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9");

	private LibuvNames() {
	}

	/**
	 * libuv({@code \\?\} 장문 경로)가 이 이름을 열 수 있는가. 세그먼트 단위로 본다 — 후행 점·공백은
	 * <b>디렉토리 세그먼트에도</b> 같은 별칭을 만들기 때문이다(실측: {@code /uploads/<dir>./<파일>}이 200이었다).
	 *
	 * <p><b>먼저 퍼센트 디코딩한다</b>: 이 층에 오는 {@code resourcePath}는 아직 인코딩된 원문이라
	 * ({@code PathContainer#value}), 디코딩 없이 마지막 글자만 보면 {@code .png%2e}·{@code .png%20}이 그대로
	 * 통과한다(2026-08-29 실측: 디코딩 전 규칙으로는 이 둘이 200이었다 — 실제로 밟은 함정이다).
	 * {@code createRelative}가 보는 이름과 <b>같은 문자열</b>을 봐야 판정이 어긋나지 않는다. 디코더는
	 * {@link UriUtils} 하나만 쓴다 — {@code URLDecoder}는 {@code '+'}를 공백으로 바꿔 URL 경로 의미론과 다르다.
	 *
	 * <p>디코딩 뒤에 {@code /}로 다시 자르는 이유: {@code %2f}가 실제 경로 구분자가 되어 세그먼트를 늘리므로,
	 * 파일시스템이 보는 것과 같은 단위로 봐야 후행 점이 숨지 못한다.
	 */
	static boolean visible(String resourcePath) {
		String decoded = decode(resourcePath);
		if (decoded == null) {
			// 깨진 퍼센트 시퀀스 — 열 수 있는 이름이 아니다. 500이 아니라 404로 수렴시킨다.
			return false;
		}
		for (String segment : decoded.split("/")) {
			if (isRelativeSegment(segment)) {
				// 상대 세그먼트는 상위가 이미 처리한다(위치 밖 탈출은 PathResourceResolver의 검사가 막는다).
				continue;
			}
			char last = segment.charAt(segment.length() - 1);
			if (last == '.' || last == ' ') {
				// Win32는 후행 점·공백을 조용히 잘라 "다른 이름"이 같은 파일을 열게 한다. libuv는 자르지 않는다.
				return false;
			}
			int dot = segment.indexOf('.');
			String base = (dot < 0) ? segment : segment.substring(0, dot);
			if (RESERVED_DEVICE_NAMES.contains(base.toUpperCase(Locale.ROOT))) {
				return false;
			}
		}
		return true;
	}

	/** 퍼센트 디코딩 — 깨진 시퀀스면 {@code null}(열 수 있는 이름이 아니다). */
	static String decode(String resourcePath) {
		try {
			return UriUtils.decode(resourcePath, StandardCharsets.UTF_8);
		}
		catch (IllegalArgumentException ex) {
			return null;
		}
	}

	/** 빈 세그먼트와 {@code .}·{@code ..} — 이름 판정의 대상이 아니다. */
	static boolean isRelativeSegment(String segment) {
		return segment.isEmpty() || ".".equals(segment) || "..".equals(segment);
	}
}
