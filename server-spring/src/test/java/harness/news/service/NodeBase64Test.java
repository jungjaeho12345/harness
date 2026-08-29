package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.jupiter.api.Test;

/**
 * {@link NodeBase64#decode(String)}가 Node {@code Buffer.from(s,'base64')}와 <b>바이트까지 같은가</b>.
 *
 * <p>기대값은 전부 <b>Node v24.16.0 실측</b>이다(리포 밖 스크래치패드에서 입력마다
 * {@code Buffer.from(s,'base64').toString('hex')}를 관측). 계획서 step1.md의 표를 그대로 옮긴 것이
 * 아니라 <b>재측정한 표</b>이며, 재측정에서 계획서 모델의 오류 하나가 드러났다 — 아래
 * {@link #everyCodeUnitIsMaskedToItsLowByteJustLikeNode()}가 그 축이다.
 *
 * <p>이 표가 <b>유일 방어선</b>이다: 계약 케이스는 {@code content-missing}·{@code content-not-string}
 * 둘뿐이라 디코드 관대성을 하나도 관측하지 않는다. 그런데 이 축의 차이는 곧 <b>200 대 500</b>이다 —
 * {@code POST /api/upload {filename:'a.png', contentBase64:'!!!'}}는 Node에서 0바이트 파일을 쓰고 200을
 * 주는데, {@code Base64.getDecoder()}는 {@code IllegalArgumentException}을 던져 전역 핸들러가
 * 500 {@code internal-error}로 만든다.
 */
class NodeBase64Test {

	/** 표에 적힌 hex와 실제 디코드 결과를 맞춘다. */
	private static void assertDecodes(String input, String expectedHex, String why) {
		assertEquals(expectedHex, HexFormat.of().formatHex(NodeBase64.decode(input)), why);
	}

	/** 보이지 않는 문자는 소스에 심지 않는다 — 전부 코드유닛으로 만든다. */
	private static String ch(int codeUnit) {
		return String.valueOf((char) codeUnit);
	}

	/** {@code "0051 0055"} 같은 코드유닛 나열을 문자열로 편다. */
	private static String units(String spec) {
		StringBuilder out = new StringBuilder();
		for (String unit : spec.split(" ")) {
			out.append((char) Integer.parseInt(unit, 16));
		}
		return out.toString();
	}

	@Test
	void plainBase64DecodesToTheSameBytesAsNode() {
		assertDecodes("QUFB", "414141", "표준 4자 그룹");
		assertDecodes("QUF", "4141", "3자 그룹 = 2바이트");
		assertDecodes("QU", "41", "2자 그룹 = 1바이트");
		assertDecodes("ab", "69", null);
		assertDecodes("abc", "69b7", null);
		assertDecodes("abcd", "69b71d", null);
		assertDecodes("AAAA", "000000", null);
		assertDecodes("////", "ffffff", null);
		assertDecodes("++++", "fbefbe", null);
		assertDecodes("/w==", "ff", "정상 패딩");
		assertDecodes("iVBORw0KGgo", "89504e470d0a1a0a", "PNG 시그니처 — 패딩 없는 조각");
		assertDecodes("iVBORw0KGgoAAAANSUhEUg==", "89504e470d0a1a0a0000000d49484452", "PNG 머리 24자");
	}

	@Test
	void charactersOutsideTheAlphabetAreSkippedNotRejected() {
		// Node는 어떤 문자열도 받아 '뭔가'를 돌려준다 — 거부가 없다. 그래서 '!!!'가 200이다.
		assertDecodes("!!!", "", "알파벳 밖 문자만 있으면 0바이트다(예외가 아니다)");
		assertDecodes("**", "", null);
		assertDecodes("QU$$FB", "414141", "가운데 쓰레기는 건너뛴다");
		assertDecodes("QU FB", "414141", "공백도 건너뛴다");
		assertDecodes("QU\nFB", "414141", null);
		assertDecodes("QU\tFB", "414141", null);
		assertDecodes("QUFB!QUFB", "414141414141", null);
		assertDecodes("QUFB" + ch(0x00) + "QUFB", "414141414141", "NUL도 그냥 건너뛴다");
		assertDecodes("QUFB\r\nQUFB", "414141414141", null);
		assertDecodes("   QUFB   ", "414141", "앞뒤 공백");
		assertDecodes("\t\r\n QUFB", "414141", null);
		assertDecodes("QUFB" + ch(0x00A0) + "QUFB", "414141414141", "NBSP도 알파벳 밖이다");
	}

