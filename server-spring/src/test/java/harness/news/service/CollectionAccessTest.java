package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.service.CollectionAccess.Decision;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 수집 인제스트 접근 정책 — 순수 판정({@code server/index.js} 120~126행 {@code isLoopbackHost} ·
 * 1345행 {@code requireCollectionToken} · 1073~1082행 두 라우트의 가드 순서)의 이식 계약.
 *
 * <p>여기서 잠그는 것은 셋이다.
 * <ol>
 *   <li><b>loopback 판정의 정확한 경계</b> — 127.0.0.0/8 <b>점4자리 IP만</b>이다. 좁히면(예:
 *       {@code "127.0.0.1".equals}) {@code 127.0.0.2}로 띄운 로컬 인스턴스의 수집이 죽고, 넓히면(예:
 *       {@code startsWith("127.")}) 호스트명 {@code 127.example.com}이 loopback으로 오판돼
 *       <b>fail-closed 게이트가 개방 쪽으로 틀린다</b>(실제 바인딩은 DNS 결과를 따르므로 보장이 없다).</li>
 *   <li><b>가드 순서</b> — 503(fail-closed) → 401(토큰) → 통과. 비-loopback + 토큰 미설정이면
 *       <b>올바른 토큰 헤더를 들고 와도 503</b>이다(계약 {@code receive-disabled-with-token}).</li>
 *   <li><b>토큰 미설정 서버는 헤더를 읽지 않는다</b> — Node {@code if (required && ...)}의 truthy 판정
 *       그대로다. 빈 문자열은 미설정이고 <b>공백 1칸은 설정됨</b>이다.</li>
 * </ol>
 *
 * <p>토큰 값은 이 테스트 안에서만 쓰는 리터럴이며 실패 메시지에 담지 않는다(자격증명 규율).
 */
class CollectionAccessTest {

	private static final String TOKEN = "access-test-token";

	private static final String WRONG = "access-test-wrong";

	// --- 1. loopback 판정 표 ----------------------------------------------------------------------

	@Test
	void theLoopbackTableIsExactlyNodesIsLoopbackHost() {
		// true — 127.0.0.0/8 점4자리 전체 + 이름·IPv6 3종.
		for (String host : List.of("127.0.0.1", "127.0.0.2", "127.255.255.255", "127.0.0.0",
				"localhost", "::1", "[::1]")) {
			assertTrue(CollectionAccess.isLoopbackHost(host), host + "는 loopback이다");
		}
		// false — 전 인터페이스 바인딩 2종 · 사설 IP · 호스트명 위장 · 자리 부족/초과.
		for (String host : List.of("0.0.0.0", "::", "192.168.0.1", "10.0.0.1", "127.example.com",
				"127.0.0", "127.0.0.1.1", "1270.0.0.1", "example.com", "")) {
			assertFalse(CollectionAccess.isLoopbackHost(host), host + "는 loopback이 아니다");
		}
	}

	@Test
	void aMissingHostIsNotLoopbackBecauseUnknownMeansOpen() {
		// Node: typeof host !== 'string' → false. 모르는 값은 "개방"으로 본다 —
		// 그래야 fail-closed가 열리는 쪽이 아니라 닫히는 쪽으로 틀린다.
		assertFalse(CollectionAccess.isLoopbackHost(null));
	}

	@Test
	void theHostIsTrimmedWithTheJavaScriptWhitespaceSetAndLowercased() {
		// Node: host.trim().toLowerCase(). trim은 NodeString 단일 출처여야 한다 —
		// String.trim()은 NBSP(U+00A0)·U+3000을 걷어내지 못해 같은 설정에서 판정이 갈린다.
		assertTrue(CollectionAccess.isLoopbackHost("  127.0.0.1  "));
		assertTrue(CollectionAccess.isLoopbackHost(" localhost "));
		assertTrue(CollectionAccess.isLoopbackHost("　LOCALHOST"));
		assertTrue(CollectionAccess.isLoopbackHost("LocalHost"));
		assertFalse(CollectionAccess.isLoopbackHost("   "), "공백뿐이면 빈 값이고 빈 값은 loopback이 아니다");
	}

	// --- 2. decide 3분기 -------------------------------------------------------------------------

	@Test
	void loopbackWithoutATokenLetsEveryRequestThroughIncludingBogusHeaders() {
		// minimal 프로파일 = 방어가 "loopback 바인딩" 하나다. 헤더는 읽지도 않는다.
		assertEquals(Decision.ALLOWED, CollectionAccess.decide("127.0.0.1", null, null));
		assertEquals(Decision.ALLOWED, CollectionAccess.decide("127.0.0.1", "", null));
		assertEquals(Decision.ALLOWED, CollectionAccess.decide("127.0.0.1", "", WRONG));
		assertEquals(Decision.ALLOWED, CollectionAccess.decide("localhost", null, WRONG));
	}

