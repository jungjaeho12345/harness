package harness.news.web;

import java.util.Map;

/**
 * 사유 토큰 → HTTP 상태 매핑. 정본은 {@code docs/api-contract/reason-tokens.md}(코드 실측 스냅샷)이고
 * 그 정본의 출처는 {@code server/index.js}의 {@code STATUS_BY_REASON}이다.
 *
 * <h2>이 phase가 옮겨 적는 범위</h2>
 * 전역 표 22종을 전부 옮기지 않는다 — <b>이 phase에서 도달 가능한 토큰만</b> 넣는다. 도달하지 않는
 * 매핑을 미리 적어 두면 검증되지 않은 표가 쌓이고, 나중에 그 라우트를 구현할 때 "이미 맞다"는 착시를 준다
 * (그리고 같은 토큰이 라우트마다 다른 상태를 갖는 경우가 실재한다: {@code locked}는 로그인 423 ·
 * 편집 잠금 충돌 401, {@code invalid-spool-dir}은 400/500). 나머지는 문서에만 남긴다.
 *
 * <p>미정의 토큰의 폴백은 <b>400</b>이다(Node {@code fail(res, result, fallback = 400)}).
 * 로그인 라우트만 폴백이 401이고 {@code locked}를 423으로 덮어쓴다(라우트 로컬 매핑 — 표 2 #1·#2).
 */
public final class ReasonStatus {

	/** 미정의 토큰의 기본 상태(Node fail()의 기본 fallback). */
	public static final int FALLBACK = 400;

	/** 로그인 라우트의 폴백 — 전역 400이 아니다({@code fail(res, r, 401)}). */
	private static final int LOGIN_FALLBACK = 401;

	/** 계정 잠금은 로그인에서만 423이다 — 전역 {@code locked} 401(편집 잠금 충돌)을 덮어쓴다. */
	private static final int LOGIN_LOCKED = 423;

	private static final Map<String, Integer> GLOBAL = Map.ofEntries(
			Map.entry("unauthenticated", 401),
			Map.entry("invalid-credentials", 401),
			// 편집 잠금 충돌(phase 69 step8) — 423도 409도 아니다. 코드 주석의 409 언급은 문서화된
			// 드리프트이고(docs/api-contract/README.md 원장 3번) 계약·기존 backend 테스트가 401을 단언한다.
			Map.entry("locked", 401),
			Map.entry("inactive", 403),
			Map.entry("forbidden", 403),
			// 기사 단건 3라우트(phase 69 step7)가 실제로 내는 두 토큰.
			Map.entry("not-holder", 403),
			// lock 라우트는 not-dps를 '통과'로 해석해 응답으로 만들지 않는다(reason-tokens.md 표 1 #6:
			// 현행 HTTP 도달 경로 없음). 그래도 전역 표(server/index.js 328행)에 있는 행이라 표의 패리티로
			// 옮긴다 — 통과 처리가 깨졌을 때 폴백 400이 아니라 정본과 같은 403으로 드러나야 한다.
			Map.entry("not-dps", 403),
			// 수집 인제스트(phase 71 step5) — 등록되지 않은 sourceId. 전역 표에 <b>이 토큰만</b> 늘린다:
			// collection-disabled는 Node도 라우트에서 직접 503을 쓰고(전역 표에 없다),
			// no-active-api-source·fetch-failed는 계약이 폴백 400을 동결했으므로 넣으면 그 계약이 깨진다.
			Map.entry("unregistered", 403),
			Map.entry("not-found", 404),
			// 생애주기 2라우트(phase 69 step10)가 내는 4토큰. action 라우트는 **폴백이 409**라
			// (정본 fail(res, r, 409)) 아래 forbidden-transition이 없어도 409가 나가지만, 표에 두는 것이
			// 정본 동형이고 derive(폴백 400)에서 같은 토큰이 나올 때도 409를 보장한다.
			Map.entry("forbidden-transition", 409),
			// 마커·어휘 거부는 전역 폴백과 같은 400이다. 값이 같다고 빼면 action 라우트의 409 폴백에
			// 걸려 400이어야 할 거부가 409로 나간다 — 이 표가 그 라우트 폴백을 덮는 유일한 수단이다.
			Map.entry("no-end-marker", 400),
			Map.entry("unknown-action", 400),
			Map.entry("unknown-mode", 400));

	private ReasonStatus() {
	}

	/** 전역 매핑. 미정의는 {@link #FALLBACK}. */
	public static int of(String reason) {
		return of(reason, FALLBACK);
	}

	/** 전역 매핑 + 라우트가 지정한 폴백. */
	public static int of(String reason, int fallback) {
		if (reason == null) {
			return fallback;
		}
		return GLOBAL.getOrDefault(reason, fallback);
	}

	/** 로그인 라우트 로컬 매핑 — {@code locked} 423, 폴백 401. */
	public static int forLogin(String reason) {
		if ("locked".equals(reason)) {
			return LOGIN_LOCKED;
		}
		return of(reason, LOGIN_FALLBACK);
	}
}