	@Test
	void theDataUriPrefixBecomesGarbageBytesInsteadOfARejection() {
		// 정본 주석의 '데이터 URI prefix 없음 가정'이 뜻하는 바 — prefix가 붙어도 거부가 아니라
		// 쓰레기 17바이트가 파일로 저장되고 200이 나간다.
		assertDecodes("data:image/png;base64,QUFB", "75ab5a8a66a07bfa6781b6ac7bae105050", "실측 17바이트");
	}

	@Test
	void base64UrlAliasesDecodeAsSixtyTwoAndSixtyThree() {
		// Node의 디코드 표는 base64와 base64url을 <b>한 표</b>로 갖는다 — 섞여 있어도 읽는다.
		assertDecodes("-_", "fb", "'-'=62 '_'=63");
		assertDecodes("-", "", "1자만 남으면 버린다");
		assertDecodes("_", "", null);
		assertDecodes("_-", "ff", null);
		assertDecodes("----", "fbefbe", "'-'는 '+'와 같은 값이다");
		assertDecodes("____", "ffffff", "'_'는 '/'와 같은 값이다");
		assertDecodes("//++", "ffffbe", null);
		assertDecodes("__--", "ffffbe", "'__--'는 '//++'와 같은 바이트다");
		assertDecodes("+/-_", "fbffbf", "두 알파벳을 한 문자열에서 섞어도 읽는다");
		assertDecodes("QUF-", "41417e", null);
		assertDecodes("QUF_", "41417f", null);
	}

	@Test
	void anEqualsSignEndsTheDecodeWhereverItAppears() {
		// '='는 패딩 검증이 아니라 <b>종료 신호</b>다 — 그 앞까지만 디코드하고 뒤는 통째로 버린다.
		assertDecodes("QU=FB", "41", "'=' 앞의 2자만 읽는다");
		assertDecodes("QQ==QQ==", "41", "두 번째 그룹은 없는 것과 같다");
		assertDecodes("QUFB=QUFB", "414141", null);
		assertDecodes("=QUFB", "", "첫 글자가 '='이면 아무것도 없다");
		assertDecodes("==QUFB", "", null);
		assertDecodes("=", "", null);
		assertDecodes("Q=UFB", "", "'=' 앞에 1자만 있으면 0바이트다");
		assertDecodes("Q===", "", null);
		assertDecodes("QU==", "41", "정상 패딩도 같은 규칙으로 설명된다");
		assertDecodes("QUF=", "4141", null);
		assertDecodes("QUFB=", "414141", null);
		assertDecodes("QUFB==", "414141", null);
		assertDecodes("QUFB====", "414141", "패딩이 넘쳐도 앞의 그룹은 살아 있다");
	}

	@Test
	void leftoverBitsAreTakenOnlyUpToTheByteBoundary() {
		// 유효 자릿수 n에 대해 floor(n*3/4) 바이트. 6비트만 남으면 0바이트다.
		assertDecodes("", "", "빈 문자열");
		assertDecodes("Q", "", "1자 = 6비트 = 0바이트");
		assertDecodes("A", "", null);
		assertDecodes("a", "", null);
		assertDecodes("AB", "00", null);
		assertDecodes("ABC", "0010", null);
		assertDecodes("QUFBQ", "414141", "5자 = 3바이트");
		assertDecodes("QUFBQU", "41414141", "6자 = 4바이트");
		assertDecodes("QUFBQUF", "4141414141", "7자 = 5바이트");

		for (int n = 0; n <= 40; n++) {
			String digits = "A".repeat(n);
			assertEquals(n * 3 / 4, NodeBase64.decode(digits).length, "유효 자릿수 " + n);
		}
	}

