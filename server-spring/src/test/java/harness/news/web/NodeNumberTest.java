package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Locale;
import org.junit.jupiter.api.Test;

/**
 * 경로 파라미터의 <b>정수 판정</b> — Node의 {@code Number(raw)} + {@code Number.isInteger(...)} 의미론.
 *
 * <p>이 판정이 쓰이는 곳은 {@code GET /api/articles/:id/history/:historyId} 하나이고, 정본은
 * {@code const historyId = Number(req.params.historyId); if (!Number.isInteger(historyId)) 404} 다.
 * 그래서 <b>Java의 파싱 관용을 쓰면 안 된다</b>: {@code Long.parseLong}은 {@code "1.0"}·{@code "1e0"}·
 * {@code "0x1"}·{@code " 1"}을 전부 거부하는데 Node는 그 넷을 모두 <b>같은 정수</b>로 읽어 이력 행에
 * 도달한다(같은 URL이 한 서버에서 200, 다른 서버에서 404 = 패리티 파손). 반대로
 * {@code Double.parseDouble}을 그대로 쓰면 Java 전용 표기({@code "1d"}·{@code "0x1p3"})까지 받아들여
 * Node가 404를 주는 URL에 Spring만 200을 준다.
 *
 * <p>계약은 {@code 'abc'}·{@code '1.5'}만 관측한다(index.json forward_notes (4)⑥이 비십진 표기를
 * 미검증으로 남겼다) — 이 테스트가 그 공백을 닫는다.
 *
 * <p>값 판독({@link NodeNumber#toNumber})도 여기서 잠근다. 그 자리는 <b>행 매칭 키</b>를 만든다
 * ({@code DELETE /api/receiver-config/:id} · {@code PUT /api/distribution-targets/:id}) — 판정이 Node보다
 * 관대하면 {@code /5d}가 <b>행을 지운다</b>(2026-08-24 리뷰 high-1: 로컬 재구현 2벌이 실제로 그랬다).
 */
class NodeNumberTest {

	@Test
	void plainDecimalIntegersParse() {
		assertEquals(1L, NodeNumber.integerOf("1"));
		assertEquals(0L, NodeNumber.integerOf("0"));
		assertEquals(2147483646L, NodeNumber.integerOf("2147483646"));
		assertEquals(-7L, NodeNumber.integerOf("-7"));
		assertEquals(7L, NodeNumber.integerOf("+7"));
		assertEquals(2L, NodeNumber.integerOf("02"), "선행 0은 8진수가 아니라 10진수다");
	}

	@Test
	void theSpellingsNodeAlsoReadsAsThatIntegerParse() {
		// 아래 표기는 전부 Number(...)가 2를 돌려주고 Number.isInteger가 참이다.
		for (String spelling : List.of("2.0", "2.", "2e0", "0.2e1", "20e-1", "0x2", "0X2", "0b10", "0o2", " 2", "2 ",
				"\t2\n")) {
			assertEquals(2L, NodeNumber.integerOf(spelling), spelling + "은(는) Node에서 정수 2다");
		}
	}

	@Test
	void anEmptyOrBlankStringIsZeroJustLikeNode() {
		// Number('') === 0 이다(NaN이 아니다). 관측 결과는 어차피 "id 0인 행이 없다"지만, 판정식이
		// Node와 갈리면 다음에 이 헬퍼를 쓰는 자리에서 차이가 드러난다.
		assertEquals(0L, NodeNumber.integerOf(""));
		assertEquals(0L, NodeNumber.integerOf("   "));
	}

	@Test
	void nonIntegersAndNonNumbersAreRejected() {
		for (String spelling : List.of("abc", "1.5", "1.5e0", "1_0", "0b12", "0x", "1n", "NaN", "Infinity",
				"-Infinity", "1,2", "1 2", "١")) {
			assertNull(NodeNumber.integerOf(spelling), spelling + "은(는) 정수가 아니다");
		}
		assertNull(NodeNumber.integerOf(null), "null 입력은 정수가 아니다");
	}

	@Test
	void javaOnlySpellingsAreRejectedToo() {
		// Double.parseDouble이 받아들이지만 Node의 Number(...)는 NaN을 주는 표기들.
		for (String spelling : List.of("1d", "1D", "1f", "1F", "0x1p3", "+ 1")) {
			assertNull(NodeNumber.integerOf(spelling), spelling + "은(는) Java 전용 표기다 — Node는 NaN이다");
		}
	}

	@Test
	void integersOutsideTheLongRangeDoNotResolveToARow() {
		// Node는 Number.isInteger(1e30)을 참으로 보고 그 값으로 조회한다 — 그런 id를 가진 행은 없으므로
		// 관측 가능한 결과는 "행 없음"이다. Java에서도 같은 결과가 되게 null을 돌려준다.
		assertNull(NodeNumber.integerOf("1e30"));
		assertNull(NodeNumber.integerOf("-1e30"));
		assertNull(NodeNumber.integerOf("1e1000"), "Infinity는 정수가 아니다");
	}

