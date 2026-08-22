package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 배부 스풀 하위 폴더명(slug) 검증 — 리포 루트 {@code src/services/spoolDir.js}와 동형(규칙의 단일 출처).
 *
 * <p>계약은 {@link FileRef}와 같은 모양이다: 유효하면 <b>원문 그대로</b> 반환하고, 아니면 빈 문자열이다
 * (throw 없음). 다만 <b>타입 게이트가 반대</b>다 — {@code FileRef}는 {@code String(value)}로 먼저
 * 문자열화하지만 여기서는 강제변환을 하지 않는다. 비문자열을 문자열화하면 {@code "123"}·{@code "true"}·
 * {@code "null"}이 화이트리스트를 통과해 경로 조작 방어가 무력화되기 때문이다(정본 주석의 결함).
 *
 * <p>계약 픽스처는 짧은 ASCII 슬러그만 쓰므로 이 테스트가 64자 경계·유니코드·제어문자·예약 장치명의
 * 유일한 방어선이다(index.json forward_notes (6)③).
 */
class SpoolDirTest {

	/** U+0000 — 소스에 날바이트로 넣지 않는다(파일이 바이너리가 되어 diff를 못 읽는다). */
	private static final String NUL = String.valueOf((char) 0);

	@Test
	void validSlugsAreReturnedVerbatim() {
		// 소문자 영숫자 시작 + [a-z0-9_-], 1~64자. 정규화(소문자화·trim) 없이 바이트 동일하게 돌려준다.
		assertEquals("a", SpoolDir.sanitize("a"));
		assertEquals("0", SpoolDir.sanitize("0"));
		assertEquals("press-1", SpoolDir.sanitize("press-1"));
		assertEquals("news_feed", SpoolDir.sanitize("news_feed"));
		assertEquals("abc-123_xyz", SpoolDir.sanitize("abc-123_xyz"));
		assertEquals("a1b2c3", SpoolDir.sanitize("a1b2c3"));
	}

	@Test
	void theLengthBoundaryIsSixtyFourCharacters() {
		String sixtyFour = "a".repeat(64);
		String sixtyFive = "a".repeat(65);

		assertEquals(sixtyFour, SpoolDir.sanitize(sixtyFour), "64자는 통과한다");
		assertEquals("", SpoolDir.sanitize(sixtyFive), "65자는 거부다");
	}

	@Test
	void uppercaseIsRejectedAndNotLowercased() {
		// 통과 값을 소문자화하지 않는다 — 대문자가 있으면 거부(빈 문자열)이지 보정이 아니다.
		assertEquals("", SpoolDir.sanitize("Press"));
		assertEquals("", SpoolDir.sanitize("ABC"));
		assertEquals("", SpoolDir.sanitize("aBc"));
	}

	@Test
	void mustStartWithALowercaseAlphanumeric() {
		assertEquals("", SpoolDir.sanitize("-abc"), "'-'로 시작은 거부다");
		assertEquals("", SpoolDir.sanitize("_abc"), "'_'로 시작은 거부다");
	}

	@Test
	void pathAndSeparatorCharactersAreRejected() {
		assertEquals("", SpoolDir.sanitize(".."));
		assertEquals("", SpoolDir.sanitize("../etc"));
		assertEquals("", SpoolDir.sanitize("a/b"), "'/' 거부");
		assertEquals("", SpoolDir.sanitize("a\\b"), "'\\' 거부");
		assertEquals("", SpoolDir.sanitize("c:"), "':' 거부");
		assertEquals("", SpoolDir.sanitize("/abs"));
		assertEquals("", SpoolDir.sanitize("a."), "'.' 거부");
	}

	@Test
	void whitespaceControlCharsAndUnicodeAreRejected() {
		assertEquals("", SpoolDir.sanitize("a b"), "공백(U+0020) 거부");
		assertEquals("", SpoolDir.sanitize(" a"), "앞 공백 거부(trim하지 않는다)");
		assertEquals("", SpoolDir.sanitize("a "), "뒤 공백 거부");
		assertEquals("", SpoolDir.sanitize("a" + NUL + "b"), "제어문자(U+0000) 거부");
		assertEquals("", SpoolDir.sanitize("a\tb"), "탭 거부");
		assertEquals("", SpoolDir.sanitize("뉴스"), "유니코드 거부");
		assertEquals("", SpoolDir.sanitize("café"), "유니코드 거부");
		assertEquals("", SpoolDir.sanitize(""), "빈 문자열 거부(최소 1자)");
	}

	@Test
	void windowsReservedDeviceNamesAreRejected() {
		// 그 이름의 디렉토리는 생성 자체가 불가라 배부 실행 phase가 무조건 실패한다.
		for (String reserved : List.of("con", "prn", "aux", "nul",
				"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
				"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9")) {
			assertEquals("", SpoolDir.sanitize(reserved), reserved + "은 예약 장치명이다");
		}
	}

	@Test
	void reservedNamesWithSuffixesArePassedThrough() {
		// 예약 목록은 정확 일치다 — con1·conn·com10은 장치명이 아니라 유효 슬러그다(Node 동형).
		assertEquals("con1", SpoolDir.sanitize("con1"));
		assertEquals("conn", SpoolDir.sanitize("conn"));
		assertEquals("com10", SpoolDir.sanitize("com10"));
		assertEquals("lpt0", SpoolDir.sanitize("lpt0"), "lpt0은 예약 목록에 없다");
		assertEquals("com0", SpoolDir.sanitize("com0"), "com0은 예약 목록에 없다");
	}

	@Test
	void nonStringInputsAreRejectedWithoutCoercion() {
		// 타입 게이트 — String(value) 강제변환이 있으면 "123"·"true"·"null"이 화이트리스트를 통과한다.
		assertEquals("", SpoolDir.sanitize(null), "null은 강제변환 없이 즉시 거부다");
		assertEquals("", SpoolDir.sanitize(123), "정수는 거부다('123'으로 변환하지 않는다)");
		assertEquals("", SpoolDir.sanitize(Boolean.TRUE), "불리언은 거부다('true'로 변환하지 않는다)");
		assertEquals("", SpoolDir.sanitize(Map.of("a", "b")), "맵은 거부다");
		assertEquals("", SpoolDir.sanitize(List.of("a")), "리스트는 거부다");
	}
}
