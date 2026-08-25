package harness.news.service;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * 엠바고 배부 판정 규칙 — 리포 루트 {@code src/services/embargoPolicy.js}(207행)의 1:1 이식이며
 * {@link Lifecycle}과 같은 관례의 <b>순수 모듈</b>이다(DB·HTTP·파일시스템·타이머 비의존).
 *
 * <p>답하는 질문은 둘뿐이다:
 * <ol>
 *   <li>지금 이 기사에서 어떤 kind를 배부해야 하는가 → {@link #dueKinds}</li>
 *   <li>배부 이력이 이러할 때 상태는 무엇이어야 하는가 → {@link #embargoStatusFor}</li>
 * </ol>
 * 조회·쓰기·주기 실행은 전부 호출자(tick 서비스)의 책임이다 — ADR-008 (3): 시점 배부는 외부 cron의
 * tick pull이며 앱 안에 타이머를 두지 않는다.
 *
 * <p><b>{@link java.time.Clock}을 주입받지 않는다</b>({@code now}는 언제나 인자다). 여기에 시계를 두면
 * tick의 "실행당 1회 시계 읽기" 불변식이 깨져 같은 실행 안에서도 기사마다 판정이 갈린다.
 *
 * <p>{@code docs/news.md} "엠바고 규칙"의 직역이며 임의 확장은 없다: 1차 엠바고 시각 → 언론사
 * ({@code press}) · 2차 엠바고 시각 → 비언론사({@code nonpress}), 단 송고 시 바로 언론사(그 판정은
 * 송고 훅의 책임이고 여기가 아니다) · 1+2차 → 1차 시각에 press, 2차 시각에 nonpress.
 *
 * <h2>안전 기본값의 "방향"이 계약이다</h2>
 * 반대 방향은 전부 회수 불가능한 조기 배부로 끝난다 — {@code now}를 못 읽으면 아무것도 배부하지 않고,
 * 사이클 경계를 확정 못 하면 전체 이력을 세고(넓게), {@code id}를 모르는 {@code distribute} 행은
 * 이번 사이클에 포함해서 세고, {@code EPS → DES} 역행은 하지 않는다.
 *
 * <p>기사 공통정보는 {@code ContentsRow}가 아니라 <b>컬럼 접근자</b>({@code Function<String,Object>})로
 * 받는다. 호출자가 둘(tick은 {@code ContentsRow::column}, 재전송은 {@code Map::get})이고, model 타입을
 * import하면 이 모듈의 단위 테스트가 DB 픽스처를 요구하게 된다.
 */
public final class EmbargoPolicy {

	/**
	 * 배부 가능 상태 — 송고 훅·tick·배부 실행의 쓰기 직전 TOCTOU 가드·재전송이 공유하는 <b>단일 출처</b>다
	 * (tick 전용 스캔 필터가 아니다 — 복제 금지).
	 *
	 * <p>CRITICAL: {@code RDS}(미송고)·{@code RRH}·{@code RRK}·{@code DDH}·{@code DDK}(보류/킬)·
	 * {@code EEK}·{@code EEH}(엠바고 킬/보류)·{@code DPD}(삭제 승인)는 전부 제외다. 외부 수신처로 한 번
	 * 나간 기사는 회수 수단이 없으므로 이 게이트가 유일한 방어선이다.
	 */
	public static final List<String> EMBARGO_DISTRIBUTABLE_STATUSES = List.of("DES", "EPS", "DPS");

	/**
	 * 사이클 경계가 적용되는 상태 — 재송고로 "새 배부 사이클"이 열리는 {@code DES}·{@code EPS}뿐이다.
	 *
	 * <p>{@code DPS}(완결·레거시)는 전체 이력을 본다: 재송고 정정본 계약의 근거가 "역사상 어디로 나갔나"이기
	 * 때문이다. 여기에 {@code DPS}를 넣으면 tick이 이미 배부된 수신처로 중복 배부한다(회수 불가) — 넣지 마라.
	 */
	public static final List<String> CYCLE_SCOPED_STATUSES = List.of("DES", "EPS");

	/** 상태 계산이 개입할 수 있는 현재 상태. 그 외({@code DPS} 완결·{@code EEK}…)는 절대 건드리지 않는다. */
	private static final Set<String> MUTABLE_STATUSES = Set.of("DES", "EPS");

	/** 배부 kind ↔ 엠바고 필드. <b>모든 반환 배열의 순서</b>가 이 상수 순서다(수집 순서가 아니다). */
	private static final List<KindField> KIND_FIELDS = List.of(
			new KindField("press", "embargoAt"),
			new KindField("nonpress", "secondEmbargoAt"));

	private static final String DISTRIBUTE = "distribute";

	private static final String STATUS = "status";

	private static final String SEND = "send";

	/**
	 * 이 기사의 엠바고 배부가 "완결"되려면 어떤 kind가 필요한가. 2차만 설정된 기사의 송고 즉시
	 * {@code press} 배부는 완결 요건이 아니다(2차 배부 후에 완결).
	 */
	public static List<String> requiredKinds(Function<String, Object> contents) {
		List<String> kinds = new ArrayList<>();
		for (KindField kindField : KIND_FIELDS) {
			if (truthy(column(contents, kindField.field()))) {
				kinds.add(kindField.kind());
			}
		}
		return List.copyOf(kinds);
	}

	/**
	 * 이미 배부된 kind 목록 — <b>"역사상 어디로 나갔나"</b>(정정본 대상 판정: 송고 훅).
	 *
	 * <p>배부 실행이 실제 스풀 기록 1건 이상일 때만 남기는 ({@code eventType='distribute'},
	 * {@code action=kind}) 행이 "이미 배부됨"의 유일한 근거다. 이력은 append-only라 과거 배부 사이클의
	 * 기록도 그대로 포함된다 — 그것이 이 함수의 의미다. 이번 사이클 한정 판정이 필요하면
	 * {@link #cycleDistributedKinds}를 써라(<b>두 함수는 서로를 대체하지 않는다</b>).
	 */
	public static List<String> distributedKinds(List<Map<String, Object>> historyRows) {
		Set<Object> seen = new HashSet<>();
		for (Map<String, Object> row : rows(historyRows)) {
			if (row != null && DISTRIBUTE.equals(row.get("eventType"))) {
				seen.add(row.get("action"));
			}
		}

		List<String> kinds = new ArrayList<>();
		for (KindField kindField : KIND_FIELDS) {
			if (seen.contains(kindField.kind())) {
				kinds.add(kindField.kind());
			}
		}
		return List.copyOf(kinds);
	}

	/**
	 * 사이클 경계 = 가장 최근 송고 이력의 id. 송고 이력은 상태 전이 직후 배부 훅보다 <b>먼저</b>
	 * insert되므로 그 사이클의 배부는 전부 경계보다 뒤(id가 크다)에 남는다.
	 *
	 * <p>정렬에 의존하지 않고 <b>값으로만</b> 최대를 고른다(호출자가 다른 정렬로 넘길 수 있다).
	 * <b>{@code createdAt}은 쓰지 않는다</b> — 같은 밀리초 충돌·백필 데이터로 신뢰도가 낮고, 단조 증가하는
	 * id가 유일하게 결정적인 순서다. id가 정수가 아닌 송고 행은 후보에서 제외한다(경계 미확정 → 전체 이력).
	 *
	 * <p>공개하는 이유: 재전송의 {@code stale-cycle} 게이트가 <b>같은</b> 경계를 써야 한다 — 판정을
	 * 복제하면 사이클 어휘가 두 곳에서 갈라진다.
	 *
	 * @return 경계 id, 확정 불가(송고 이력 없음·id 결손)면 {@code null}
	 */
	public static Long latestSendId(List<Map<String, Object>> historyRows) {
		Long boundaryId = null;
		for (Map<String, Object> row : rows(historyRows)) {
			if (row == null || !STATUS.equals(row.get("eventType")) || !SEND.equals(row.get("action"))) {
				continue;
			}
			Long id = integerId(row.get("id"));
			if (id != null && (boundaryId == null || id > boundaryId)) {
				boundaryId = id;
			}
		}
		return boundaryId;
	}

	/**
	 * 이번 배부 사이클에서 이미 배부된 kind — <b>"이번 사이클에서 이미 보냈나"</b>(도래·완결 판정:
	 * tick·상태 승격). 경계보다 뒤(id가 큰) {@code distribute} 이력만 이번 사이클로 센다.
	 *
	 * <p>경계를 확정할 수 없으면 <b>전체 이력을 센다</b>(안전측 — "배부 이력 없음"으로 폴백하면 엠바고
	 * 시각 전 배부로 이어진다).
	 */
	public static List<String> cycleDistributedKinds(String status, List<Map<String, Object>> historyRows) {
		List<Map<String, Object>> rows = rows(historyRows);
		// 경계 밖 상태(DPS·RDS·EEK…)는 전체 이력 판정 그대로다 — kind 필터링을 복제하지 않는다.
		if (status == null || !CYCLE_SCOPED_STATUSES.contains(status)) {
			return distributedKinds(rows);
		}

		Long boundaryId = latestSendId(rows);
		if (boundaryId == null) {
			return distributedKinds(rows);
		}

		// CRITICAL(안전측 방향): id를 알 수 없는 distribute 행은 이번 사이클에 **포함해서** 센다.
		// 순진한 `id > boundary`는 그 행을 빼는데, 그 방향은 "이미 배부됨"을 좁혀 조기 배부가 된다.
		List<Map<String, Object>> inCycle = new ArrayList<>();
		for (Map<String, Object> row : rows) {
			if (row == null) {
				continue;
			}
			Long id = integerId(row.get("id"));
			if (id == null || id > boundaryId) {
				inCycle.add(row);
			}
		}
		return distributedKinds(inCycle);
	}

	/**
	 * 값이 있으나 파싱할 수 없는 엠바고 필드명. 엠바고 시각 입력란은 자유 텍스트라 오타가 들어올 수 있고,
	 * 그런 값은 배부되지 않으므로(안전 기본값) 호출자가 표면화할 수 있어야 한다 — <b>무음 삼킴 금지</b>.
	 */
	public static List<String> unparsableEmbargoFields(Function<String, Object> contents) {
		List<String> fields = new ArrayList<>();
		for (KindField kindField : KIND_FIELDS) {
			Object value = column(contents, kindField.field());
			if (truthy(value) && NodeInstants.parseIsoMillis(value) == null) {
				fields.add(kindField.field());
			}
		}
		return List.copyOf(fields);
	}

	/**
	 * 지금 배부해야 할 kind. 도래하지 않았거나 이미 배부됐거나 파싱 불가면 배부하지 않는다(안전 기본값).
	 *
	 * @param status 기사 상태. {@link #EMBARGO_DISTRIBUTABLE_STATUSES} 밖이면 빈 목록이다.
	 * @param contents 공통정보 컬럼 접근자
	 * @param distributed 이미 배부된 kind(= {@link #cycleDistributedKinds} 결과). {@code null} 허용.
	 * @param now 현재 시각 — <b>ISO-8601 UTC 문자열</b>이다. 숫자 epoch ms를 넘기면 Node와 마찬가지로
	 *     파싱 불가로 떨어지므로 <b>아무것도 배부하지 않는다</b>(잘못된 시계로 조기 배부하지 않는다).
	 * @return 배부할 kind(항상 {@code [press, nonpress]} 순서)
	 */
	public static List<String> dueKinds(String status, Function<String, Object> contents,
			Collection<String> distributed, Object now) {
		if (status == null || !EMBARGO_DISTRIBUTABLE_STATUSES.contains(status)) {
			return List.of();
		}

		Long nowMs = NodeInstants.parseIsoMillis(now);
		if (nowMs == null) {
			return List.of();
		}

		Set<String> done = toKindSet(distributed);
		List<String> due = new ArrayList<>();
		for (KindField kindField : KIND_FIELDS) {
			if (done.contains(kindField.kind())) {
				continue; // 멱등 — tick 중복 호출에도 재배부하지 않는다.
			}
			Long at = NodeInstants.parseIsoMillis(column(contents, kindField.field()));
			if (at != null && at <= nowMs) {
				due.add(kindField.kind());
			}
		}
		return List.copyOf(due);
	}

	/**
	 * 배부 이력에 비춰 기사 상태가 무엇이어야 하는가. <b>바꿀 필요가 없으면 {@code null}</b>이다.
	 *
	 * <p>완결(required ⊆ distributed) → {@code DPS}, 1건 이상 배부 → {@code EPS}, 아니면 {@code DES}.
	 * 1차만 설정된 기사가 {@code DES}에서 곧장 {@code DPS}가 되는 것은 의도된 결과다(같은 배부가 첫
	 * 배부이자 완결).
	 */
	public static String embargoStatusFor(String status, Function<String, Object> contents,
			Collection<String> distributed) {
		List<String> required = requiredKinds(contents);
		if (required.isEmpty()) {
			return null; // 엠바고 미설정 — 이 모듈은 관여하지 않는다.
		}
		// DPS(완결·레거시)·EEK·EEH·DPD·RDS 등은 건드리지 않는다. 상태 역행/부활 금지.
		if (status == null || !MUTABLE_STATUSES.contains(status)) {
			return null;
		}

		Set<String> done = toKindSet(distributed);
		String next = done.containsAll(required) ? "DPS" : (done.isEmpty() ? "DES" : "EPS");

		if (next.equals(status)) {
			return null; // 무의미한 쓰기 금지.
		}
		if ("EPS".equals(status) && "DES".equals(next)) {
			return null; // 역행 금지(이력 유실·부분 실패로 뒤로 가지 않는다). EPS → DPS 승격은 막지 않는다.
		}
		return next;
	}

	/** 배부 kind와 그 엠바고 컬럼의 짝. */
	private record KindField(String kind, String field) {
	}

	/**
	 * 컬럼 하나를 읽는다. 접근자가 없으면({@code null}) 모든 컬럼이 비어 있는 것으로 본다 —
	 * Node {@code asObject}와 같은 방향이다(판정 모듈이 호출자를 깨뜨리지 않는다).
	 */
	private static Object column(Function<String, Object> contents, String name) {
		return (contents == null) ? null : contents.apply(name);
	}

	/** JS {@code Boolean(value)} — 빈 문자열·0·false·{@code null}만 미설정이다(공백 문자열은 설정이다). */
	private static boolean truthy(Object value) {
		if (value == null) {
			return false;
		}
		if (value instanceof String text) {
			return !text.isEmpty();
		}
		if (value instanceof Boolean flag) {
			return flag;
		}
		if (value instanceof Number number) {
			double numeric = number.doubleValue();
			return numeric != 0.0d && !Double.isNaN(numeric);
		}
		return true;
	}

	/** 미지 값은 버린다({@code null} 목록 포함) — Node {@code toKindSet}과 같다. */
	private static Set<String> toKindSet(Collection<String> distributed) {
		Set<String> kinds = new HashSet<>();
		if (distributed != null) {
			for (KindField kindField : KIND_FIELDS) {
				if (distributed.contains(kindField.kind())) {
					kinds.add(kindField.kind());
				}
			}
		}
		return kinds;
	}

	/**
	 * Node {@code Number.isInteger(id)}의 이식 — 정수가 아니면 {@code null}("순서를 모른다"). 문자열 id는
	 * 정수가 아니다(SQLite {@code INTEGER} 컬럼은 그런 값을 주지 않지만, 판정이 그 사실에 기대지 않는다).
	 */
	private static Long integerId(Object id) {
		if (id instanceof Integer || id instanceof Long || id instanceof Short || id instanceof Byte) {
			return ((Number) id).longValue();
		}
		if (id instanceof Double || id instanceof Float) {
			double numeric = ((Number) id).doubleValue();
			if (!Double.isNaN(numeric) && !Double.isInfinite(numeric) && numeric == Math.rint(numeric)) {
				return (long) numeric;
			}
		}
		return null;
	}

	private static List<Map<String, Object>> rows(List<Map<String, Object>> historyRows) {
		return (historyRows == null) ? List.of() : historyRows;
	}

	private EmbargoPolicy() {
	}
}
