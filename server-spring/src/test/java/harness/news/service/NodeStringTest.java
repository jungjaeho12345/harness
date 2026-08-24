package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * {@link NodeString#trim(String)}이 JS {@code String.prototype.trim}과 <b>같은 집합</b>을 걷어내는가.
 *
 * <p>기대값은 전부 Node 실측이다(코드포인트마다 {@code (ch + 'x' + ch).trim() === 'x'} 관측):
 * <ul>
 *   <li>걷힌다: U+0009·U+000A·U+000B·U+000C·U+000D·U+0020 · <b>U+00A0</b> · U+1680 · U+2000 ·
 *       <b>U+2007</b> · U+2028 · U+2029 · <b>U+202F</b> · U+205F · U+3000 · <b>U+FEFF</b></li>
 *   <li>남는다: U+0085(NEL) · U+200B(ZWSP) · <b>U+001C~U+001F</b> · U+0001</li>
 * </ul>
 *
 * <p>굵은 넷이 Java 표준과 갈리는 지점이다 — {@code trim()}은 U+00A0·U+2007·U+202F·U+FEFF를 남기고
 * {@code strip()}은 U+00A0·U+2007·U+202F를 남기면서 U+001C~U+001F를 <b>지운다</b>. 이 테스트는 그
 * 두 관용 어느 쪽으로 되돌려도 red다.
 *
 * <p>보이지 않는 문자는 소스에 심지 않는다 — 전부 코드포인트로 만든다.
 */
class NodeStringTest {

	/** JS가 공백으로 보는 코드포인트(WhiteSpace ∪ LineTerminator). */
	private static final int[] JS_WHITESPACE = { 0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0, 0x1680,
			0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029,
			0x202F, 0x205F, 0x3000, 0xFEFF };

	/** JS가 공백으로 보지 <b>않는</b> 코드포인트 — 둘 중 하나는 Java 표준이 공백으로 착각한다. */
	private static final int[] NOT_JS_WHITESPACE = { 0x0001, 0x001C, 0x001D, 0x001E, 0x001F, 0x0085, 0x180E, 0x200B,
			0x2060, 0x3164 };

	@Test
	void everyJavaScriptWhitespaceCodePointIsStrippedFromBothEnds() {
		for (int cp : JS_WHITESPACE) {
			String pad = ch(cp);
			assertEquals("x", NodeString.trim(pad + "x" + pad), () -> label(pad) + "는 JS 공백이다");
			assertEquals("x", NodeString.trim(pad + pad + pad + "x"), () -> label(pad) + " 연속도 전부 걷힌다");
			assertEquals("", NodeString.trim(pad + pad), () -> label(pad) + "만 있으면 빈 문자열이다");
			assertTrue(NodeString.isWhitespace((char) cp), () -> label(pad) + " 술어");
		}
	}

	@Test
	void codePointsThatAreNotJavaScriptWhitespaceSurvive() {
		for (int cp : NOT_JS_WHITESPACE) {
			String pad = ch(cp);
			assertEquals(pad + "x" + pad, NodeString.trim(pad + "x" + pad), () -> label(pad) + "는 JS 공백이 아니다");
			assertFalse(NodeString.isWhitespace((char) cp), () -> label(pad) + " 술어");
		}
	}

	@Test
	void theTwoJavaIdiomsWouldBothBeWrong() {
		// 이 단언들이 '왜 표준 메서드를 쓰지 않는가'의 증거다 — 술어를 되돌리면 위 두 테스트가 red다.
		String nbsp = ch(0x00A0);
		String fileSeparator = ch(0x001C);

		assertEquals(nbsp + "x" + nbsp, (nbsp + "x" + nbsp).trim(), "Java trim()은 NBSP를 남긴다");
		assertEquals(nbsp + "x" + nbsp, (nbsp + "x" + nbsp).strip(), "Java strip()도 NBSP를 남긴다");
		assertEquals("x", (fileSeparator + "x").strip(), "Java strip()은 U+001C를 지운다 — JS는 지우지 않는다");
		assertEquals("x", NodeString.trim(nbsp + "x" + nbsp), "NodeString은 둘 중 어느 쪽도 아니다");
		assertEquals(fileSeparator + "x", NodeString.trim(fileSeparator + "x"));
	}

	@Test
	void mixedRunsAtBothEndsAreStrippedButTheInteriorIsUntouched() {
		// Node 실측: ' \t ﻿  hello world  ﻿ \n'.trim() === 'hello world'
		String lead = " \t" + ch(0x00A0) + ch(0xFEFF) + ch(0x2007) + ch(0x202F);
		String tail = ch(0x202F) + ch(0x2007) + ch(0xFEFF) + ch(0x00A0) + "\n";

		assertEquals("hello world", NodeString.trim(lead + "hello world" + tail));
		assertEquals("hello" + ch(0x00A0) + "world", NodeString.trim(lead + "hello" + ch(0x00A0) + "world" + tail),
				"가운데 공백은 건드리지 않는다");
	}

	@Test
	void emptyAndNullInputsAreReturnedAsThemselves() {
		assertEquals("", NodeString.trim(""));
		assertEquals("x", NodeString.trim("x"));
		assertNull(NodeString.trim(null), "부재 판정은 호출자 몫이다");
	}

	private static String ch(int codePoint) {
		return String.valueOf((char) codePoint);
	}

	private static String label(String pad) {
		return "U+" + Integer.toHexString(pad.charAt(0)).toUpperCase();
	}

}
