package harness.news.service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 이력 표시 값의 파생(title·version·status) — 리포 루트 {@code src/services/historyMeta.js}의 이식
 * (순수 모듈: DB·HTTP·시계·난수 비의존).
 *
 * <p>{@code ArticleHistory}에는 기록 시점에 파생 저장한 표시 제목 컬럼({@code snapshotTitle})이 있고,
 * 버전 컬럼은 없으며 상태는 전이 행에만 있다. 이 모듈은 이력 행 + 스냅샷 항목에서 표시용 값을 만든다 —
 * <b>저장된 제목이 1차 출처</b>이고 값이 없는 레거시 항목만 본문에서 파생한다.
 *
 * <p>제목 파생은 {@code type === 'text'}인 블록만 센다. 마커 판정({@link EndMarker})이 모든 블록의
 * {@code text}를 보는 것과 다르다 — 합치면 임베드의 {@code title} 같은 필드가 제목으로 오인된다.
 */
public final class HistoryMeta {

	/** 표시 제목 상한. {@code Article.title}은 무상한이며 이 절단은 이력 표시에만 있다. */
	public static final int MAX_HISTORY_TITLE_LEN = 200;

	private static final String BLOCKS = "blocks";

	private static final String TEXT = "text";

	private static final String TYPE = "type";

	// --- 제목 파생 -----------------------------------------------------------------------------

	/**
	 * 본문 스냅샷 → 표시 제목(첫 텍스트 줄, trim, 200자 절단). 파싱 불가·빈 값은 {@code ''}이다.
	 *
	 * <p>프론트 {@code bodyTitle}과 동형이어야 한다 — 텍스트 블록만 세고, 깨진 JSON·평문 레거시는
	 * 문자열 그대로 취급한다.
	 *
	 * <p>다듬기는 {@link NodeString#trim(String)}이다({@link String#strip()}·{@link String#trim()}
	 * 금지 — 셋의 공백 집합이 서로 다르다). 이 값은 {@code ArticleHistory.snapshotTitle}로 <b>영속</b>되고
	 * 이력 응답의 {@code title}로 나가므로, 집합이 갈리면 같은 편집에 두 서버가 다른 값을 쓴다.
	 * 붙여넣기 본문의 NBSP는 실제로 흔하고 계약 픽스처는 ASCII 제목만 쓴다.
	 */
	public static String snapshotTitle(Object markupVersion) {
		if (markupVersion == null) {
			return "";
		}
		String raw = String.valueOf(markupVersion);
		if (raw.isEmpty()) {
			return "";
		}

		String text = textOf(raw);
		int lineEnd = text.indexOf('\n');
		String firstLine = NodeString.trim((lineEnd < 0) ? text : text.substring(0, lineEnd));
		return (firstLine.length() > MAX_HISTORY_TITLE_LEN)
				? firstLine.substring(0, MAX_HISTORY_TITLE_LEN) : firstLine;
	}

	/** 블록 문서(최상위 배열 또는 {@code blocks} 배열)면 텍스트 블록만 이어 붙이고, 아니면 원문이다. */
	private static String textOf(String raw) {
		Object doc = MarkupJson.parseOrNull(raw);
		List<?> blocks = null;
		if (doc instanceof List<?> list) {
			blocks = list;
		}
		else if (doc instanceof Map<?, ?> map && map.get(BLOCKS) instanceof List<?> list) {
			blocks = list;
		}
		if (blocks == null) {
			return raw;
		}

		StringBuilder joined = new StringBuilder();
		int kept = 0;
		for (Object candidate : blocks) {
			if (!(candidate instanceof Map<?, ?> block) || !TEXT.equals(block.get(TYPE))
					|| !(block.get(TEXT) instanceof String text)) {
				continue; // 텍스트가 아닌 블록·비문자열 text는 아예 버린다(빈 줄도 남기지 않는다).
			}
			if (kept > 0) {
				joined.append('\n'); // 남은 블록이 빈 문자열이어도 줄은 센다(Node join 동형).
			}
			joined.append(text);
			kept += 1;
		}
		return joined.toString();
	}

	// --- 행 파생 -------------------------------------------------------------------------------