	@Test
	void everyCodeUnitIsMaskedToItsLowByteJustLikeNode() {
		// [계획서 정정] step1.md는 '알파벳 밖 코드포인트는 건너뛴다'고 적었지만 Node는 그렇지 않다.
		// Node는 UTF-16 코드유닛을 uint8_t로 <b>절단</b>한 뒤 표를 찾는다(nbytes base64_decode의
		// static_cast<uint8_t>(src[i])). 그래서 U+FF31('Ｑ')은 건너뛰어지는 것이 아니라 0x31('1')로
		// 읽힌다. 실측이 정본이고 계획서 모델은 이 행들에서 틀린다.
		assertDecodes(units("ff31 ff35 ff26 ff22"), "d7", "전각 ＱＵＦＢ → 하위바이트 '1','5','&','\"' → '15' → 1바이트");
		assertDecodes(units("0151 0155 0146 0142"), "414141", "하위바이트가 Q,U,F,B면 'QUFB'와 같다");
		assertDecodes(units("0151 0155 0146 0142 0151 0155 0146 0142"), "414141414141", "0x100 시프트 'QUFBQUFB'");
		assertDecodes("QUFB" + ch(0x0141) + "QUFB", "414141010505", "U+0141의 하위바이트는 'A'다 — 건너뛰지 않는다");
		assertDecodes(units("012b 012f") + "QUFB", "fbf41414", "하위바이트 '+','/'");

		// 하위바이트가 '='(0x3D)인 코드유닛은 <b>종료</b>시킨다 — 서러게이트도 예외가 아니다.
		assertDecodes("QU" + ch(0x013D) + "FB", "41", "U+013D의 하위바이트가 '='라 거기서 끝난다");
		assertDecodes("QU" + ch(0xD83D) + ch(0xDE00) + "FB", "41",
				"이모지의 상위 서러게이트 U+D83D는 하위바이트가 0x3D('=')다 — 코드포인트가 아니라 코드유닛 단위로 읽는다");
		assertDecodes("QUFB" + ch(0xD800) + ch(0xDC00), "414141", "U+10000의 두 서러게이트는 하위바이트가 0x00·0x00이라 건너뛴다");
		assertDecodes("QU" + ch(0xD800) + "FB", "414141", "고아 서러게이트도 예외가 아니다");
		assertDecodes("QU" + ch(0xFF1D) + "FB", "414141", "전각 '＝'의 하위바이트는 0x1D라 종료가 아니다");

		// 실측 표의 비-ASCII 행들 — 하위바이트가 알파벳 밖이라 '건너뛴다'는 설명과 결과가 우연히 같다.
		assertDecodes(ch(0x00C1) + ch(0x00C1), "", null);
		assertDecodes(units("d55c ae00"), "", "'한글' — 하위바이트 0x5C·0x00");
		assertDecodes(units("ff10 ff11 ff12 ff13"), "", "전각 숫자 — 하위바이트 0x10~0x13");
	}

