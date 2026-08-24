package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 이력 표시 파생(title·version·status) — 리포 루트 {@code src/services/historyMeta.js}와 동형.
 *
 * <p>제목 파생은 <b>{@code type === 'text'}인 블록만</b> 센다. 마커 판정({@link EndMarker})이 모든
 * 블록의 {@code text}를 보는 것과 다르며, 두 규칙을 하나로 합치면 계약이 깨진다(양쪽 다른 방향으로).
 *
 * <p>파생 규칙은 {@code contract/cases/default/articles-read.contract.js} 482~520행이 동결했다:
 * 첫 편집 스냅샷은 v2이고, 전이 행은 버전을 올리지 않으며, 전이 이전 구간의 상태는 첫 전이의
 * {@code fromStatus}로 <b>역승계</b>된다.
 */
class HistoryMetaTest {

	// --- A. snapshotTitle ---------------------------------------------------------------------------

	@Test
	void onlyTextBlocksCountTowardTheTitle() {
		assertEquals("진짜 제목", HistoryMeta.snapshotTitle(
				"{\"blocks\":[{\"text\":\"type 없는 블록\"},{\"type\":\"text\",\"text\":\"진짜 제목\"}]}"),
				"type이 없는 블록은 제목 후보가 아니다(마커 판정과 규칙이 다르다)");
		assertEquals("본문 첫 줄", HistoryMeta.snapshotTitle(
				"{\"blocks\":[{\"type\":\"embed\",\"title\":\"사진 설명\"},{\"type\":\"text\",\"text\":\"본문 첫 줄\"}]}"),
				"임베드의 title은 제목으로 오인하지 않는다");
		assertEquals("문자열만", HistoryMeta.snapshotTitle(
				"{\"blocks\":[{\"type\":\"text\",\"text\":123},{\"type\":\"text\",\"text\":\"문자열만\"}]}"),
				"text가 문자열이 아닌 블록은 버린다");
	}

	@Test
	void aTopLevelArrayIsAlsoABlockList() {
		assertEquals("배열 문서", HistoryMeta.snapshotTitle("[{\"type\":\"text\",\"text\":\"배열 문서\"}]"));
	}

	@Test
	void onlyTheFirstLineIsUsedAndItIsTrimmed() {
		assertEquals("첫 줄", HistoryMeta.snapshotTitle(
				"{\"blocks\":[{\"type\":\"text\",\"text\":\"  첫 줄  \\n둘째 줄\"},{\"type\":\"text\",\"text\":\"셋째\"}]}"));
	}

	/**
	 * 첫 줄의 앞뒤를 걷어내는 집합은 <b>JS {@code .trim()}의 집합</b>이다 — Java의 {@code strip()}도
	 * {@code trim()}도 아니다.
	 *
	 * <p>이 파생 값은 {@code ArticleHistoryRecorder}를 거쳐 {@code ArticleHistory.snapshotTitle} 컬럼에
	 * <b>영속</b>되고 {@code GET /api/articles/:id/history}의 {@code title}로 나간다 — 집합이 한 글자라도
	 * 갈리면 같은 편집에 두 서버가 <b>다른 값을 쓴다</b>. 붙여넣기 본문의 NBSP는 실제로 흔하다.
	 * 계약 픽스처는 ASCII 제목만 쓰므로 이 축의 유일한 방어선은 이 테스트다.
	 *
	 * <p>기대값은 Node 실측이다: {@code " x ".trim() === "x"}(NBSP·U+FEFF·U+2007·U+202F는
	 * 걷힌다) / {@code "x".trim() === "x"}(U+001C~U+001F는 <b>JS 공백이 아니다</b> — Java
	 * {@code Character.isWhitespace}만 참이다).
	 */
	@Test
	void theFirstLineIsTrimmedWithJavaScriptWhitespaceNotJavaWhitespace() {
		// 평문 레거시 경로로 돌린다 — U+0009·U+000B·U+000C는 JSON 문자열에 날것으로 넣을 수 없다(파서가 거부).
		for (int cp : new int[] { 0x00A0, 0xFEFF, 0x2007, 0x202F, 0x1680, 0x2000, 0x205F, 0x3000, 0x2028, 0x2029,
				0x000B, 0x000C, 0x0009, 0x0020 }) {
			String pad = ch(cp);
			assertEquals("제목", HistoryMeta.snapshotTitle(pad + "제목" + pad),
					"U+" + Integer.toHexString(cp) + "는 JS .trim()이 걷어내는 공백이다");
		}
		for (int cp : new int[] { 0x001C, 0x001D, 0x001E, 0x001F, 0x0085, 0x200B }) {
			String pad = ch(cp);
			assertEquals(pad + "제목" + pad, HistoryMeta.snapshotTitle(pad + "제목" + pad),
					"U+" + Integer.toHexString(cp) + "는 JS 공백이 아니다 — 제목의 일부로 남는다");
		}
	}