	/**
	 * 이력 행에 표시용 {@code title}·{@code version}·{@code status}를 얹는다.
	 *
	 * <p>규칙(정본과 1:1):
	 * <ol>
	 *   <li>계산은 <b>id 오름차순</b>(같은 {@code createdAt}이 여럿일 수 있어 배열 위치를 믿지 않는다),
	 *       반환은 <b>입력 순서 그대로</b>.</li>
	 *   <li>스냅샷 보유 행에서 version을 <b>먼저 올리고 그 값을 그 행에</b> 준다(그 편집이 새 버전을 만든다).</li>
	 *   <li>전이 행({@code toStatus}가 비어 있지 않은 행)에서 상태를 갱신한다.</li>
	 *   <li>첫 전이 이전 구간은 그 전이의 {@code fromStatus}로 <b>역승계</b>한다.</li>
	 *   <li>저장된 파생 제목이 문자열이면 재파생하지 않는다({@code ''}도 유효한 저장값이다).</li>
	 *   <li>{@code v1Body}는 스냅샷이 <b>한 건도 없을 때만</b> 쓴다(그 외에는 현재 본문이 v1이 아니다).</li>
	 *   <li>반환 행에 {@code markupVersion}·{@code snapshotTitle}을 싣지 않는다(응답 shape 불변).</li>
	 * </ol>
	 *
	 * @param rows 이력 행(id DESC 전제이지만 순서에 의존하지 않는다). 입력은 변형하지 않는다.
	 * @param snapshots {@code {id, snapshotTitle?, markupVersion?}} 항목들. 신규·레거시가 섞일 수 있다.
	 * @param v1Body 스냅샷이 없을 때만 쓰는 v1 본문(= 현재 {@code Article.markupVersion})
	 */
	public static List<Map<String, Object>> decorateHistoryRows(List<? extends Map<String, Object>> rows,
			List<? extends Map<String, Object>> snapshots, Object v1Body) {
		List<? extends Map<String, Object>> input = (rows == null) ? List.of() : rows;

		Map<Long, Map<String, Object>> snapshotById = new HashMap<>();
		for (Map<String, Object> snapshot : (snapshots == null) ? List.<Map<String, Object>>of() : snapshots) {
			snapshotById.put(idOf(snapshot.get("id")), snapshot);
		}

		List<Map<String, Object>> ascending = new ArrayList<>(input);
		ascending.sort(Comparator.comparing((row) -> idOf(row.get("id")),
				Comparator.nullsFirst(Comparator.naturalOrder())));

		boolean anySnapshot = input.stream().anyMatch(HistoryMeta::hasSnapshot);
		// 스냅샷이 1건이라도 있으면 현재 본문은 최신 버전이지 v1이 아니다 — 그때는 v1Body를 무시한다.
		String v1Title = anySnapshot ? "" : snapshotTitle(v1Body);
		String backfillStatus = backfillStatus(ascending);

		Map<Long, Derived> derivedById = new HashMap<>();
		int version = 1;
		String title = v1Title;
		String status = null; // 아직 전이를 못 만난 구간 — backfillStatus로 채운다.
		for (Map<String, Object> row : ascending) {
			if (hasSnapshot(row)) {
				version += 1;
				title = resolveTitle(snapshotById.get(idOf(row.get("id"))));
			}
			if (isTransition(row)) {
				status = String.valueOf(row.get("toStatus"));
			}
			derivedById.put(idOf(row.get("id")), new Derived(version, title, (status == null) ? backfillStatus : status));
		}

		List<Map<String, Object>> out = new ArrayList<>(input.size());
		for (Map<String, Object> row : input) {
			Map<String, Object> decorated = new LinkedHashMap<>(row);
			Derived derived = derivedById.get(idOf(row.get("id")));
			decorated.put("version", derived.version());
			decorated.put("title", derived.title());
			decorated.put("status", derived.status());
			decorated.remove("markupVersion"); // 목록은 blob 없는 경량 계약이다.
			decorated.remove("snapshotTitle"); // 표시 값의 단일 출처는 title이다.
			out.add(decorated);
		}
		return out;
	}

	private record Derived(int version, String title, String status) {
	}

	/** 가장 오래된 전이의 {@code fromStatus} — 그보다 앞선 행의 상태는 그 전이 행이 알고 있다. */
	private static String backfillStatus(List<Map<String, Object>> ascending) {
		for (Map<String, Object> row : ascending) {
			if (isTransition(row)) {
				Object from = row.get("fromStatus");
				return (from == null) ? "" : String.valueOf(from);
			}
		}
		return "";
	}

	/** 저장된 파생 제목이 문자열이면 그대로 쓴다 — 재파생하면 평문 제목이 파괴된다. */
	private static String resolveTitle(Map<String, Object> snapshot) {
		if (snapshot == null) {
			return "";
		}
		if (snapshot.get("snapshotTitle") instanceof String stored) {
			return stored;
		}
		return snapshotTitle(snapshot.get("markupVersion"));
	}

	/** 모델이 주는 {@code hasSnapshot}(정수 1/0)의 참 판정 — 버전 증가는 이 플래그만 본다. */
	private static boolean hasSnapshot(Map<String, Object> row) {
		Object flag = row.get("hasSnapshot");
		if (flag instanceof Number number) {
			return number.longValue() != 0L;
		}
		if (flag instanceof Boolean bool) {
			return bool;
		}
		return (flag instanceof String text) && !text.isEmpty();
	}

	/** 전이 행 판정 — status 전이 행만 {@code toStatus}를 갖는다(edit·distribute 행은 비어 있다). */
	private static boolean isTransition(Map<String, Object> row) {
		Object to = row.get("toStatus");
		return to != null && !String.valueOf(to).isEmpty();
	}

	/** 순서·대응의 기준은 배열 위치가 아니라 id다. 정수가 아닌 id는 값이 없는 것으로 본다. */
	private static Long idOf(Object id) {
		if (id instanceof Number number) {
			return number.longValue();
		}
		if (id instanceof String text) {
			try {
				return Long.valueOf(text);
			}
			catch (NumberFormatException ex) {
				return null;
			}
		}
		return null;
	}

	private HistoryMeta() {
	}
}