	// --- ToNumber(값) — 행 매칭 키를 만드는 자리가 쓴다 --------------------------------------------

	/**
	 * <b>Java 전용 표기는 값이 아니라 {@code NaN}이다.</b> {@code Double.parseDouble}은 이 넷을 전부
	 * 받아들이는데, 그 관용이 {@code DELETE /api/receiver-config/5d}를 <b>id 5 행 삭제</b>로 만들었다
	 * (Node는 changes:0 — 2026-08-24 리뷰 high-1 실측). 행 삭제가 허용된 유일한 테이블이라 이 축이
	 * 데이터 손실 경로다.
	 */
	@Test
	void javaOnlySpellingsAreNotValuesEither() {
		for (String spelling : List.of("5d", "5D", "5f", "5F", "0x1p3", "0X1P3", "+ 1", "1_0", "abc")) {
			assertTrue(Double.isNaN(NodeNumber.toNumber(spelling)), spelling + "은(는) Node에서 NaN이다");
		}
		assertTrue(Double.isNaN(NodeNumber.toNumber(null)), "null 입력도 NaN이다");
	}

	/** 반대로 <b>Node가 값으로 읽는</b> 표기는 그 값이어야 한다 — 진법 접두는 {@code parseDouble}이 거부한다. */
	@Test
	void thePrefixedRadixLiteralsHaveTheirNodeValue() {
		assertEquals(16.0, NodeNumber.toNumber("0x10"));
		assertEquals(5.0, NodeNumber.toNumber("0b101"));
		assertEquals(15.0, NodeNumber.toNumber("0o17"));
		assertEquals(255.0, NodeNumber.toNumber("0XFF"));
		assertEquals(1.5, NodeNumber.toNumber("1.5"), "소수도 값이다(정수 판정은 integerOf의 몫)");
		assertEquals(0.0, NodeNumber.toNumber(""), "Number('') === 0");
		assertEquals(0.0, NodeNumber.toNumber("   "), "공백만도 0이다");
	}

	/**
	 * JS 공백은 {@code String.trim()}이 걷어내는 집합보다 넓다 — NBSP({@code U+00A0})·BOM({@code U+FEFF})·
	 * 줄 구분자({@code U+2028})가 그렇다. {@code trim()}을 쓰면 Node가 지우는 행을 Spring만 남긴다.
	 */
	@Test
	void jsWhitespaceIsStrippedIncludingTheOnesJavaTrimMisses() {
		// 0x00A0 NBSP · 0xFEFF BOM · 0x2028 LINE SEPARATOR · 0x3000 IDEOGRAPHIC SPACE는 String.trim()이
		// 걷어내지 못한다(0x20 SPACE · 0x09 TAB은 걷어낸다 — 대조군). 소스에는 코드포인트로만 쓴다:
		// 보이지 않는 문자를 리터럴로 박으면 diff에서 사라진다.
		for (int codePoint : new int[] {0x00A0, 0xFEFF, 0x2028, 0x3000, 0x0020, 0x0009}) {
			String pad = Character.toString(codePoint);
			String label = "U+" + Integer.toHexString(codePoint).toUpperCase(Locale.ROOT);
			assertEquals(5.0, NodeNumber.toNumber(pad + "5"), "선행 공백 " + label);
			assertEquals(5.0, NodeNumber.toNumber("5" + pad), "후행 공백 " + label);
			assertEquals(5L, NodeNumber.integerOf(pad + "5"), "정수 판정도 같은 공백 집합을 본다 " + label);
		}
	}

	/**
	 * 의도된 단 하나의 접기 — <b>{@code 'Infinity'} 키워드</b>는 문법 게이트에서 걸려 {@code NaN}이다
	 * (Node는 ±Infinity). 두 값 모두 정수가 아니고 어떤 정수 id와도 같지 않아 <b>관측 결과가 같다</b>
	 * (행 없음). 십진 표기의 오버플로({@code 1e400})는 게이트를 통과하므로 Node와 <b>같이</b> ±Infinity다.
	 */
	@Test
	void theInfinityKeywordIsFoldedToNanBecauseNeitherEverMatchesARow() {
		for (String spelling : List.of("Infinity", "-Infinity", "+Infinity")) {
			assertTrue(Double.isNaN(NodeNumber.toNumber(spelling)), spelling);
			assertNull(NodeNumber.integerOf(spelling), spelling + "은(는) 정수가 아니다");
		}
		assertTrue(Double.isInfinite(NodeNumber.toNumber("1e400")), "십진 오버플로는 Node와 같이 무한대다");
		assertNull(NodeNumber.integerOf("1e400"), "무한대는 정수가 아니다 — 어떤 행에도 닿지 않는다");
	}

	@Test
	void theBoundaryValuesOfLongParse() {
		// 2^53 이상은 Node에서도 정확도가 없지만 정수 판정은 통과한다 — 경계에서 예외가 아니라 값이어야 한다.
		assertEquals(9007199254740992L, NodeNumber.integerOf("9007199254740992"));
		assertEquals(-9007199254740992L, NodeNumber.integerOf("-9007199254740992"));
	}

}
