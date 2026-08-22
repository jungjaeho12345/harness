package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;

/**
 * 기사 생애주기 전이표 — 리포 루트 {@code src/services/lifecycle.js}와 동형.
 *
 * <p><b>이 클래스가 지키는 한 문장:</b> 표에 없는 칸은 거부다. 표를 넓히는 변경은 여기서 즉시 red가 된다.
 *
 * <p>수치 세 개가 서로 다르며 그 차이 자체가 계약이다.
 * <ul>
 *   <li><b>15</b> — 표의 서로 다른 허용 칸(데스크 12 + 기자 3).</li>
 *   <li><b>13</b> — 그중 계약 스위트가 실제로 도달하는 칸(EPS발 2칸은 도달 경로가 없다 — excluded (d)).</li>
 *   <li><b>16</b> — {@code contract/cases/minimal/transitions.contract.js}의 허용 케이스 <b>건수</b>.
 *       Z(관리자) 3건이 D(데스크)와 <b>같은 칸</b>을 다시 관측하기 때문에 칸 수보다 3 크다.
 *       '16칸'으로 읽으면 표를 한 칸 더 만들게 된다.</li>
 * </ul>
 */
class LifecycleTest {

	/** 상태 11종 — 전수 격자의 행. */
	private static final List<String> ALL_STATUSES = List.of(
			"RDS", "DPS", "DDH", "DDK", "RRH", "RRK", "DES", "EPS", "EEK", "EEH", "DPD");

	private static final List<String> ROLES = List.of("R", "D", "Z");

	private static final List<String> ACTIONS = List.of("send", "hold", "kill", "approveDelete");

	/**
	 * {@code contract/cases/minimal/transitions.contract.js} 174~198행의 ALLOWED 목록을 그대로 옮긴 것.
	 * 계약 파일은 무수정이므로 여기 사본이 드리프트하면 그 사실 자체가 이 테스트의 red로 드러나야 한다 —
	 * 그래서 건수(16)까지 단언한다.
	 */
	private static final List<String[]> CONTRACT_ALLOWED = List.of(
			new String[] { "RDS", "D", "send", "DPS" },
			new String[] { "RDS", "D", "hold", "DDH" },
			new String[] { "RDS", "D", "kill", "DDK" },
			new String[] { "DPS", "D", "send", "DPS" },
			new String[] { "DPS", "D", "hold", "DDH" },
			new String[] { "DPS", "D", "approveDelete", "DPD" },
			new String[] { "DDH", "D", "send", "DPS" },
			new String[] { "DDH", "D", "kill", "DDK" },
			new String[] { "DES", "D", "kill", "EEK" },
			new String[] { "DES", "D", "hold", "EEH" },
			new String[] { "RDS", "Z", "send", "DPS" },
			new String[] { "RDS", "Z", "hold", "DDH" },
			new String[] { "DPS", "Z", "approveDelete", "DPD" },
			new String[] { "RDS", "R", "send", "RDS" },
			new String[] { "RDS", "R", "hold", "RRH" },
			new String[] { "RDS", "R", "kill", "RRK" });

	// --- A. 표 전수(허용 칸 15) ---------------------------------------------------------------------

	@Test
	void theTableHasExactlyFifteenAllowedCells() {
		Map<String, String> cells = allowedCells();

		assertEquals(Map.ofEntries(
				Map.entry("DESK RDS send", "DPS"),
				Map.entry("DESK RDS hold", "DDH"),
				Map.entry("DESK RDS kill", "DDK"),
				Map.entry("DESK DPS send", "DPS"),
				Map.entry("DESK DPS hold", "DDH"),
				Map.entry("DESK DPS approveDelete", "DPD"),
				Map.entry("DESK DDH send", "DPS"),
				Map.entry("DESK DDH kill", "DDK"),
				Map.entry("DESK EPS kill", "EEK"),
				Map.entry("DESK EPS hold", "EEH"),
				Map.entry("DESK DES kill", "EEK"),
				Map.entry("DESK DES hold", "EEH"),
				Map.entry("REPORTER RDS send", "RDS"),
				Map.entry("REPORTER RDS hold", "RRH"),
				Map.entry("REPORTER RDS kill", "RRK")), cells,
				"표 밖의 칸이 생겼거나 사라졌다 — 표에 없는 칸은 거부이며 칸을 늘리는 것은 계약 변경이다");
		assertEquals(15, cells.size(), "허용 칸은 15개다(데스크 12 + 기자 3)");
	}