	@Test
	void theBlockDocumentPathTrimsTheSameWay() {
		// 실제로 영속되는 경로(블록 문서)에서도 같은 집합이어야 한다 — 붙여넣기 본문의 NBSP가 여기로 온다.
		String nbsp = ch(0x00A0);

		assertEquals("제목", HistoryMeta.snapshotTitle(body(nbsp + "제목" + nbsp)));
		assertEquals("", HistoryMeta.snapshotTitle(body(nbsp + " " + ch(0xFEFF) + ch(0x202F))),
				"전부 공백이면 빈 제목이다");
		assertEquals("가운데" + nbsp + "공백", HistoryMeta.snapshotTitle(body("가운데" + nbsp + "공백")),
				"가운데 공백은 건드리지 않는다");
	}

	@Test
	void theTitleIsTruncatedToTwoHundredCharacters() {
		String long300 = "가".repeat(300);

		String title = HistoryMeta.snapshotTitle("{\"blocks\":[{\"type\":\"text\",\"text\":\"" + long300 + "\"}]}");

		assertEquals(200, HistoryMeta.MAX_HISTORY_TITLE_LEN);
		assertEquals("가".repeat(200), title);
	}

	@Test
	void plainTextAndBrokenJsonFallBackToTheRawString() {
		assertEquals("레거시 제목", HistoryMeta.snapshotTitle("레거시 제목\n둘째 줄"));
		assertEquals("{\"blocks\":[{\"type\":\"text\"", HistoryMeta.snapshotTitle("{\"blocks\":[{\"type\":\"text\""));
	}

	@Test
	void emptyValuesYieldAnEmptyTitle() {
		assertEquals("", HistoryMeta.snapshotTitle(null));
		assertEquals("", HistoryMeta.snapshotTitle(""));
		assertEquals("", HistoryMeta.snapshotTitle("{\"blocks\":[]}"));
		assertEquals("", HistoryMeta.snapshotTitle("   \n제목이 아닌 둘째 줄"));
	}

	// --- B. decorateHistoryRows ---------------------------------------------------------------------

	@Test
	void theContractScenarioDerivesVersionStatusAndTitle() {
		// 계약 픽스처와 같은 모양: 최초 저장(v1) → 편집 1건(스냅샷) → 송고 1건(전이). 입력은 id DESC.
		List<Map<String, Object>> rows = List.of(
				historyRow(2, "status", "send", "RDS", "DPS", 0),
				historyRow(1, "edit", null, null, null, 1));
		List<Map<String, Object>> snapshots = List.of(snapshot(1, "편집한 첫 줄", null));

		List<Map<String, Object>> out = HistoryMeta.decorateHistoryRows(rows, snapshots, body("v1 제목"));

		Map<String, Object> send = out.get(0);
		Map<String, Object> edit = out.get(1);
		assertEquals(2, send.get("id"), "반환 순서는 입력 순서(id DESC) 그대로다");
		assertEquals(1, edit.get("id"));
		assertEquals(2, edit.get("version"), "최초 저장 본문이 v1이라 첫 편집 스냅샷은 v2");
		assertEquals(2, send.get("version"), "전이 행은 버전을 올리지 않는다");
		assertEquals("RDS", edit.get("status"), "전이 이전 구간의 상태는 첫 전이의 fromStatus로 역승계된다");
		assertEquals("DPS", send.get("status"), "전이 행의 상태는 toStatus");
		assertEquals("편집한 첫 줄", edit.get("title"), "파생 title은 저장된 스냅샷 제목이다");
		assertEquals("편집한 첫 줄", send.get("title"), "전이 행은 직전 스냅샷의 제목을 이어받는다");
	}

