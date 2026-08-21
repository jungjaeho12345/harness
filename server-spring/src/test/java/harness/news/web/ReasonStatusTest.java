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
	void articleRoutesReachNotFoundAndNotHolder() {
		// step7의 기사 단건 3라우트가 실제로 내는 두 토큰이다(그 전에는 표에 없었다).
		// 404·403이 폴백 400으로 새면 "존재 검사가 잠금 검사보다 먼저"라는 계약이 상태코드에서 사라진다.
		assertEquals(404, ReasonStatus.of("not-found"));
		assertEquals(403, ReasonStatus.of("not-holder"));
	}

	@Test
	void lockRoutesReachLockedAndNotDps() {
		// step8의 잠금 3라우트가 내는 토큰이다. 편집 잠금 충돌은 401이고 423·409가 아니다
		// (docs/api-contract/README.md 드리프트 원장 3번 — 코드 주석의 409 언급이 틀렸다).
		assertEquals(401, ReasonStatus.of("locked"));
		// not-dps는 lock 라우트가 '통과'로 해석해 응답이 되지 않지만, 전역 표(server/index.js
		// STATUS_BY_REASON 328행)에 있는 매핑이라 표 자체의 패리티로 옮긴다 — 통과 처리가 깨졌을 때
		// 폴백 400이 아니라 403으로 드러나는 것이 정본 동형이다(reason-tokens.md 표 1 #6).
		assertEquals(403, ReasonStatus.of("not-dps"));
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
		assertEquals(401, ReasonStatus.of("locked"),
				"같은 토큰이 라우트마다 다른 상태를 갖는다 — 전역(편집 잠금 충돌)은 401이고 "
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
