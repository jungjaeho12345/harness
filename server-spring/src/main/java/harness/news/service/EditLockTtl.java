package harness.news.service;

import java.time.Clock;

/**
 * 편집 잠금의 stale 판정 — 리포 루트 {@code src/services/articleService.js} 15행·57~62행의 이식.
 *
 * <p>30분 동안 갱신되지 않은 잠금은 stale이고, 다음 시도자가 가져갈 수 있다(브라우저가 닫혀 잠금이
 * 영원히 남는 것을 막는 유일한 장치다). 잠금 시각이 <b>없거나 읽을 수 없으면 stale</b>이다 — 모르는
 * 잠금을 유효하다고 보면 그 기사는 아무도 편집할 수 없게 된다.
 *
 * <p>시각은 주입된 {@link Clock}에서만 읽는다(ADR-013). 계약 스위트는 시계를 주입할 수 없어 이 축을
 * 관측하지 못하므로, TTL 경계의 게이트는 이 클래스의 단위 테스트가 전부다.
 */
public final class EditLockTtl {

	/** 30분. 값을 바꾸면 편집 충돌의 체감이 통째로 달라진다(Node와 같은 값이어야 한다). */
	public static final long TTL_MS = 30L * 60L * 1000L;

	/**
	 * @param lockedAt 저장된 잠금 시각 문자열(ISO-8601 UTC). 비어 있거나 파싱 불가면 stale이다.
	 * @param clock 주입된 시계
	 */
	public static boolean isStale(Object lockedAt, Clock clock) {
		Long at = Iso8601.parseMillis(lockedAt);
		if (at == null) {
			return true;
		}
		// 초과(>)일 때만 stale이다 — 정각은 아직 유효하다(Node 61행과 같은 비교).
		return (clock.millis() - at) > TTL_MS;
	}

	private EditLockTtl() {
	}
}