	@Test
	void v1BodyIsIgnoredWhenAnySnapshotExists() {
		List<Map<String, Object>> rows = List.of(
				historyRow(2, "status", "send", "RDS", "DPS", 0),
				historyRow(1, "edit", null, null, null, 1));
		List<Map<String, Object>> snapshots = List.of(snapshot(1, "편집한 첫 줄", null));

		List<Map<String, Object>> out = HistoryMeta.decorateHistoryRows(rows, snapshots, body("현재 본문 제목"));

		for (Map<String, Object> row : out) {
			assertFalse("현재 본문 제목".equals(row.get("title")),
					"스냅샷이 1건이라도 있으면 현재 본문은 v1이 아니다 — v1Body는 무시한다");
		}
	}

	@Test
	void v1BodyIsUsedOnlyWhenThereIsNoSnapshotAtAll() {
		List<Map<String, Object>> rows = List.of(historyRow(1, "status", "send", "RDS", "DPS", 0));

		List<Map<String, Object>> out = HistoryMeta.decorateHistoryRows(rows, List.of(), body("v1 제목"));

		assertEquals("v1 제목", out.get(0).get("title"));
		assertEquals(1, out.get(0).get("version"), "스냅샷이 없으면 v1 구간이다");
	}

	@Test
	void legacySnapshotsWithoutAStoredTitleAreDerivedFromTheBody() {
		List<Map<String, Object>> rows = List.of(historyRow(1, "edit", null, null, null, 1));
		List<Map<String, Object>> snapshots = List.of(snapshot(1, null, body("레거시 본문 제목")));

		List<Map<String, Object>> out = HistoryMeta.decorateHistoryRows(rows, snapshots, null);

		assertEquals("레거시 본문 제목", out.get(0).get("title"));
	}

	@Test
	void aStoredEmptyTitleIsNotRederived() {
		// ''도 유효한 저장값이다 — 폴백하면 규칙 드리프트(재파생 금지)를 어긴다.
		List<Map<String, Object>> rows = List.of(historyRow(1, "edit", null, null, null, 1));
		List<Map<String, Object>> snapshots = List.of(snapshot(1, "", body("본문에서 파생될 제목")));

		List<Map<String, Object>> out = HistoryMeta.decorateHistoryRows(rows, snapshots, null);

		assertEquals("", out.get(0).get("title"));
	}

	@Test
	void versionIncrementsOncePerSnapshotInIdOrder() {
		List<Map<String, Object>> rows = List.of(
				historyRow(4, "edit", null, null, null, 1),
				historyRow(3, "status", "send", "RDS", "DPS", 0),
				historyRow(2, "edit", null, null, null, 1),
				historyRow(1, "edit", null, null, null, 1));
		List<Map<String, Object>> snapshots = List.of(
				snapshot(1, "첫 편집", null), snapshot(2, "둘째 편집", null), snapshot(4, "넷째 편집", null));

		List<Map<String, Object>> out = HistoryMeta.decorateHistoryRows(rows, snapshots, null);

		assertEquals(List.of(4, 3, 2, 1), out.stream().map((r) -> r.get("id")).toList());
		assertEquals(List.of(4, 3, 3, 2), out.stream().map((r) -> r.get("version")).toList());
		assertEquals(List.of("넷째 편집", "둘째 편집", "둘째 편집", "첫 편집"),
				out.stream().map((r) -> r.get("title")).toList());
		assertEquals(List.of("DPS", "DPS", "RDS", "RDS"), out.stream().map((r) -> r.get("status")).toList(),
				"첫 전이 이전 구간은 그 전이의 fromStatus로 역승계된다");
	}

