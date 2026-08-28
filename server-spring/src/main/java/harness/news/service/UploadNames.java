package harness.news.service;

import java.util.Locale;
import java.util.Set;

/**
 * 업로드 파일명 판정의 <b>Node 의미론</b> — {@code path.extname(filename).slice(1).toLowerCase()}와
 * 확장자 화이트리스트 14종({@code server/index.js} 312~316행 {@code UPLOAD_EXT_ALLOWLIST} · 1022행).
 *
 * <p>{@link NodeString}(공백) · {@link NodeBase64}(base64)와 같은 지위의 <b>단일 출처</b>다. 파일명에서
 * 확장자를 뽑는 코드를 다른 곳에 다시 쓰지 마라 — 한쪽만 고쳐지면 그 어긋남은 계약이 관측하지 않는 축이라
 * 조용히 산다(2026-08-24 리뷰 high-1: {@code Number()} 로컬 재구현 2벌이 Node가 안 지우는 행을 지웠다).
 *
 * <h2>{@code path.extname}은 "마지막 점 뒤"가 아니다</h2>
 * Node의 알고리즘은 <b>오른쪽에서 왼쪽으로</b> 훑으며 다섯 상태를 함께 본다. 그래서 다음이 전부 확장자
 * 없음(빈 문자열)이다: {@code "noextension"} · {@code ".png"}(선행 점 파일) · {@code ".."} ·
 * {@code "dir.d/name"}(마지막 조각에 점이 없다). 반대로 {@code "a."}·{@code "a.png."}는 {@code "."}이
 * 나와 {@code slice(1)} 뒤 빈 문자열이 되므로 역시 거부다. 이 표는 리포 밖에서 Node v24.16.0으로
 * 재현했고 {@code UploadNamesTest}가 골든 벡터 52행으로 잠근다.
 *
 * <h2>win32 알고리즘을 이식한다 — posix와 판정이 실제로 갈린다</h2>
 * Node의 {@code path.extname}은 플랫폼 구현이고 이 서버가 도는 곳은 win32다. 두 알고리즘은 <b>200/400을
 * 실제로 가르는</b> 입력을 갖는다(2026-08-28 실측 — 계획서 decisions (5)의 "결정에 영향이 없다"는 문장은
 * 이 실측으로 반증됐다):
 * <ul>
 * <li>{@code "C:.png"} — win32는 드라이브 루트 두 글자를 탐색에서 제외해 <b>선행 점 파일</b>로 읽고 거부,
 * posix는 {@code ".png"}로 읽어 허용.</li>
 * <li>{@code "a.png\\"} — win32는 후행 백슬래시를 경로 구분자로 떼어 허용, posix는 {@code "png\\"}로
 * 읽어 거부.</li>
 * </ul>
 *
 * <h2>소문자화는 {@link Locale#ROOT}다</h2>
 * 기본 로케일 {@code toLowerCase()}를 쓰면 터키어 환경에서 {@code 'I'}가 {@code 'ı'}(U+0131)가 되어
 * {@code a.GIF}가 <b>서버마다 다른 판정</b>을 받는다(200 ↔ 400).
 *
 * <h2>{@code null}은 NPE가 아니라 빈 문자열이다</h2>
 * 화이트리스트가 {@link Set#of} 불변 집합이라 {@code contains(null)}이 NPE를 던진다 — 그 순간 400이어야
 * 할 요청이 500 {@code internal-error}가 된다(phase 68·69·70 반복 함정). 그래서 조회 <b>전에</b> 타입·
 * 공백을 접는다.
 */
public final class UploadNames {

	/**
	 * Node {@code UPLOAD_EXT_ALLOWLIST} 14종(소문자 비교). 계약 {@code media-upload.contract.js} 36행의
	 * {@code UPLOAD_EXTS}와 같은 집합이며 계약이 14 전부를 200으로 관측한다.
	 */
	static final Set<String> ALLOWED_EXTENSIONS = Set.of("png", "jpg", "jpeg", "gif", "webp", "pdf",
			"doc", "docx", "xls", "xlsx", "txt", "hwp", "ppt", "pptx");

