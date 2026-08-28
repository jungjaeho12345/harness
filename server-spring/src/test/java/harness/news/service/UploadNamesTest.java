package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * 업로드 파일명 → 확장자 판정의 <b>Node 의미론</b> 그물 — {@code path.extname(filename).slice(1).toLowerCase()}
 * (Node {@code server/index.js} 1022행)와 화이트리스트 14종({@code UPLOAD_EXT_ALLOWLIST}, 312~316행).
 *
 * <p><b>계약이 관측하는 것은 이 축의 극히 일부다.</b> {@code media-upload.contract.js}가 보는 파일명은
 * {@code contract-upload.png} · {@code contract-upload.PNG} · {@code contract-allow.<14종>} ·
 * {@code malware.exe} · {@code noextension} 다섯 형태뿐이다. 선행 점(.png) · 후행 점(a.) · 다중 점 ·
 * 경로 구분자 · 드라이브 문자 · NUL · 후행 공백 · 비-ASCII · 로케일은 <b>전부 계약 밖</b>이라
 * 이 테스트가 유일 방어선이다(index.json decisions (22)②).
 *
 * <h2>골든 벡터는 Node 실측이다</h2>
 * 아래 표는 계획서 문구를 옮긴 것이 아니라 <b>Node v24.16.0(win32)로 직접 재현</b>한 값이다
 * (리포 밖 스크래치패드 {@code extname-probe.mjs} · 2026-08-28). 그 재현이 계획서 decisions (5)의
 * 문장 하나를 <b>반증</b>했다 — {@link #theWin32AlgorithmIsTheOneNodeRunsAndPosixWouldDecideDifferently}.
 *
 * <p>리포 파일시스템은 한 바이트도 만지지 않는다(순수 문자열 함수다).
 */
class UploadNamesTest {

	/** 계약 파일 36행의 {@code UPLOAD_EXTS} — 테스트가 <b>독립적으로</b> 적는다(상수를 재사용하지 않는다). */
	private static final List<String> CONTRACT_EXTS = List.of("png", "jpg", "jpeg", "gif", "webp", "pdf",
			"doc", "docx", "xls", "xlsx", "txt", "hwp", "ppt", "pptx");

	/** U+3000 — 눈에 보이지 않아 소스에 직접 적지 않는다(다른 손이 공백으로 오인해 지운다). */
	private static final String IDEOGRAPHIC_SPACE = Character.toString(0x3000);

	/** {@code UploadStore}가 저장 직전에 다시 요구하는 형태 — 허용 확장자는 전부 이 안에 들어야 한다. */
	private static final Pattern STORABLE = Pattern.compile("^[a-z0-9]{1,10}$");

	/**
	 * Node 골든 벡터 한 줄.
	 *
	 * @param filename 요청 {@code filename}
	 * @param extname {@code path.win32.extname(filename)} 실측값(점을 포함한다)
	 * @param extension {@code extname.slice(1).toLowerCase()} 실측값
	 * @param allowed 화이트리스트 14종에 드는가(= 200인가)
	 */
	private record Row(String filename, String extname, String extension, boolean allowed) {
	}

	private static Row allow(String filename, String extname, String extension) {
		return new Row(filename, extname, extension, true);
	}

	private static Row deny(String filename, String extname, String extension) {
		return new Row(filename, extname, extension, false);
	}

	/** Node 실측 52행 — 한 줄도 손으로 추측하지 않았다. */
	private static List<Row> goldenVectors() {
		List<Row> rows = new ArrayList<>();
		// 계약이 실제로 보내는 형태.
		rows.add(allow("contract-upload.png", ".png", "png"));
		rows.add(allow("contract-upload.PNG", ".PNG", "png"));
		rows.add(allow("a.PNG", ".PNG", "png"));
		rows.add(deny("malware.exe", ".exe", "exe"));
		rows.add(deny("noextension", "", ""));
		// 점의 자리 — 선행 점 파일은 확장자가 없고, 후행 점은 확장자가 비어 거부다.
		rows.add(deny(".png", "", ""));
		rows.add(allow("..png", ".png", "png"));
		rows.add(deny("a.", ".", ""));
		rows.add(deny("a.png.", ".", ""));
		rows.add(deny("", "", ""));
		rows.add(deny(".", "", ""));
		rows.add(deny("..", "", ""));
		rows.add(deny("...", ".", ""));
		rows.add(allow("a..png", ".png", "png"));
		rows.add(allow(".png.png", ".png", "png"));
		rows.add(allow(".hidden.png", ".png", "png"));
		// 마지막 점만 본다 — 이중 확장자의 위장은 통하지 않는다(그리고 통하지 않아야 한다).
		rows.add(deny("a.tar.gz", ".gz", "gz"));
		rows.add(allow("a.PNG.JPG", ".JPG", "jpg"));
		rows.add(allow("a.exe.png", ".png", "png"));
		rows.add(deny("a.png.exe", ".exe", "exe"));
		rows.add(allow("file.name.hwp", ".hwp", "hwp"));
		// 경로 조각은 판정에만 쓰이고 저장명에 반영되지 않는다.
		rows.add(allow("dir/a.png", ".png", "png"));
		rows.add(allow("dir\\a.png", ".png", "png"));
		rows.add(allow("/uploads/../secret.png", ".png", "png"));
		rows.add(allow("c:\\dir\\a.png", ".png", "png"));
		rows.add(allow("\\\\server\\share\\a.png", ".png", "png"));
		rows.add(allow("https://h/a.png", ".png", "png"));
		rows.add(allow("a.png/", ".png", "png"));
		rows.add(allow("a.png\\", ".png", "png"));
		rows.add(allow("a.png//", ".png", "png"));
		rows.add(deny("dir.d/name", "", ""));
		rows.add(deny("dir.d\\name", "", ""));
		// win32 드라이브 루트 접두 — 앞 두 글자는 확장자 탐색에서 제외된다.
		rows.add(allow("C:a.png", ".png", "png"));
		rows.add(deny("C:.png", "", ""));
		// NUL·제어문자·공백은 확장자 문자열에 그대로 남아 화이트리스트 밖으로 나간다.
		rows.add(allow("a.png\0.txt", ".txt", "txt"));
		rows.add(allow("a\0.png", ".png", "png"));
		rows.add(deny("a.\0png", ".\0png", "\0png"));
		rows.add(deny("a.pn\0g", ".pn\0g", "pn\0g"));
		rows.add(deny("a.png ", ".png ", "png "));
		rows.add(deny("a.png\t", ".png\t", "png\t"));
		rows.add(deny("a.p ng", ".p ng", "p ng"));
		rows.add(deny("a.PNG" + IDEOGRAPHIC_SPACE, ".PNG" + IDEOGRAPHIC_SPACE, "png" + IDEOGRAPHIC_SPACE));
		rows.add(allow("  .png", ".png", "png"));
		rows.add(allow("a .png", ".png", "png"));
		// URL 조각은 벗겨지지 않는다 — 서버는 파일명을 파싱하지 않는다.
		rows.add(deny("a.png?x=1", ".png?x=1", "png?x=1"));
		rows.add(deny("a.png#frag", ".png#frag", "png#frag"));
		// 비-ASCII.
		rows.add(allow("한글.png", ".png", "png"));
		rows.add(deny("ａ.ｐｎｇ", ".ｐｎｇ", "ｐｎｇ"));
		// 대소문자 정규화(화이트리스트 비교는 소문자로 한다).
		rows.add(allow("x.HWP", ".HWP", "hwp"));
		rows.add(allow("x.Xlsx", ".Xlsx", "xlsx"));
		rows.add(allow("x.pptx", ".pptx", "pptx"));
		rows.add(allow("a.jpeg", ".jpeg", "jpeg"));
		return rows;
	}

	private Locale saved;

	@AfterEach
	void restoreLocale() {
		if (this.saved != null) {
			Locale.setDefault(this.saved);
			this.saved = null;
		}
	}

	/** {@code path.extname}(win32) 자체를 골든 벡터 전건으로 재현한다. */
	@Test
	void extnameReproducesNodeWin32ForEveryGoldenVector() {
		for (Row row : goldenVectors()) {
			assertEquals(row.extname(), UploadNames.extname(row.filename()),
					"path.extname divergence: " + describe(row.filename()));
		}
	}

	/** 소문자 확장자와 화이트리스트 판정까지 전건 재현한다(거부는 빈 문자열로 접힌다). */
	@Test
	void theAcceptedExtensionAndItsAllowlistVerdictMatchNodeForEveryGoldenVector() {
		for (Row row : goldenVectors()) {
			String expected = row.allowed() ? row.extension() : "";
			assertEquals(expected, UploadNames.acceptedExtension(row.filename()),
					"확장자 판정 divergence: " + describe(row.filename()));
		}
	}

	/** 화이트리스트는 <b>정확히 14종</b>이고 계약 파일 36행의 목록과 같다. */
	@Test
	void theAllowlistIsExactlyTheFourteenExtensionsOfTheContract() {
		assertEquals(14, UploadNames.ALLOWED_EXTENSIONS.size(), "화이트리스트 크기가 14가 아니다");
		assertEquals(Set.copyOf(CONTRACT_EXTS), UploadNames.ALLOWED_EXTENSIONS,
				"화이트리스트가 계약 36행의 UPLOAD_EXTS와 다르다");
		for (String ext : CONTRACT_EXTS) {
			assertEquals(ext, UploadNames.acceptedExtension("contract-allow." + ext), "." + ext + "가 거부됐다");
		}
	}

	/**
	 * 통과한 확장자는 {@code UploadStore}가 저장 직전에 요구하는 좁은 형태 안에 있다 — 즉
	 * <b>두 층의 검증이 서로 모순되지 않는다</b>(모순되면 200이어야 할 요청이 500이 된다).
	 */
	@Test
	void everyAcceptedExtensionIsStorableByTheUploadStore() {
		for (String ext : UploadNames.ALLOWED_EXTENSIONS) {
			assertTrue(STORABLE.matcher(ext).matches(), "저장소가 거부할 확장자가 화이트리스트에 있다: " + ext);
		}
		for (Row row : goldenVectors()) {
			String accepted = UploadNames.acceptedExtension(row.filename());
			if (!accepted.isEmpty()) {
				assertTrue(STORABLE.matcher(accepted).matches(),
						"허용된 확장자가 저장 불가 형태다(500 유발): " + describe(row.filename()));
			}
		}
	}

	/**
	 * <b>소문자화는 {@link Locale#ROOT}다.</b> 기본 로케일이 터키어면 {@code String.toLowerCase()}가
	 * {@code 'I'}를 {@code 'ı'}(U+0131)로 바꿔 {@code a.GIF}가 {@code "gıf"}가 되고 <b>같은 요청이 서버마다
	 * 다른 판정</b>을 받는다(200 ↔ 400). 로케일을 실제로 바꿔 그 divergence를 재현 시도한다.
	 */
	@Test
	void theExtensionIsLowercasedWithLocaleRootSoATurkishServerJudgesTheSame() {
		this.saved = Locale.getDefault();
		Locale.setDefault(Locale.forLanguageTag("tr"));

		assertEquals("gıf", "GIF".toLowerCase(),
				"기본 로케일이 실제로 터키어가 아니다 — 이 테스트는 아무것도 검증하지 못한다");
		assertEquals("gif", UploadNames.acceptedExtension("a.GIF"), "터키어 로케일에서 .GIF 판정이 갈렸다");
		assertEquals("gif", UploadNames.acceptedExtension("dir/IMAGE.GIF"));
		assertEquals("txt", UploadNames.acceptedExtension("a.TXT"));
		assertEquals("png", UploadNames.acceptedExtension("contract-upload.PNG"));
		assertEquals(".GIF", UploadNames.extname("a.GIF"), "extname은 로케일과 무관하다");
	}

	/**
	 * {@code null}은 NPE가 아니라 빈 문자열이다.
	 *
	 * <p>화이트리스트가 {@link Set#of} 불변 집합이라 {@code contains(null)}이 <b>NPE</b>이고, 그 순간
	 * 400이어야 할 요청이 500 {@code internal-error}가 된다(phase 68·69·70 반복 함정 · decisions (24)).
	 */
	@Test
	void aNullFilenameFoldsToEmptyInsteadOfThrowing() {
		assertEquals("", UploadNames.extname(null));
		assertEquals("", UploadNames.acceptedExtension(null));
	}

	/**
	 * <b>계획서 decisions (5)의 문장 하나를 실측이 반증했다.</b>
	 *
	 * <p>계획서는 "POSIX/win32 divergence는 결정에 영향이 없다 — 갈리는 경우 posix 결과는 백슬래시를 포함해
	 * 어차피 화이트리스트 밖"이라고 썼다. Node 실측(2026-08-28)은 <b>판정 자체가 갈리는 입력 둘</b>을 찾았다:
	 * <ul>
	 * <li>{@code "C:.png"} — win32는 드라이브 루트 두 글자를 건너뛰어 <b>선행 점 파일</b>로 보고 거부(400),
	 * posix는 {@code ".png"}를 확장자로 읽어 <b>허용(200)</b>.</li>
	 * <li>{@code "a.png\\"} — win32는 후행 백슬래시를 구분자로 떼어 {@code "png"} <b>허용(200)</b>,
	 * posix는 {@code "png\\"}로 읽어 거부(400).</li>
	 * </ul>
	 * 즉 알고리즘 선택은 200/400을 실제로 가른다. Node 서버가 도는 곳이 win32이므로 <b>win32를 이식</b>한다
	 * (리눅스 배포에서 Node가 posix로 갈리는 것은 Node 쪽 플랫폼 의존이며 이식 대상이 아니다 — 기록만 한다).
	 */
	@Test
	void theWin32AlgorithmIsTheOneNodeRunsAndPosixWouldDecideDifferently() {
		assertEquals("", UploadNames.extname("C:.png"), "드라이브 루트 접두를 건너뛰지 않았다(posix 알고리즘이다)");
		assertEquals("", UploadNames.acceptedExtension("C:.png"));
		assertEquals("", UploadNames.acceptedExtension("z:.txt"));
		assertEquals(".png", UploadNames.extname("a.png\\"), "후행 백슬래시를 구분자로 보지 않았다(posix 알고리즘이다)");
		assertEquals("png", UploadNames.acceptedExtension("a.png\\"));
		// 드라이브 문자 자리에 문자가 아닌 것이 오면 접두가 아니다 — 그때는 앞에서부터 전부 본다.
		assertEquals(".png", UploadNames.extname("1:.png"));
		assertEquals("png", UploadNames.acceptedExtension("1:.png"));
	}

	/** 확장자 판정에 쓰인 사용자 파일명 조각이 결과에 남지 않는다(저장명은 서버가 발급한다). */
	@Test
	void theAcceptedExtensionNeverCarriesAPathFragment() {
		for (String hostile : List.of("/uploads/../secret.png", "..\\..\\..\\news.db.png", "C:/windows/a.png",
				"\\\\server\\share\\a.png", "https://evil/a.png")) {
			String accepted = UploadNames.acceptedExtension(hostile);

			assertEquals("png", accepted, describe(hostile));
			assertFalse(accepted.contains("/"), "확장자에 경로 구분자가 남았다: " + accepted);
			assertFalse(accepted.contains("\\"), "확장자에 경로 구분자가 남았다: " + accepted);
			assertFalse(accepted.contains("."), "확장자에 점이 남았다: " + accepted);
		}
	}

	/** 실패 메시지에 제어문자를 그대로 흘리지 않는다(터미널·리포트가 깨진다). */
	private static String describe(String filename) {
		if (filename == null) {
			return "null";
		}
		StringBuilder out = new StringBuilder("\"");
		for (int i = 0; i < filename.length(); i++) {
			char c = filename.charAt(i);
			if (c < 0x20 || c > 0x7e) {
				out.append(String.format("\\u%04x", (int) c));
			}
			else {
				out.append(c);
			}
		}
		return out.append('"').toString();
	}

}