	@Test
	void computationOrderComesFromIdNotFromArrayPosition() {
		// 같은 createdAt이 여러 건일 수 있어 배열 위치를 믿지 않는다 — 뒤섞인 입력에도 결과가 같다.
		List<Map<String, Object>> rows = List.of(
				historyRow(1, "edit", null, null, null, 1),
				historyRow(3, "status", "send", "RDS", "DPS", 0),
				historyRow(2, "edit", null, null, null, 1));
		List<Map<String, Object>> snapshots = List.of(snapshot(1, "첫 편집", null), snapshot(2, "둘째 편집", null));

		List<Map<String, Object>> out = HistoryMeta.decorateHistoryRows(rows, snapshots, null);

		assertEquals(List.of(1, 3, 2), out.stream().map((r) -> r.get("id")).toList(), "반환은 입력 순서다");
		assertEquals(List.of(2, 3, 3), out.stream().map((r) -> r.get("version")).toList());
		assertEquals(List.of("RDS", "DPS", "RDS"), out.stream().map((r) -> r.get("status")).toList());
	}

	@Test
	void rowsWithoutAnyTransitionHaveAnEmptyStatus() {
		List<Map<String, Object>> rows = List.of(historyRow(1, "edit", null, null, null, 1));

		List<Map<String, Object>> out = HistoryMeta.decorateHistoryRows(rows, List.of(snapshot(1, "제목", null)), null);

		assertEquals("", out.get(0).get("status"), "역승계할 전이가 없으면 빈 문자열이다(표시 폴백은 뷰 책임)");
	}

	@Test
	void theStoredColumnsAreNotCarriedIntoTheResponseRow() {
		Map<String, Object> raw = historyRow(1, "edit", null, null, null, 1);
		raw.put("markupVersion", body("본문 blob"));
		raw.put("snapshotTitle", "저장된 제목");

		List<Map<String, Object>> out = HistoryMeta.decorateHistoryRows(List.of(raw), List.of(), null);

		assertFalse(out.get(0).containsKey("markupVersion"), "목록은 blob 없는 경량 계약이다");
		assertFalse(out.get(0).containsKey("snapshotTitle"), "표시 값의 단일 출처는 title이다");
		assertTrue(raw.containsKey("markupVersion"), "입력 행은 변형하지 않는다");
	}

	@Test
	void otherRowKeysArePreserved() {
		List<Map<String, Object>> out = HistoryMeta.decorateHistoryRows(
				List.of(historyRow(1, "status", "send", "RDS", "DPS", 0)), List.of(), null);

		Map<String, Object> row = out.get(0);
		assertEquals("AKR20260820000000001", row.get("articleId"));
		assertEquals("send", row.get("action"));
		assertEquals("RDS", row.get("fromStatus"));
		assertEquals(0, row.get("hasSnapshot"), "hasSnapshot은 불리언이 아니라 정수 그대로다");
	}

	@Test
	void emptyInputYieldsAnEmptyList() {
		assertEquals(List.of(), HistoryMeta.decorateHistoryRows(List.of(), List.of(), null));
		assertEquals(List.of(), HistoryMeta.decorateHistoryRows(null, null, null));
	}

	// --- 픽스처 -------------------------------------------------------------------------------------

	private static Map<String, Object> historyRow(int id, String eventType, String action, String fromStatus,
			String toStatus, int hasSnapshot) {
		Map<String, Object> row = new LinkedHashMap<>();
		row.put("id", id);
		row.put("articleId", "AKR20260820000000001");
		row.put("eventType", eventType);
		row.put("action", action);
		row.put("fromStatus", fromStatus);
		row.put("toStatus", toStatus);
		row.put("actorUserId", "desk1");
		row.put("createdAt", "2026-08-20T12:00:00.000Z");
		row.put("hasSnapshot", hasSnapshot);
		return row;
	}

	private static Map<String, Object> snapshot(int id, String storedTitle, String markupVersion) {
		Map<String, Object> item = new LinkedHashMap<>();
		item.put("id", id);
		item.put("snapshotTitle", storedTitle);
		item.put("markupVersion", markupVersion);
		return item;
	}

	/** 보이지 않는 문자는 <b>소스에 심지 않는다</b> — 코드포인트로 만든다(diff가 사실을 감추지 않게). */
	private static String ch(int codePoint) {
		return String.valueOf((char) codePoint);
	}

	private static String body(String firstLine) {
		return "{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"" + firstLine + "\"}]}";
	}
}
