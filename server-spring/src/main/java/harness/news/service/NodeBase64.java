package harness.news.service;

import java.util.Arrays;

/**
 * base64 디코드의 <b>Node 의미론</b> — {@code Buffer.from(raw, 'base64')}.
 *
 * <p>이 자리에는 {@link java.util.Base64}의 세 디코더가 <b>하나도 쓸 수 없다</b>. Node의 디코더는
 * 관대하고 <b>절대 던지지 않는</b> 반면 Java의 것들은 엄격하게 던지거나 다른 알파벳을 쓴다:
 * <ul>
 *   <li>{@code Base64.getDecoder()}는 {@code "!!!"}·{@code "QU FB"}·{@code "-_"}·{@code "QU=FB"}·
 *       {@code "Q"}에서 전부 {@code IllegalArgumentException}을 던진다. 그 예외는 전역 핸들러를 타고
 *       <b>500 {@code internal-error}</b>가 되는데, Node는 같은 요청에 0바이트(혹은 부분) 파일을 쓰고
 *       <b>200</b>을 준다({@code POST /api/upload}의 실측 divergence다).</li>
 *   <li>{@code Base64.getMimeDecoder()}는 알파벳 밖 문자를 건너뛰지만 {@code '-'}·{@code '_'}를
 *       <b>버린다</b>({@code "-_"} → 0바이트 / Node → {@code 0xfb}). {@code '='} 뒤에 데이터가 오면
 *       역시 던진다.</li>
 *   <li>{@code Base64.getUrlDecoder()}는 반대로 {@code '+'}·{@code '/'}에서 던진다({@code "++//"}).</li>
 * </ul>
 *
 * <p>Node의 실제 규칙은 셋이다(v24.16.0 실측 + {@code nbytes} {@code base64_decode} 대조):
 * <ol>
 *   <li>UTF-16 <b>코드유닛마다 하위 1바이트로 절단</b>해 표를 찾는다({@code static_cast<uint8_t>}).
 *       그래서 전각 {@code 'Ｑ'}(U+FF31)는 건너뛰어지지 않고 {@code '1'}(0x31)로 <b>읽히고</b>,
 *       이모지의 상위 서러게이트 U+D83D는 하위바이트가 0x3D라 {@code '='}로 읽혀 <b>디코드를
 *       끝낸다</b>. 코드포인트가 아니라 코드유닛 단위다.</li>
 *   <li>표는 base64와 base64url을 <b>한 벌</b>로 갖는다 — {@code '+'}와 {@code '-'}가 62,
 *       {@code '/'}와 {@code '_'}가 63이다. 그 밖의 코드는 <b>건너뛴다</b>(거부가 아니다).</li>
 *   <li>{@code '='}는 패딩 검증이 아니라 <b>종료 신호</b>다 — 위치와 개수를 따지지 않고 그 앞까지만
 *       디코드한다({@code "QQ==QQ=="} → 1바이트).</li>
 * </ol>
 * 마지막 그룹의 잔여 비트는 <b>바이트 경계까지만</b> 취한다(6비트만 남으면 0바이트).
 *
 * <p><b>이 정책의 사본을 만들지 마라.</b> {@link NodeString}(공백)·{@code harness.news.web.NodeNumber}
 * (수)와 같은 지위의 <b>단일 출처</b>다. 업로드 서비스 안에 인라인으로 재구현하면 한쪽만 고쳐지고 그
 * 어긋남은 계약이 관측하지 않는 축이라 조용히 산다 — 실제로 그랬다(2026-08-24 리뷰 high-1:
 * {@code Number()} 로컬 재구현 2벌이 Node가 안 지우는 행을 지웠다).
 *
 * <p>정규식으로 입력을 사전 검증해 거부하지도 마라. Node는 어떤 문자열도 받아 무언가를 돌려주므로
 * 거부를 더하는 순간 200이 400이 된다.
 */
public final class NodeBase64 {

	/** 코드(하위바이트) → 6비트 값. 자릿수가 아닌 코드는 {@link #SKIP}, {@code '='}는 {@link #STOP}. */
	private static final byte[] DIGIT = new byte[256];

	/** 알파벳 밖 — 건너뛴다. */
	private static final byte SKIP = -1;

	/** {@code '='} — 디코드를 끝낸다. */
	private static final byte STOP = -2;

	static {
		Arrays.fill(DIGIT, SKIP);
		String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		for (int i = 0; i < alphabet.length(); i++) {
			DIGIT[alphabet.charAt(i)] = (byte) i;
		}
		DIGIT['-'] = 62; // base64url 별칭 — Node의 표는 두 알파벳을 함께 갖는다.
		DIGIT['_'] = 63;
		DIGIT['='] = STOP;
	}

	private NodeBase64() {
	}

	/**
	 * {@code Buffer.from(raw, 'base64')}의 바이트.
	 *
	 * @param raw 원문. {@code null}이면 길이 0(호출자가 부재를 이미 판정한다).
	 * @return 디코드된 바이트. <b>어떤 입력에도 예외를 던지지 않는다</b> — 던지면 400이어야 할 요청이
	 *     500이 된다.
	 */
	public static byte[] decode(String raw) {
		if (raw == null) {
			return new byte[0];
		}
		byte[] out = new byte[raw.length() / 4 * 3 + 3];
		int written = 0;
		int accumulator = 0;
		int bits = 0;
		for (int i = 0; i < raw.length(); i++) {
			byte digit = DIGIT[raw.charAt(i) & 0xFF]; // 코드유닛을 하위 1바이트로 절단한다.
			if (digit == STOP) {
				break;
			}
			if (digit == SKIP) {
				continue;
			}
			accumulator = (accumulator << 6) | digit;
			bits += 6;
			if (bits >= 8) {
				bits -= 8;
				out[written++] = (byte) (accumulator >>> bits);
			}
		}
		byte[] exact = new byte[written];
		System.arraycopy(out, 0, exact, 0, written);
		return exact;
	}

}
