package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
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

	@Test
	void theBoundaryValuesOfLongParse() {
		// 2^53 이상은 Node에서도 정확도가 없지만 정수 판정은 통과한다 — 경계에서 예외가 아니라 값이어야 한다.
		assertEquals(9007199254740992L, NodeNumber.integerOf("9007199254740992"));
		assertEquals(-9007199254740992L, NodeNumber.integerOf("-9007199254740992"));
	}

}
