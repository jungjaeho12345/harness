package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * 사유 토큰 → HTTP 상태 매핑({@code docs/api-contract/reason-tokens.md} 표 1·표 2).
 *
 * <p>이 phase에서 <b>도달 가능한 토큰만</b> 표에 넣는다 — 도달하지 않는 토큰을 미리 옮겨 적으면
 * 검증되지 않은 매핑이 쌓이고, 나중에 그 라우트를 구현할 때 "이미 맞다"는 착시를 준다.
 * 미정의 토큰의 폴백은 400이다(Node {@code fail(res, result, fallback=400)}).
 *
 * <p>로그인 라우트만 <b>로컬 매핑</b>을 갖는다: {@code locked}는 전역 401이 아니라 <b>423</b>이고,
 * 미정의 토큰 폴백도 400이 아니라 401이다({@code fail(res, r, 401)}).
 */
class ReasonStatusTest {

	@Test
	void globalTableCoversTheTokensThisPhaseCanReach() {
		assertEquals(401, ReasonStatus.of("unauthenticated"));
		assertEquals(401, ReasonStatus.of("invalid-credentials"));
		assertEquals(403, ReasonStatus.of("inactive"));
		assertEquals(403, ReasonStatus.of("forbidden"));
	}

	@Test
	void unknownTokenFallsBackTo400() {
		assertEquals(400, ReasonStatus.of("이런-토큰은-없다"));
		assertEquals(400, ReasonStatus.of(null));
	}

	@Test
	void loginOverridesLockedWith423() {
		assertEquals(423, ReasonStatus.forLogin("locked"),
				"계정 잠금은 로그인 라우트 로컬 매핑이다(전역 locked 401을 덮어쓴다)");
		assertEquals(400, ReasonStatus.of("locked"),
				"전역 locked(편집 잠금 충돌 401)는 이 phase에서 도달하지 않으므로 표에 없다 — "
						+ "로그인 로컬 매핑이 전역 표를 오염시키지 않았다는 사실을 잠근다");
	}

	@Test
	void loginKeepsTheGlobalMappingForItsOtherTokens() {
		assertEquals(401, ReasonStatus.forLogin("invalid-credentials"));
		assertEquals(403, ReasonStatus.forLogin("inactive"));
	}

	@Test
	void loginFallbackIs401Not400() {
		assertEquals(401, ReasonStatus.forLogin("이런-토큰은-없다"));
	}
}