	@Test
	void theDigitTableIsExactlySixtySixCodesAndIsIndexedByTheLowByte() {
		// Node 실측: 0..255 중 base64 자릿수로 읽히는 코드는 정확히 66개이고, 그 목록·값이 아래와 같다.
		Map<Character, Integer> expected = new LinkedHashMap<>();
		String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		for (int i = 0; i < alphabet.length(); i++) {
			expected.put(alphabet.charAt(i), i);
		}
		expected.put('-', 62);
		expected.put('_', 63);
		assertEquals(66, expected.size());

		List<Integer> accepted = new ArrayList<>();
		for (int code = 0; code < 256; code++) {
			byte[] plain = NodeBase64.decode(ch(code) + ch(code));
			byte[] shifted = NodeBase64.decode(ch(code + 0x100) + ch(code + 0x100));
			assertArrayEquals(plain, shifted, "0x100을 더해도 같은 자릿수로 읽힌다(하위바이트 절단)");
			if (plain.length == 1) {
				accepted.add(code);
				int value = expected.getOrDefault((char) code, -1);
				assertEquals(value, (plain[0] >> 2) & 0x3F, "코드 " + code + "의 6비트 값");
			}
		}
		assertEquals(expected.keySet().stream().map(c -> (int) c).sorted().toList(), accepted,
				"자릿수로 읽히는 코드는 정확히 66개다");

		// 종료 문자는 '=' 하나뿐이다(다른 어떤 코드도 디코드를 끊지 않는다).
		List<Integer> terminators = new ArrayList<>();
		for (int code = 0; code < 256; code++) {
			if (NodeBase64.decode("QU" + ch(code) + "FB").length == 1) {
				terminators.add(code);
			}
		}
		assertEquals(List.of(0x3D), terminators, "종료 문자는 '=' 하나뿐이다");
	}

	@Test
	void nullIsAnEmptyArrayBecauseTheCallerAlreadyJudgedAbsence() {
		assertEquals(0, NodeBase64.decode(null).length);
		assertEquals(0, NodeBase64.decode("").length);
	}

	@Test
	void decodeNeverThrowsForAnyInput() {
		// Node는 던지지 않는다. 여기서 던지면 400이어야 할 요청이 500이 된다.
		Random random = new Random(20260828L);
		for (int round = 0; round < 4000; round++) {
			StringBuilder raw = new StringBuilder();
			int length = random.nextInt(24);
			for (int i = 0; i < length; i++) {
				raw.append((char) random.nextInt(0x10000)); // 고아 서러게이트·제어문자 포함
			}
			NodeBase64.decode(raw.toString());
		}
		NodeBase64.decode(ch(0xD800));
		NodeBase64.decode(ch(0xDFFF) + ch(0xD800));
		NodeBase64.decode("=".repeat(1000));
		NodeBase64.decode("Q".repeat(100_000));
	}

	@Test
	void theThreeJavaDecodersAreEachWrongOnAtLeastOneRowOfThisTable() {
		// 이 클래스가 존재하는 이유 — 표준 세 디코더로 갈음할 수 없다는 사실 자체를 단언한다.

		// (1) 엄격 디코더는 <b>던진다</b>. 그 예외가 그대로 500이 된다.
		for (String hostile : List.of("!!!", "QU FB", "-_", "QU=FB", "QQ==QQ==", "=QUFB", "Q", "QUFB=", "QUFB!QUFB")) {
			assertThrows(IllegalArgumentException.class, () -> Base64.getDecoder().decode(hostile),
					hostile + "은(는) 엄격 디코더가 던진다");
			NodeBase64.decode(hostile); // 같은 입력에서 우리는 값을 돌려준다(던지지 않는다).
		}
		assertEquals(0, NodeBase64.decode("!!!").length, "Node는 0바이트 파일을 쓰고 200을 준다");

		// (2) MIME 디코더는 던지지는 않지만 '-_'를 버린다(Node는 base64url로 읽는다).
		assertEquals(0, Base64.getMimeDecoder().decode("-_").length, "MIME 디코더는 '-','_'를 알파벳 밖으로 본다");
		assertDecodes("-_", "fb", "Node는 base64url 별칭을 읽는다");
		assertNotEquals(HexFormat.of().formatHex(Base64.getMimeDecoder().decode("-_")),
				HexFormat.of().formatHex(NodeBase64.decode("-_")));
		assertThrows(IllegalArgumentException.class, () -> Base64.getMimeDecoder().decode("QU=FB"),
				"MIME 디코더도 '=' 뒤에 데이터가 오면 던진다");

		// (3) URL 디코더는 '+'·'/'를 던진다(Node는 읽는다).
		assertThrows(IllegalArgumentException.class, () -> Base64.getUrlDecoder().decode("++//"));
		assertDecodes("++//", "fbefff", null);
	}