	@Test
	void deskAndAdminShareOneTable() {
		for (String status : ALL_STATUSES) {
			for (String action : ACTIONS) {
				assertEquals(Lifecycle.transition(status, "D", action), Lifecycle.transition(status, "Z", action),
						"D와 Z는 같은 표를 쓴다: " + status + " + " + action);
			}
		}
	}

	@Test
	void theReporterTableOnlyHandlesRds() {
		for (String status : ALL_STATUSES) {
			if ("RDS".equals(status)) {
				continue;
			}
			for (String action : ACTIONS) {
				Lifecycle.Transition t = Lifecycle.transition(status, "R", action);
				assertFalse(t.ok(), "R은 RDS 기사만 다룬다: " + status + " + " + action);
				assertEquals("forbidden-transition", t.reason());
			}
		}
		assertFalse(Lifecycle.transition("RDS", "R", "approveDelete").ok(), "R에게 삭제승인 칸은 없다");
	}

	// --- B. 계약 케이스(16건) 대조 -------------------------------------------------------------------

	@Test
	void everyContractAllowedCaseMatchesTheTable() {
		assertEquals(16, CONTRACT_ALLOWED.size(), "계약 허용 케이스는 16'건'이다 — 칸 수(15)와 다른 수다");

		Set<String> covered = new LinkedHashSet<>();
		for (String[] c : CONTRACT_ALLOWED) {
			Lifecycle.Transition t = Lifecycle.transition(c[0], c[1], c[2]);
			assertTrue(t.ok(), "계약이 허용으로 동결한 칸이 거부됐다: " + List.of(c));
			assertEquals(c[3], t.status(), "다음 상태가 계약과 다르다: " + List.of(c));
			assertNull(t.reason(), "허용 결과에는 사유가 없다: " + List.of(c));
			covered.add(cell(c[1], c[0], c[2]));
		}

		assertEquals(13, covered.size(),
				"16건이 덮는 서로 다른 칸은 13이다(Z 3건은 D와 같은 칸을 다시 관측한다)");
	}

	@Test
	void theOnlyCellsTheContractCannotReachAreTheTwoEmbargoSentCells() {
		Set<String> covered = new LinkedHashSet<>();
		for (String[] c : CONTRACT_ALLOWED) {
			covered.add(cell(c[1], c[0], c[2]));
		}

		Set<String> unreached = new TreeSet<>(allowedCells().keySet());
		unreached.removeAll(covered);

		assertEquals(Set.of("DESK EPS hold", "DESK EPS kill"), unreached,
				"계약이 도달하지 못하는 칸은 EPS발 2칸뿐이다(excluded (d) — 이 테스트가 그 2칸의 유일한 소유자다)");
	}

	// --- C. 거부 칸과 사유 토큰 ----------------------------------------------------------------------

	@Test
	void cellsOutsideTheTableAreRejectedAsForbiddenTransition() {
		// contract/cases/minimal/transitions.contract.js 232~238행의 REJECTED 전수.
		String[][] rejected = {
			{ "DPS", "R", "send" }, // R은 RDS 기사만 다룬다
			{ "RDS", "R", "approveDelete" }, // R에게 삭제승인 칸이 없다
			{ "DDH", "D", "hold" }, // 이미 보류
			{ "RRK", "D", "send" }, // 기자 KILL 상태는 데스크 표에 없다
			{ "DPD", "D", "send" }, // 삭제승인 이후는 종착
		};

		for (String[] c : rejected) {
			Lifecycle.Transition t = Lifecycle.transition(c[0], c[1], c[2]);
			assertFalse(t.ok(), "표 밖의 칸이 허용됐다: " + List.of(c));
			assertEquals("forbidden-transition", t.reason(), "사유 토큰이 다르다: " + List.of(c));
			assertNull(t.status(), "거부 결과에는 다음 상태가 없다: " + List.of(c));
		}
	}