	@Test
	void aConfiguredTokenIsCheckedAndOnlyTheExactValuePasses() {
		assertEquals(Decision.UNAUTHENTICATED, CollectionAccess.decide("127.0.0.1", TOKEN, null));
		assertEquals(Decision.UNAUTHENTICATED, CollectionAccess.decide("127.0.0.1", TOKEN, ""));
		assertEquals(Decision.UNAUTHENTICATED, CollectionAccess.decide("127.0.0.1", TOKEN, WRONG));
		assertEquals(Decision.UNAUTHENTICATED, CollectionAccess.decide("127.0.0.1", TOKEN, TOKEN + " "));
		assertEquals(Decision.UNAUTHENTICATED, CollectionAccess.decide("127.0.0.1", TOKEN, TOKEN.toUpperCase()));
		assertEquals(Decision.ALLOWED, CollectionAccess.decide("127.0.0.1", TOKEN, TOKEN));
		// 비-loopback이어도 토큰이 설정돼 있으면 정상 인증 경로다(503이 아니다).
		assertEquals(Decision.ALLOWED, CollectionAccess.decide("0.0.0.0", TOKEN, TOKEN));
		assertEquals(Decision.UNAUTHENTICATED, CollectionAccess.decide("0.0.0.0", TOKEN, null));
	}

	@Test
	void aSingleSpaceIsAConfiguredTokenBecauseNodeOnlyChecksTruthiness() {
		// Node: `const required = process.env.COLLECTION_TOKEN; if (required && ...)`.
		// ' '는 truthy다 — 서버가 토큰 값을 다듬으면(trim) 클라이언트와 조용히 갈린다.
		assertEquals(Decision.ALLOWED, CollectionAccess.decide("127.0.0.1", " ", " "));
		assertEquals(Decision.UNAUTHENTICATED, CollectionAccess.decide("127.0.0.1", " ", ""));
		assertEquals(Decision.UNAUTHENTICATED, CollectionAccess.decide("127.0.0.1", " ", null));
	}

	// --- 3. 가드 순서(계약이 관측하는 축) -----------------------------------------------------------

	@Test
	void failClosedOutranksTheTokenGuardEvenWhenAValidLookingHeaderIsPresent() {
		// failclosed 프로파일: 비-loopback + 토큰 미설정. 토큰 검사를 앞에 두면 여기가 401이 되고
		// 계약 receive-disabled-with-token이 red가 된다.
		for (String header : new String[] { null, "", TOKEN, WRONG }) {
			assertEquals(Decision.DISABLED, CollectionAccess.decide("0.0.0.0", null, header),
					"비-loopback + 토큰 미설정은 헤더와 무관하게 503이다");
			assertEquals(Decision.DISABLED, CollectionAccess.decide("0.0.0.0", "", header));
		}
		assertEquals(Decision.DISABLED, CollectionAccess.decide("192.168.0.7", null, TOKEN));
		assertEquals(Decision.DISABLED, CollectionAccess.decide("::", "", TOKEN));
	}

	// --- 4. 반복 헤더는 Node처럼 합쳐서 본다 --------------------------------------------------------

	/**
	 * express({@code req.get})는 반복 헤더를 Node http 파서가 만든 <b>{@code ", "} 결합 문자열</b>로
	 * 준다(2026-08-25 실측: {@code x-collection-token: GOOD} 두 줄 → {@code "GOOD, GOOD"}). 그래서
	 * 반복 헤더는 <b>값이 옳든 그르든 항상 불일치</b>다. Spring {@code getHeader}는 첫 값만 주므로
	 * 순진한 구현은 "첫 값이 옳으면 통과"로 갈린다.
	 */
	@Test
	void repeatedHeaderValuesAreJoinedTheWayNodesParserJoinsThem() {
		assertNull(CollectionAccess.headerToken(null), "헤더 부재는 null이다(빈 문자열이 아니다)");
		assertNull(CollectionAccess.headerToken(List.of()));
		assertEquals(TOKEN, CollectionAccess.headerToken(List.of(TOKEN)));
		assertEquals(TOKEN + ", " + WRONG, CollectionAccess.headerToken(List.of(TOKEN, WRONG)));
		assertEquals(WRONG + ", " + TOKEN, CollectionAccess.headerToken(List.of(WRONG, TOKEN)));
		assertEquals(TOKEN + ", " + TOKEN, CollectionAccess.headerToken(List.of(TOKEN, TOKEN)));
	}

	@Test
	void aRepeatedHeaderNeverAuthenticatesEvenWhenOneOfTheValuesIsCorrect() {
		assertEquals(Decision.UNAUTHENTICATED,
				CollectionAccess.decide("127.0.0.1", TOKEN, CollectionAccess.headerToken(List.of(TOKEN, WRONG))));
		assertEquals(Decision.UNAUTHENTICATED,
				CollectionAccess.decide("127.0.0.1", TOKEN, CollectionAccess.headerToken(List.of(WRONG, TOKEN))));
		assertEquals(Decision.UNAUTHENTICATED,
				CollectionAccess.decide("127.0.0.1", TOKEN, CollectionAccess.headerToken(List.of(TOKEN, TOKEN))),
				"같은 값을 두 번 보내도 Node는 결합 문자열이라 불일치다");
	}
}
