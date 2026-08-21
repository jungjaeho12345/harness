package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * 첨부/자료 파일 참조 정화 — 리포 루트 {@code src/services/fileRef.js}와 동형(규칙 순서까지).
 *
 * <p>거부 기반이다: 허용 목록에 걸리지 않으면 빈 문자열로 무력화한다(ADR-004 심화 방어).
 * 각 분기가 <b>순서대로</b> 걸리는지가 계약이다 — 예를 들어 백슬래시 검사가 https 허용보다 뒤로 가면
 * {@code https://a\evil}이 통과한다.
 */
class FileRefTest {

	/** U+0000 — 소스에 날바이트로 넣지 않는다(파일이 바이너리가 되어 diff를 못 읽는다). */
	private static final String NUL = String.valueOf((char) 0);

	@Test
	void anEmptyValuePassesThroughAsAClear() {
		assertEquals("", FileRef.sanitize(""), "빈값은 정상 클리어(× 버튼)다 — 거부가 아니다");
	}

	@Test
	void controlCharactersAndWhitespaceAreRejected() {
		assertEquals("", FileRef.sanitize("/uploads/a b.png"), "공백(U+0020) 포함은 거부다");
		assertEquals("", FileRef.sanitize("/uploads/\ta.png"));
		assertEquals("", FileRef.sanitize("java\nscript:alert(1)"), "개행으로 스킴을 숨기는 우회를 막는다");
		assertEquals("", FileRef.sanitize("/uploads/a" + NUL + ".png"), "제어문자(U+0000)도 거부다");
		assertEquals("", FileRef.sanitize(" https://cdn.example.com/a.png"), "앞 공백도 거부다(trim하지 않는다)");
	}

	@Test
	void backslashesAreRejected() {
		assertEquals("", FileRef.sanitize("/uploads\\..\\etc\\passwd"), "브라우저가 '/'로 정규화하는 백슬래시는 거부다");
		assertEquals("", FileRef.sanitize("https://cdn.example.com\\evil"));
	}

	@Test
	void protocolRelativeUrlsAreRejected() {
		assertEquals("", FileRef.sanitize("//evil.example.com/a.png"));
	}

	@Test
	void httpsIsAllowedAndReturnedVerbatim() {
		assertEquals("https://cdn.example.com/a.png", FileRef.sanitize("https://cdn.example.com/a.png"));
		assertEquals("HTTPS://cdn.example.com/a.png", FileRef.sanitize("HTTPS://cdn.example.com/a.png"),
				"스킴 판정은 대소문자 무시이고 반환은 원문 그대로다");
	}

	@Test
	void everyOtherSchemeIsRejected() {
		assertEquals("", FileRef.sanitize("javascript:alert(1)"));
		assertEquals("", FileRef.sanitize("data:text/html;base64,PHNjcmlwdD4="));
		assertEquals("", FileRef.sanitize("http://cdn.example.com/a.png"), "평문 http도 거부다");
		assertEquals("", FileRef.sanitize("file:///etc/passwd"));
		assertEquals("", FileRef.sanitize("vbscript:msgbox(1)"));
	}

	@Test
	void relativePathsAreTrustedOnlyUnderUploads() {
		assertEquals("/uploads/2026/a.png", FileRef.sanitize("/uploads/2026/a.png"));
		assertEquals("", FileRef.sanitize("/etc/passwd"));
		assertEquals("", FileRef.sanitize("uploads/a.png"), "앞 슬래시가 없으면 접두가 아니다");
		assertEquals("", FileRef.sanitize("/uploadsevil/a.png"), "접두 검사는 '/uploads/'까지다");
	}

	@Test
	void traversalSegmentsAreRejectedEvenUnderUploads() {
		assertEquals("", FileRef.sanitize("/uploads/../secret.png"));
		assertEquals("", FileRef.sanitize("/uploads/a/../../secret.png"));
		assertEquals("", FileRef.sanitize("/uploads/.."));
		assertEquals("/uploads/..hidden.png", FileRef.sanitize("/uploads/..hidden.png"),
				"'..'로 시작하는 파일명은 세그먼트가 아니다 — 통과한다(Node 동형)");
	}

	@Test
	void nonStringInputsAreStringifiedFirstJustLikeNode() {
		// Node는 String(value)를 먼저 부른다 — null은 "null"이 되고, /uploads/ 접두가 아니라 결국 빈 문자열이다.
		assertEquals("", FileRef.sanitize(null), "null은 '문자열 null'이 되어 접두 검사에서 걸린다");
		assertEquals("", FileRef.sanitize(123));
		assertEquals("", FileRef.sanitize(Boolean.TRUE));
	}
}