	@Test
	void unknownActionIsCheckedBeforeUnknownRole() {
		assertEquals("unknown-action", Lifecycle.transition("RDS", "D", "publish").reason());
		assertEquals("unknown-action", Lifecycle.transition("RDS", "D", null).reason());
		// 두 값이 모두 정의 밖이면 action 판정이 먼저다(Node 46~50행 순서).
		assertEquals("unknown-action", Lifecycle.transition("RDS", "X", "publish").reason());
	}

	@Test
	void unknownRoleIsRejectedWithItsOwnToken() {
		assertEquals("unknown-role", Lifecycle.transition("RDS", "X", "send").reason());
		assertEquals("unknown-role", Lifecycle.transition("RDS", null, "send").reason());
		assertEquals("unknown-role", Lifecycle.transition("RDS", "d", "send").reason(), "role은 대문자 정확 일치다");
	}

	@Test
	void unknownStatusIsAForbiddenTransitionNotACrash() {
		Lifecycle.Transition t = Lifecycle.transition("ZZZ", "D", "send");

		assertFalse(t.ok());
		assertEquals("forbidden-transition", t.reason());
		assertEquals("forbidden-transition", Lifecycle.transition(null, "D", "send").reason());
	}

	// --- D. 최초 상태 --------------------------------------------------------------------------------

	@Test
	void initialStatusDefaultsToRdsAndNeverRejects() {
		assertEquals("RDS", Lifecycle.initialStatus("R", "send"));
		assertEquals("RDS", Lifecycle.initialStatus("D", "send"));
		assertEquals("RDS", Lifecycle.initialStatus("Z", null));
		assertEquals("RDS", Lifecycle.initialStatus("D", "kill"), "create의 kill은 초기 상태를 바꾸지 않는다");
		assertEquals("RDS", Lifecycle.initialStatus(null, null));
		assertEquals("RDS", Lifecycle.initialStatus("X", "publish"), "알 수 없는 role·action도 거부가 아니라 RDS다");
	}

	@Test
	void initialStatusReusesTheTransitionTableForHold() {
		assertEquals("DDH", Lifecycle.initialStatus("D", "hold"));
		assertEquals("DDH", Lifecycle.initialStatus("Z", "hold"));
		assertEquals("RRH", Lifecycle.initialStatus("R", "hold"));
		assertEquals("RDS", Lifecycle.initialStatus("X", "hold"),
				"전이표가 거부하는 role의 hold는 RDS로 흡수된다(최초 저장은 항상 성공한다)");
	}

	// --- 격자 ---------------------------------------------------------------------------------------

	/** 전수 격자를 돌려 허용으로 나온 칸만 모은다 — 표를 직접 읽지 않고 공개 API로만 관측한다. */
	private static Map<String, String> allowedCells() {
		Map<String, String> cells = new TreeMap<>();
		for (String status : ALL_STATUSES) {
			for (String role : ROLES) {
				for (String action : ACTIONS) {
					Lifecycle.Transition t = Lifecycle.transition(status, role, action);
					if (!t.ok()) {
						continue;
					}
					String key = cell(role, status, action);
					String previous = cells.put(key, t.status());
					assertTrue(previous == null || previous.equals(t.status()),
							"같은 칸이 role에 따라 다른 결과를 낸다: " + key);
				}
			}
		}
		return cells;
	}

	/** 칸의 정체성은 (표, status, action)이다 — D와 Z는 같은 표이므로 같은 칸이다. */
	private static String cell(String role, String status, String action) {
		return ("R".equals(role) ? "REPORTER" : "DESK") + " " + status + " " + action;
	}
}