	@Test
	void goldenVectorsMeasuredOnNodeAreReproducedByteForByte() {
		// 리포 밖 스크래치패드에서 뽑은 무작위 벡터 40건(코드유닛 hex | Node 디코드 hex).
		// 알파벳·별칭·'='·0x100대 코드유닛·BMP 잡음을 섞어 생성했다.
		for (String vector : List.of(
				"ec05 002b c42c 003d 0021 0251 0063 0030 f761 0039 0062 0063|",
				"002b 0063 7540 8670 01e6|f9ca",
				"005f 91b9 0046|fc",
				"0039 005f 029b 0009 002f|f7ff",
				"3029 0061 022a 0521 002f 0021 002d 9b96 0046 005f 000d 0063 0051 002b|6bff85fdc43e",
				"0108 0030 0260 01fa 0062 0030 002f|d1bd3f",
				"0009 011a|",
				"02be 6790 17fa c136 0020 4b5a 003d 002b 0061 02d6 0030 0062|e9",
				"0055 0110 0063 000d 0020 0063 002b|51c73e",
				"0024 0063 ac5b 002d 0046 0260 6da0 0ae4 003d b167 a9b3|73e1",
				"003d 01c7 002f 000d 026d f692 0031 0062 0046|",
				"bb06 0039 010f 0100 14c8 005f 02b3|f7",
				"0020 002f 6937 003d 0062|ff",
				"0264|",
				"002d 0134|fb",
				"010a 0024 0152 000a 0021 0055|45",
				"0009 fffd 0299 9ccb 0051 6ced 743c 005f 02e3 003d 0055 002f 0021 0020|43",
				"fe69 1ea7 b9d1 64dc|",
				"0021 0188 0031|",
				"a539 021f 0039 002d 0042 02b7 0055 01b8 452c 0220|f7df81",
				"f2ae 0009 000a 03ce 0063 0062 13a9 01ff|71",
				"6ba1 0021 0062 0063|6d",
				"2c00 0217 0024 0121 002b 0020|",
				"01f9 0046 0009 02b6 000d 01a5|",
				"0230 0030 002d 003d 005f 9c42|d34f",
				"0046 0051 0021 d0b4 01d4 029e 0278|150c",
				"9365 e868 0009 01ea 0021 0039 0063 002b 024a|7a1f5cf8",
				"2ce0 0242|",
				"002d 10a0 01b5 0009|",
				"0062 0061 0024 002f 0021 000a 0020 002b 01ed 25bc|6daffe",
				"5b3f 0062 ab23 d5c7 0042 0241|6c10",
				"017c 02c3 8341 01fd 011d 45fe 0225 005f|03",
				"0024 0051 0061 0046 025e 0039 002d 022b|41a17dfb",
				"002b 0024 0055|f9",
				"0042 005f a0a9 005f 003d 002b 025b 0009 003d eb76 1dd3 47d2 0009|07ff",
				"0030 021d 0046 0062 3ed8 002f 0297 005f 002d 0042 f971 0031|d056ffffe06a",
				"003d 002d 000d 0030 9480 39b8 023a 0211 000d|",
				"34cc 005f 02c5 477e 002b 011c 1d56 12ee 003d 0020 005f 0046|ffe5",
				"0046 0031 002b 0e37 0024 018c d0b3 02d6 0009 0055 0051|175fbb51",
				"0031 002b 02ee 0102 0247 01de 0024 002d 0009 02ae 02d9|d7e1be")) {
			String[] parts = vector.split("\\|", -1);
			assertDecodes(units(parts[0]), parts[1], "골든 벡터 " + parts[0]);
		}
	}

}
