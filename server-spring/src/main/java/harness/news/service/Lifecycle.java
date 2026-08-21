package harness.news.service;

import java.util.Map;
import java.util.Set;

/**
 * 기사 생애주기 전이 — 리포 루트 {@code src/services/lifecycle.js}의 이식(순수 함수, HTTP·DB 비의존).
 *
 * <p><b>표에 없는 칸은 거부다.</b> {@code docs/news.md} "기사 생애주기"의 전이표를 그대로 옮겼고 임의
 * 확장은 없다. 칸을 하나 늘리는 것은 계약 변경이며 {@code contract/cases/minimal/transitions.contract.js}가
 * 그 표를 동결하고 있다.
 *
 * <p>role은 <b>항상 인자로 받는다</b>. 이 계층은 클라이언트 role을 검증하지 않는다 — acting role을
 * 검증된 세션에서 도출하는 것은 컨트롤러의 책임이다(ADR-004).
 *
 * <p>표는 둘뿐이다: 데스크(D)와 관리자(Z)가 <b>같은 표</b>를 쓰고, 기자(R)는 {@code RDS}만 다룬다.
 * {@link #initialStatus(String, String)}도 별도 표를 두지 않고 이 표를 재사용한다(단일 진실 — 표가
 * 두 벌이 되면 최초 저장의 보류와 편집 컨텍스트의 보류가 조용히 갈라진다).
 */
public final class Lifecycle {

	/** 정의된 action 어휘. 이 밖의 값(누락 포함)은 {@code unknown-action}이다. */
	private static final Set<String> ACTIONS = Set.of("send", "hold", "kill", "approveDelete");

	/**
	 * 데스크(D)·관리자(Z) 전이표 — 12칸.
	 *
	 * <p>{@code DPS}는 재송고만 있고 곧바로 kill 할 수 없다. {@code DDH}는 이미 보류라 hold가 없다.
	 * {@code DES}(엠바고 배부 전 대기)와 {@code EPS}(엠바고 배부 진행)는 kill·hold뿐이다 — 재송고는
	 * 미정의이며, {@code EPS}발 2칸은 실제 배부가 있어야 도달하므로 계약 스위트가 관측하지 못한다
	 * (excluded (d) — Java 단위 테스트가 그 2칸의 소유자다).
	 */
	private static final Map<String, Map<String, String>> DESK_TABLE = Map.of(
			"RDS", Map.of("send", "DPS", "hold", "DDH", "kill", "DDK"),
			"DPS", Map.of("send", "DPS", "hold", "DDH", "approveDelete", "DPD"),
			"DDH", Map.of("send", "DPS", "kill", "DDK"),
			"EPS", Map.of("kill", "EEK", "hold", "EEH"),
			"DES", Map.of("kill", "EEK", "hold", "EEH"));

	/** 기자(R) 전이표 — 3칸. {@code RDS} 기사만 다루고 삭제 승인 칸이 없다. */
	private static final Map<String, Map<String, String>> REPORTER_TABLE = Map.of(
			"RDS", Map.of("send", "RDS", "hold", "RRH", "kill", "RRK"));

	private static final Transition UNKNOWN_ACTION = new Transition(false, null, "unknown-action");

	private static final Transition UNKNOWN_ROLE = new Transition(false, null, "unknown-role");

	private static final Transition FORBIDDEN = new Transition(false, null, "forbidden-transition");

	/**
	 * 전이 판정 결과. 허용이면 {@code status}만, 거부면 {@code reason}만 채워진다 —
	 * 서블릿·SQL 타입을 참조하지 않는 순수 값이다(사유 토큰 → 상태코드 매핑은 web 계층의 표가 한다).
	 */
	public record Transition(boolean ok, String status, String reason) {
	}

	/**
	 * 기존 기사(편집 컨텍스트)의 다음 상태. 정의 외 조합은 사유 토큰과 함께 거부한다.
	 *
	 * <p>판정 순서가 계약이다: action 어휘({@code unknown-action}) → role({@code unknown-role}) →
	 * 표({@code forbidden-transition}). 순서가 바뀌면 같은 요청이 다른 사유·상태코드를 받는다.
	 */
	public static Transition transition(String status, String role, String action) {
		if (action == null || !ACTIONS.contains(action)) {
			return UNKNOWN_ACTION;
		}

		Map<String, Map<String, String>> table = table(role);
		if (table == null) {
			return UNKNOWN_ROLE;
		}

		Map<String, String> row = (status == null) ? null : table.get(status);
		String next = (row == null) ? null : row.get(action);
		if (next == null) {
			return FORBIDDEN;
		}
		return new Transition(true, next, null);
	}

	/**
	 * 최초 작성(create) 시의 초기 상태. <b>항상 유효한 상태를 돌려주며 거부하지 않는다</b>(최초 저장은
	 * 항상 성공한다). 기본은 {@code RDS}이고 보류만 전이표를 재사용한다(D·Z → {@code DDH}, R →
	 * {@code RRH}). 표가 거부하는 role의 보류는 {@code RDS}로 흡수된다.
	 *
	 * <p>신규 기사의 "최초 송고"가 권한 무관 {@code RDS} 유지인 것은 여기서 실현된다.
	 */
	public static String initialStatus(String role, String action) {
		if ("hold".equals(action)) {
			Transition held = transition("RDS", role, "hold");
			if (held.ok()) {
				return held.status();
			}
		}
		return "RDS";
	}

	/** D와 Z는 같은 표를 쓴다. 그 밖의 role(누락 포함)에는 표가 없다. */
	private static Map<String, Map<String, String>> table(String role) {
		if ("R".equals(role)) {
			return REPORTER_TABLE;
		}
		if ("D".equals(role) || "Z".equals(role)) {
			return DESK_TABLE;
		}
		return null;
	}

	private Lifecycle() {
	}
}
