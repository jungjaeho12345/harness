package harness.news.service;

import harness.news.web.NodeNumber;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * 배부 실패 원장 파생 — 리포 루트 {@code src/services/distributionFailureLog.js}(106행)의 1:1 이식이며
 * {@link EmbargoPolicy}와 같은 관례의 <b>순수 모듈</b>이다(DB·HTTP·파일시스템·시계 비의존).
 *
 * <p>답하는 질문은 둘뿐이다:
 * <ol>
 *   <li>이 이벤트 행들에서 "아직 해소되지 않은 수신처 단위 실패"는 무엇인가 → {@link #unresolvedFailures}</li>
 *   <li>이 {@code (articleId, targetId)} 쌍에 미해소 실패가 있는가 → {@link #findUnresolvedFailure}</li>
 * </ol>
 * 답하지 않는 것: 조회·기록(호출자 책임), 재전송 실행, 인가, 시점 판정({@link EmbargoPolicy#dueKinds}).
 *
 * <p>원장은 <b>append-only</b>다 — 행을 지우거나 갱신하지 않으므로 "해소됨"도 새 행
 * ({@code distribute-retry})으로만 표현한다(ADR-008 (6)). 미해소 판정: <b>(articleId, targetId, action)
 * 그룹에서 id가 가장 큰 행</b>이 {@code distribute-failed}면 미해소, {@code distribute-retry}면 해소.
 *
 * <p><b>기각한 대안</b>: "실패 행 이후 같은 kind의 {@code distribute} 행이 있으면 해소" 휴리스틱 — 한
 * 배부 호출 안에서 kind 행이 실패 행보다 뒤에 기록되는 id 순서 불변식에 판정이 의존하게 되고, 그 순서가
 * 깨지면 신선한 미발송이 조용히 사라진다(무음 실패). <b>과다 보고(안전 방향)</b>를 택한다.
 *
 * <p><b>이 파생을 복제하지 마라.</b> 목록({@code GET /api/distribution/failures})과 재전송 게이트
 * ({@code POST /api/distribution/retry})가 <b>같은 함수 하나</b>를 부른다. 두 곳이 갈라지면 목록에 없는
 * 실패로 재전송이 통과한다 — 인가 우회다.
 */
public final class DistributionFailureLog {

	/** 수신처 단위 배부 실패 이력의 {@code eventType}. */
	public static final String DISTRIBUTE_FAILED_EVENT = "distribute-failed";

	/** 그 실패를 해소하는 재전송 이력의 {@code eventType}. 해소는 이 행으로만 표현된다. */
	public static final String DISTRIBUTE_RETRY_EVENT = "distribute-retry";

	/**
	 * 재전송으로 복구 가능한 실패 사유 — {@code SpoolWriter}가 실제로 돌려주는 토큰 중 <b>수신처 단위
	 * 실패</b>만 담는 단일 출처다(불변, 정확히 3개).
	 *
	 * <p>CRITICAL: {@code status-changed}를 담지 마라 — 기사가 배부 불가 상태로 전이된 <b>안전 중단</b>이라
	 * 재전송 대상이 아니고, 영속하면 영원히 해소되지 않는 항목이 원장에 쌓인다. {@code spool-disabled}도
	 * 담지 마라 — 배부 기능 자체가 꺼진 상태(설정 부재)이지 특정 수신처의 실패가 아니다.
	 */
	public static final List<String> RETRYABLE_FAILURE_REASONS =
			List.of("spool-write-failed", "invalid-spool-dir", "invalid-article-id");

	/**
	 * 미해소 실패 1건 — <b>정확히 6키</b>다.
	 *
	 * <p>이 값은 {@code GET /api/distribution/failures} 응답으로 그대로 나간다. <b>경로성 필드
	 * ({@code spoolDir}·{@code file})를 절대 더하지 마라</b> — 서버 파일시스템 경로가 새어 나간다.
	 *
	 * @param historyId 실패 이력 행의 id. 재전송의 <b>유일한 입력</b>이다(articleId·targetId·kind는 전부
	 *     이 행에서만 도출한다 — 클라이언트가 고르면 ADR-004 위반이다).
	 * @param targetId 정규화된 수신처 id. Node의 number와 같은 표현({@code double})이라
	 *     {@code DistributionTargetRepository.findById(double)}에 그대로 넘어가고 행 맵의 {@code id}
	 *     ({@code Long})와도 값 비교가 성립한다. <b>HTTP 응답으로 옮길 때는 정수를 소수점 없이 실어야
	 *     한다</b>(Node {@code JSON.stringify(3)}은 {@code 3}이다).
	 * @param kind 배부 kind(= 이력 행의 {@code action}) — {@code press}·{@code nonpress}
	 * @param reason 실패 사유 토큰. 없으면 {@code null}(빈 문자열은 빈 문자열 그대로다)
	 * @param failedAt 실패 시각(= 이력 행의 {@code createdAt}). 없으면 {@code null}
	 */
	public record Failure(long historyId, String articleId, double targetId, String kind, String reason,
			String failedAt) {
	}

	/** 이 사유가 재전송으로 복구 가능한가. 문자열이 아니면 거짓이다(관용 없는 정확 일치). */
	public static boolean isRetryableFailureReason(Object reason) {
		return reason instanceof String text && RETRYABLE_FAILURE_REASONS.contains(text);
	}

	/**
	 * 아직 해소되지 않은 수신처 단위 실패를 파생한다. 같은 쌍에 실패가 여러 번 쌓여도 1건으로 접힌다
	 * (최신 실패의 사유·시각·historyId).
	 *
	 * <p>정렬에 의존하지 않고 <b>id로만</b> 판정한다 — 호출자가 어떤 순서로 넘겨도 결과가 같다.
	 *
	 * @param rows {@code ArticleHistoryRepository.queryDistributionEvents()} 결과. {@code null} 허용.
	 * @return 최신 실패 우선({@code historyId} DESC)의 불변 목록
	 */
	public static List<Failure> unresolvedFailures(List<Map<String, Object>> rows) {
		// 그룹 키 (articleId, targetId, action) → 그 그룹에서 id가 가장 큰 행.
		Map<GroupKey, LedgerRow> latestByGroup = new LinkedHashMap<>();
		for (Map<String, Object> raw : (rows == null) ? List.<Map<String, Object>>of() : rows) {
			LedgerRow row = normalizeRow(raw);
			if (row == null) {
				continue;
			}
			GroupKey key = new GroupKey(row.articleId(), row.targetId(), row.kind());
			LedgerRow previous = latestByGroup.get(key);
			// 같은 id가 두 번 오면 먼저 본 행이 남는다(Node의 엄격 부등호와 같다).
			if (previous == null || row.id() > previous.id()) {
				latestByGroup.put(key, row);
			}
		}

		List<Failure> items = new ArrayList<>();
		for (LedgerRow row : latestByGroup.values()) {
			if (!DISTRIBUTE_FAILED_EVENT.equals(row.eventType())) {
				continue; // 최신이 retry → 해소.
			}
			items.add(new Failure(row.id(), text(row.articleId()), row.targetId(), row.kind(),
					text(row.reason()), text(row.createdAt())));
		}
		items.sort(Comparator.comparingLong(Failure::historyId).reversed());
		return List.copyOf(items);
	}

	/**
	 * 이 {@code (articleId, targetId)} 쌍의 미해소 실패 항목. 없으면 {@code null}.
	 *
	 * <p>그룹 키가 3원소라 같은 쌍에 kind 2종이 동시에 미해소일 수 있다 — 그중 {@code historyId}가 가장
	 * 큰(가장 최근) 1건을 돌려준다. <b>kind는 인자로 받지 않는다</b>(클라이언트가 kind를 고르면 안 된다 —
	 * 배부 kind는 실패 이력에서만 도출한다, ADR-004).
	 *
	 * <p><b>판정 규칙을 복제하지 않고</b> {@link #unresolvedFailures}를 부른다 — 목록과 재전송 게이트가
	 * 갈라지면 목록에 없는 실패로 재전송이 통과한다.
	 *
	 * @param targetId 정규화 전 값. 정규화할 수 없으면 {@code null}을 돌려준다(전역 스캔으로 번지지 않는다).
	 */
	public static Failure findUnresolvedFailure(List<Map<String, Object>> rows, String articleId,
			Object targetId) {
		Double queried = normalizeTargetId(targetId);
		if (queried == null) {
			return null;
		}
		// 반환이 historyId DESC라 첫 매치가 가장 최근 항목이다.
		for (Failure item : unresolvedFailures(rows)) {
			if (Objects.equals(item.articleId(), articleId)
					&& Double.compare(item.targetId(), queried.doubleValue()) == 0) {
				return item;
			}
		}
		return null;
	}

	/** 그룹 키. 문자열을 이어 붙이지 않으므로 구분자 충돌이 원천적으로 없다. */
	private record GroupKey(Object articleId, double targetId, String kind) {
	}

	/** 판정에 참여할 수 있게 정규화된 이력 행. */
	private record LedgerRow(long id, Object articleId, String eventType, String kind, double targetId,
			Object reason, Object createdAt) {
	}

	/**
	 * 판정에 참여할 수 있는 행인가 — 아니면 <b>조용히 무시</b>한다({@code null} 반환, throw 금지). 원장에는
	 * 레거시·수기 행이 있을 수 있고, 판정 모듈이 호출자를 깨뜨리면 실패 목록 조회 하나가 500이 된다.
	 */
	private static LedgerRow normalizeRow(Map<String, Object> row) {
		if (row == null) {
			return null;
		}
		Object eventType = row.get("eventType");
		if (!DISTRIBUTE_FAILED_EVENT.equals(eventType) && !DISTRIBUTE_RETRY_EVENT.equals(eventType)) {
			return null; // 배부 어휘 밖(distribute·status…)은 판정에 참여하지 않는다.
		}
		Long id = integerId(row.get("id"));
		if (id == null) {
			return null; // 순서를 모르는 행으로 "최신"을 정할 수 없다.
		}
		if (!(row.get("action") instanceof String kind)) {
			return null;
		}
		Double targetId = normalizeTargetId(row.get("targetId"));
		if (targetId == null) {
			return null; // 수신처를 특정할 수 없는 실패는 원장 항목이 될 수 없다.
		}
		return new LedgerRow(id.longValue(), row.get("articleId"), (String) eventType, kind,
				targetId.doubleValue(), row.get("reason"), row.get("createdAt"));
	}

	/**
	 * {@code targetId}를 수로 정규화한다 — DB는 {@code INTEGER}지만 HTTP 경계에서 문자열이 올 수 있다.
	 * {@code null}·빈 문자열·비유한 값은 {@code null}이고 그 행은 판정에서 빠진다.
	 *
	 * <p>문자열 판독은 <b>{@link NodeNumber#toNumber}</b> 단일 출처다(decisions (18)).
	 * {@code Integer.parseInt}는 {@code "3.0"}·{@code "0x3"}을 거부하고 {@code Double.parseDouble}은
	 * Node가 {@code NaN}을 주는 {@code "3d"}를 받아들인다 — 어느 쪽이든 두 서버가 같은 원장에서 다른
	 * 그룹을 만든다. 공백 제거도 그 안의 {@link NodeString#trim}이 소유한다(NBSP 포함).
	 *
	 * <p>빈 문자열 검사는 <b>trim 이전</b>이다(Node {@code value === ''}) — 공백만 있는 문자열은
	 * {@code Number(' ') === 0}이라 수신처 0으로 참여한다.
	 *
	 * <p>수·문자열이 아닌 값({@code Boolean}·목록)은 {@code null}이다: Node {@code ToNumber}는
	 * {@code true}를 1로 읽지만 그 1은 <b>실재하지 않는 수신처 id</b>이고, 리포지토리는 {@code Long}·
	 * {@code String}·{@code null}만 준다(도달 불가 경로에서 엉뚱한 수신처를 지목하지 않는다).
	 */
	private static Double normalizeTargetId(Object value) {
		if (value == null || "".equals(value)) {
			return null;
		}
		double numeric;
		if (value instanceof Number number) {
			numeric = number.doubleValue();
		}
		else if (value instanceof CharSequence text) {
			numeric = NodeNumber.toNumber(text.toString());
		}
		else {
			return null;
		}
		if (!Double.isFinite(numeric)) {
			return null; // NaN · ±Infinity
		}
		// -0을 0으로 접는다 — Node는 문자열 키라 둘 다 "0"이고, 같은 수신처가 두 그룹으로 갈리면 안 된다.
		return Double.valueOf(numeric == 0.0d ? 0.0d : numeric);
	}

	/**
	 * Node {@code Number.isInteger(id)}의 이식 — 정수가 아니면 {@code null}("순서를 모른다"). 문자열 id는
	 * 정수가 아니다(SQLite {@code INTEGER} 컬럼은 그런 값을 주지 않지만, 판정이 그 사실에 기대지 않는다).
	 *
	 * <p>여기 두는 이유: {@link NodeNumber#integerOf}는 <b>문자열</b> 도메인의 판독이라({@code "7"}을 7로
	 * 읽는다) 이 술어와 반대 방향이고, {@link EmbargoPolicy}의 같은 술어는 {@code private}이라 부를 수
	 * 없다(가시성 확대는 이 step의 증분 범위 밖이다). 세 곳이 같은 규칙을 말하므로 <b>한 곳을 고치면 나머지
	 * 둘을 함께 보라</b>.
	 */
	private static Long integerId(Object id) {
		if (!(id instanceof Number number)) {
			return null;
		}
		double numeric = number.doubleValue();
		if (!Double.isFinite(numeric) || numeric != Math.rint(numeric)) {
			return null;
		}
		if (numeric < Long.MIN_VALUE || numeric > Long.MAX_VALUE) {
			return null; // 이력 id는 SQLite ROWID(int64)다 — 그 밖의 값은 어떤 행도 가리키지 않는다.
		}
		return Long.valueOf((long) numeric);
	}

	/**
	 * 텍스트 컬럼 판독. {@code null}은 {@code null}이고 빈 문자열은 <b>빈 문자열 그대로</b>다(Node
	 * {@code ??} 의미론 — "없음"과 "비었음"은 다른 사실이다). 리포지토리는 이 세 컬럼을 문자열로만 주므로
	 * 그 밖의 타입은 도달하지 않는다.
	 */
	private static String text(Object value) {
		if (value == null) {
			return null;
		}
		return (value instanceof String string) ? string : String.valueOf(value);
	}

	private DistributionFailureLog() {
	}

}