	/**
	 * Node {@code path.win32.extname}의 이식 — 점을 <b>포함한</b> 확장자이거나 빈 문자열이다.
	 *
	 * <p>변수 이름과 분기 순서는 Node 구현(lib/path.js)을 그대로 옮겼다. 읽기 쉽게 고쳐 쓰지 마라 —
	 * 다섯 상태({@code startDot}·{@code startPart}·{@code end}·{@code matchedSlash}·{@code preDotState})의
	 * 조합이 곧 규칙이고, 하나라도 어긋나면 위 골든 벡터의 어딘가가 갈린다.
	 *
	 * @param path 사용자 파일명({@code null}이면 빈 문자열)
	 * @return {@code ".png"}처럼 점으로 시작하는 확장자, 또는 확장자가 없으면 빈 문자열
	 */
	public static String extname(String path) {
		if (path == null) {
			return "";
		}
		int start = 0;
		int startDot = -1;
		int startPart = 0;
		int end = -1;
		boolean matchedSlash = true;
		// 첫 점 앞에서 본 문자의 상태: 0 = 아직 없음 · 1 = 점만 봤다 · -1 = 점 아닌 문자를 봤다.
		int preDotState = 0;

		// win32 드라이브 루트 접두(C:)는 탐색에서 제외한다 — 뒤따르는 구분자를 후행 구분자로 오인하지 않게.
		if (path.length() >= 2 && path.charAt(1) == ':' && isWindowsDeviceRoot(path.charAt(0))) {
			start = 2;
			startPart = 2;
		}

		for (int i = path.length() - 1; i >= start; i--) {
			char code = path.charAt(i);
			if (isPathSeparator(code)) {
				// 후행 구분자 무리가 아닌 구분자를 만나면 마지막 조각의 시작이다.
				if (!matchedSlash) {
					startPart = i + 1;
					break;
				}
				continue;
			}
			if (end == -1) {
				matchedSlash = false;
				end = i + 1;
			}
			if (code == '.') {
				if (startDot == -1) {
					startDot = i;
				}
				else if (preDotState != 1) {
					preDotState = 1;
				}
			}
			else if (startDot != -1) {
				preDotState = -1;
			}
		}

		boolean trimmedPartIsDotDot = preDotState == 1 && startDot == end - 1 && startDot == startPart + 1;
		if (startDot == -1 || end == -1 || preDotState == 0 || trimmedPartIsDotDot) {
			return "";
		}
		return path.substring(startDot, end);
	}

	/**
	 * 화이트리스트를 통과한 <b>소문자 확장자</b>, 통과하지 못하면 빈 문자열.
	 *
	 * <p>Node 1022~1025행 두 줄의 합이다. 빈 문자열은 "저장할 수 없다"는 뜻이고 호출자는 그것을
	 * {@code invalid-file} 400으로 접는다. {@code null}을 돌려주지 않는 이유는 그 {@code null}이 다시
	 * 불변 집합·경로 합성으로 흘러 500이 되는 경로를 원천에서 없애기 위해서다.
	 *
	 * @param filename 사용자 파일명({@code null} 허용)
	 * @return {@code "png"}처럼 점 없는 소문자 확장자, 또는 빈 문자열
	 */
	public static String acceptedExtension(String filename) {
		String extension = extname(filename);
		if (extension.length() < 2) {
			// "" 와 "." — slice(1)이 빈 문자열이 되는 자리다(불변 집합에 묻기 전에 접는다).
			return "";
		}
		String normalized = extension.substring(1).toLowerCase(Locale.ROOT);
		return ALLOWED_EXTENSIONS.contains(normalized) ? normalized : "";
	}

	/** win32 경로 구분자 — 슬래시와 백슬래시 둘 다다. */
	private static boolean isPathSeparator(char code) {
		return code == '/' || code == '\\';
	}

	/** {@code C:} 형태의 드라이브 문자인가. */
	private static boolean isWindowsDeviceRoot(char code) {
		return (code >= 'A' && code <= 'Z') || (code >= 'a' && code <= 'z');
	}

	private UploadNames() {
	}

}
