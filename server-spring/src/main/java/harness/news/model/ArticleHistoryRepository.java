package harness.news.model;

import harness.news.db.RequiredSchema;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

/**
 * 기사 이력 데이터 접근 계층 — 직접 SQL(ORM 없음, ADR-002). 비즈니스 규칙은 없다.
 *
 * <p>리포 루트 {@code src/models/articleHistoryModel.js}와 1:1이다(삽입 1개와 조회 5개 — 배부 이벤트
 * 조회 2종은 배부 실행 phase가 소비자와 함께 채웠다).
 *
 * <p><b>이 원장은 append-only다.</b> 여기 있는 연산은 삽입과 조회뿐이고 행을 고치거나 지우는 연산은
 * 없다. 이력 행은 감사 기록만이 아니라 <b>판정 입력</b>이기도 해서(사이클 경계·배부 멱등) 한 번
 * 사라지면 복구 수단이 없다. 그 사실은 정적 스캔({@code NoSchemaSqlInMainSourcesTest})과 리플렉션
 * 단언({@code ArticleHistoryRepositoryTest})이 함께 지킨다.
 *
 * <p>이 클래스의 계약 넷.
 * <ol>
 *   <li><b>컬럼은 화이트리스트({@link RequiredSchema#HISTORY_COLUMNS})로만 다루고 {@code SELECT *}를
 *       쓰지 않는다.</b> 조회 경로마다 나가는 컬럼이 고정이고, 스키마가 넓어져도 응답이 따라 넓어지지
 *       않는다.</li>
 *   <li><b>목록 조회는 본문(blob)을 읽지 않는다.</b> 존재 여부만 {@code hasSnapshot} <b>정수 1/0</b>으로
 *       파생한다 — 이 응답은 전 사용자에게 열린 경량 이력보기 계약이다.</li>
 *   <li><b>목록에 배부 컬럼({@code targetId}·{@code reason})을 싣지 않는다.</b> 수신처 id와 실패 사유는
 *       Z 전용 표면이라 {@link #queryDistributionEvents}·{@link #getDistributionEventById}로만 나간다.
 *       <b>두 조회를 합치지 마라</b> — 합치는 순간 이력보기 응답이 그만큼 넓어진다.</li>
 *   <li><b>단건 스냅샷은 언제나 {@code articleId}로 스코프한다.</b> 스코프를 빼면 id 하나로 다른 기사의
 *       본문을 읽는 권한 우회가 된다.</li>
 * </ol>
 *
 * <p>돌려주는 행은 평범한 {@code LinkedHashMap}이다({@code Contents} 행과 달리 불투명 명목 타입으로
 * 감싸지 않는다 — 이력 행에는 응답에서 제거해야 할 컬럼이 없고, 조회 SQL이 이미 나갈 컬럼만
 * 고른다). 값이 SQL NULL이어도 <b>키는 남긴다</b>(decisions (5) — 키 없음과 null은 다르다).
 */
@Repository
public class ArticleHistoryRepository {

	/**
	 * 삽입 화이트리스트 11개 = 요구 컬럼 12개 − {@code id}.
	 *
	 * <p>{@code id}는 자동 증가 정수(ROWID 별칭)라 삽입 대상이 아니다 — 호출자가 값을 주더라도 문장에
	 * 들어가지 않는다(들어가면 원장의 순서를 호출자가 정하게 된다).
	 */
	static final List<String> INSERTABLE_COLUMNS = RequiredSchema.HISTORY_COLUMNS.stream()
			.filter((column) -> !column.equals("id"))
			.toList();

	/**
	 * 목록 조회가 싣는 실컬럼 8개. 아홉 번째 키 {@code hasSnapshot}은 컬럼이 아니라 파생이다.
	 * 본문({@code markupVersion})·저장 제목({@code snapshotTitle})·배부 2컬럼은 여기 없다.
	 */
	private static final List<String> LIST_COLUMNS = List.of(
			"id", "articleId", "eventType", "action", "fromStatus", "toStatus", "actorUserId", "createdAt");

	/** 단건 스냅샷 조회가 싣는 7컬럼(전이 컬럼 없음, 본문 있음). */
	private static final List<String> SNAPSHOT_COLUMNS = List.of(
			"id", "articleId", "eventType", "action", "actorUserId", "createdAt", "markupVersion");

	/**
	 * 표시 제목 입력 조회의 결과 키 3개. {@code markupVersion}은 실컬럼이 아니라 CASE 별칭이다
	 * (저장 제목이 NULL인 레거시 행에서만 값이 있다).
	 */
	private static final List<String> TITLE_INPUT_COLUMNS = List.of("id", "snapshotTitle", "markupVersion");

	/**
	 * 배부 이벤트 조회 2종이 싣는 8컬럼. 목록 조회의 9키와 <b>다르다</b>: 전이 2컬럼·{@code hasSnapshot}이
	 * 없고 대신 {@code targetId}·{@code reason}이 있다. 순서가 곧 응답 키 순서다.
	 */
	private static final List<String> DISTRIBUTION_EVENT_COLUMNS = List.of(
			"id", "articleId", "eventType", "action", "targetId", "reason", "actorUserId", "createdAt");

	/**
	 * 배부 이벤트 어휘 2개. 모델은 도메인에 의존하지 않으므로 문자열만 둔다(Node 모델과 같은 규율 —
	 * 어휘의 출처는 배부 도메인이다). <b>두 조회 모두</b> 이 필터를 건다: 단건 조회에서 빼면 임의 id로
	 * 본문 스냅샷 행이 재전송 경로로 새어 나간다.
	 */
	private static final List<String> DISTRIBUTION_EVENT_TYPES = List.of("distribute-failed", "distribute-retry");

	/**
	 * 배부 이벤트 조회의 기본 창 — Node {@code DISTRIBUTION_EVENTS_DEFAULT_LIMIT} 실측값(2026-08-25).
	 * 보조 인덱스 없이 id DESC 스캔 + LIMIT이라 창은 비용 인식의 결과다(SCHEMA.md).
	 *
	 * <p>이것은 <b>모델의 기본값</b>일 뿐 서비스의 클램프가 아니다. 표시용 목록 창과 게이트용 스캔은
	 * 상한이 서로 다르며, 그 판단을 여기로 끌어오면 게이트가 조용히 좁아진다.
	 */
	static final int DISTRIBUTION_EVENTS_DEFAULT_LIMIT = 500;

	/** 정수로 읽는 컬럼 — 나머지는 전부 문자열이다. */
	private static final String ID = "id";

	/**
	 * 정수 또는 NULL로 읽는 컬럼({@code INTEGER} affinity) — 배부 이벤트 조회에만 실린다.
	 * 문자열이나 실수로 읽으면 {@code DistributionTarget.id}와의 매칭이 조용히 깨진다.
	 */
	private static final String TARGET_ID = "targetId";

	/**
	 * 본문 스냅샷 보유 판정. {@code length(markupVersion) > 0}과 동치다(NULL→NULL, ''→0).
	 * 이 술어가 바뀌면 이력 목록의 버전 계산 입력이 함께 바뀐다.
	 */
	private static final String HAS_SNAPSHOT =
			"CASE WHEN markupVersion IS NOT NULL AND markupVersion != '' THEN 1 ELSE 0 END AS hasSnapshot";

	private final JdbcClient jdbcClient;

	public ArticleHistoryRepository(JdbcClient jdbcClient) {
		this.jdbcClient = jdbcClient;
	}

	/**
	 * 이력 1행 적재. 화이트리스트 컬럼 중 <b>키가 주어진 것만</b> 넣는다(주지 않은 컬럼은 문장에 없으므로
	 * NULL로 남고, 값 {@code null}을 명시하면 SQL NULL이 들어간다 — Node {@code obj[c] !== undefined} 동형).
	 *
	 * @return 새 행의 id(정수). 배부 실패 목록의 재전송 식별자({@code historyId})가 이 id다.
	 * @throws IllegalArgumentException 화이트리스트 컬럼이 하나도 없을 때(빈 INSERT를 만들지 않는다)
	 */
	public long insert(Map<String, ?> record) {
		List<String> columns = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		for (String column : INSERTABLE_COLUMNS) {
			if (record == null || !record.containsKey(column)) {
				continue;
			}
			columns.add(column);
			params.add(ColumnValues.bind(record.get(column)));
		}
		if (columns.isEmpty()) {
			throw new IllegalArgumentException(RequiredSchema.HISTORY_TABLE + ": 입력할 컬럼이 없습니다");
		}

		KeyHolder keys = new GeneratedKeyHolder();
		this.jdbcClient.sql("INSERT INTO " + RequiredSchema.HISTORY_TABLE + " ("
						+ String.join(", ", columns) + ") VALUES (" + placeholders(columns.size()) + ")")
				.params(params)
				.update(keys);
		Number id = keys.getKey();
		if (id == null) {
			throw new IllegalStateException("이력 행의 id를 돌려받지 못했습니다 — 삽입 결과를 신뢰할 수 없습니다");
		}
		return id.longValue();
	}

	/**
	 * 해당 기사의 이력을 <b>최신순(id 내림차순)</b>으로 돌려준다. 같은 시각의 행이 여럿일 수 있어 순서의
	 * 기준은 시각이 아니라 id다.
	 *
	 * <p>행은 실컬럼 8개 + 파생 {@code hasSnapshot}(정수 1/0) = <b>9키</b>다. 본문은 싣지 않는다 —
	 * 필요하면 {@link #querySnapshotById}로만 읽는다.
	 */
	public List<Map<String, Object>> queryByArticle(String articleId) {
		return this.jdbcClient.sql("SELECT " + String.join(", ", LIST_COLUMNS) + ", " + HAS_SNAPSHOT
						+ " FROM " + RequiredSchema.HISTORY_TABLE + " WHERE articleId = ? ORDER BY id DESC")
				.param(ColumnValues.bind(articleId))
				.query(ArticleHistoryRepository::mapListRow)
				.list();
	}

	/**
	 * 단건 스냅샷 조회 — 본문 포함 7키. <b>{@code id}와 {@code articleId} 둘 다</b> 조건이다(다른 기사의
	 * 본문이 id만으로 새지 않게 — 권한 우회 방지).
	 *
	 * @return 없으면 {@code null}
	 */
	public Map<String, Object> querySnapshotById(String articleId, long id) {
		return this.jdbcClient.sql("SELECT " + String.join(", ", SNAPSHOT_COLUMNS)
						+ " FROM " + RequiredSchema.HISTORY_TABLE + " WHERE id = ? AND articleId = ?")
				// id는 조회 조건일 뿐이라 저장 표현 정책(ColumnValues)을 태우지 않는다 — 정수 컬럼에 정수를 준다.
				.params(List.<Object>of(id, ColumnValues.bind(articleId)))
				.query(ArticleHistoryRepository::mapSnapshotRow)
				.optional()
				.orElse(null);
	}

	/**
	 * 이력 목록 '제목' 파생의 입력을 한 번에 읽는다 — <b>행 단위 폴백을 SQL에서 끝낸다</b>: 저장된 파생
	 * 제목이 있으면 그것만, 없으면(레거시 행) 그 행에 한해 본문을 함께 싣는다. 그래서 서비스에 2차 blob
	 * 조회가 없다.
	 *
	 * <p>필터는 <b>본문 길이 &gt; 0</b>이고 스냅샷 판정과 동치다. 저장 제목 기준으로 거르면 레거시 행이
	 * 사라져 폴백 대상을 식별할 수 없다 — 금지. WHERE의 {@code markupVersion}은 CASE 별칭이 아니라
	 * 실컬럼이다(SQLite 이름 해석은 FROM 테이블 우선) — <b>별칭 이름을 바꾸지 마라</b>. 바꾸면 필터가
	 * 가리키는 대상이 달라질 수 있다.
	 *
	 * <p><b>{@code length()}는 두 방언에서 값이 다르지만 이 술어는 갈리지 않는다</b>(phase 75 step1 측정 9:
	 * {@code '가나다'}가 SQLite에서는 <b>3</b>(문자), MySQL {@code LENGTH()}에서는 <b>9</b>(바이트)다).
	 * 여기 쓰인 비교는 {@code > 0} = "비어 있지 않은가"라 NULL·빈 문자열·ASCII·한글 어느 행에서도 같은
	 * 결과를 낸다(4행으로 실측 — docs/db-mysql-mapping.md 축 9). 그래서 방언 분기를 두지 않는다.
	 * <b>이 술어를 길이 비교로 바꾸지 마라</b>(예: {@code > 10}) — 그 순간 두 서버가 다른 행 집합을 준다.
	 */
	public List<Map<String, Object>> querySnapshotTitlesByArticle(String articleId) {
		return this.jdbcClient.sql("SELECT id, snapshotTitle,"
						+ " CASE WHEN snapshotTitle IS NULL THEN markupVersion END AS markupVersion"
						+ " FROM " + RequiredSchema.HISTORY_TABLE
						+ " WHERE articleId = ? AND length(markupVersion) > 0 ORDER BY id DESC")
				.param(ColumnValues.bind(articleId))
				.query(ArticleHistoryRepository::mapTitleInputRow)
				.list();
	}

	/**
	 * 배부 실패/재전송 이벤트만 <b>최신순(id 내림차순)</b>으로 돌려준다 — 배부 실패 목록(Z 전용)과
	 * 재전송 대상 확인의 유일한 조회 경로다. 행은 8키({@link #DISTRIBUTION_EVENT_COLUMNS} 순서)다.
	 *
	 * @param articleId 스코프. {@code null}이면 조건을 걸지 않는다(전 기사 — Node의 인자 미지정 동형)
	 * @param limit 창. <b>정수 ≥1이 아니면</b>({@code null}·0·음수) {@link #DISTRIBUTION_EVENTS_DEFAULT_LIMIT}.
	 *     정규화는 여기까지이고 서비스 클램프는 이 계층의 책임이 아니다
	 */
	public List<Map<String, Object>> queryDistributionEvents(String articleId, Integer limit) {
		int window = (limit != null && limit >= 1) ? limit : DISTRIBUTION_EVENTS_DEFAULT_LIMIT;
		StringBuilder where = new StringBuilder("eventType IN (")
				.append(placeholders(DISTRIBUTION_EVENT_TYPES.size()))
				.append(")");
		List<Object> params = new ArrayList<>(eventTypeParams());
		if (articleId != null) {
			where.append(" AND articleId = ?");
			params.add(ColumnValues.bind(articleId));
		}
		// LIMIT도 바인딩 파라미터다 — 값을 SQL 문자열에 잇지 않는다(조립 규율).
		params.add(window);
		return this.jdbcClient.sql("SELECT " + String.join(", ", DISTRIBUTION_EVENT_COLUMNS)
						+ " FROM " + RequiredSchema.HISTORY_TABLE
						+ " WHERE " + where + " ORDER BY id DESC LIMIT ?")
				.params(params)
				.query(ArticleHistoryRepository::mapDistributionEventRow)
				.list();
	}

	/**
	 * 배부 이벤트 단건 조회 — 재전송 식별자({@code historyId})에서 기사·수신처를 도출하는 유일한 경로.
	 *
	 * <p><b>어휘 필터를 여기서도 건다</b>(재전송 게이트의 1차 방어): 빼면 임의 id로 편집 스냅샷 같은
	 * 다른 이벤트 행이 이 경로로 새고, 그 자체가 인가 우회다.
	 *
	 * @return 없거나 배부 이벤트가 아니면 {@code null}
	 */
	public Map<String, Object> getDistributionEventById(long id) {
		List<Object> params = new ArrayList<>();
		// id는 조회 조건일 뿐이라 저장 표현 정책(ColumnValues)을 태우지 않는다 — 정수 컬럼에 정수를 준다.
		params.add(id);
		params.addAll(eventTypeParams());
		return this.jdbcClient.sql("SELECT " + String.join(", ", DISTRIBUTION_EVENT_COLUMNS)
						+ " FROM " + RequiredSchema.HISTORY_TABLE + " WHERE id = ? AND eventType IN ("
						+ placeholders(DISTRIBUTION_EVENT_TYPES.size()) + ")")
				.params(params)
				.query(ArticleHistoryRepository::mapDistributionEventRow)
				.optional()
				.orElse(null);
	}

	/** 어휘 목록을 바인딩 파라미터로 편다 — 목록이 늘면 자리표시자와 값이 함께 늘어난다. */
	private static List<Object> eventTypeParams() {
		List<Object> params = new ArrayList<>();
		for (String eventType : DISTRIBUTION_EVENT_TYPES) {
			params.add(ColumnValues.bind(eventType));
		}
		return params;
	}

	private static Map<String, Object> mapListRow(ResultSet rs, int rowNum) throws SQLException {
		Map<String, Object> row = readRow(rs, LIST_COLUMNS);
		// 정수여야 한다 — 불리언으로 매핑하면 JSON이 true/false가 되어 계약이 그 자리에서 깨진다.
		row.put("hasSnapshot", rs.getInt("hasSnapshot"));
		return row;
	}

	private static Map<String, Object> mapSnapshotRow(ResultSet rs, int rowNum) throws SQLException {
		return readRow(rs, SNAPSHOT_COLUMNS);
	}

	private static Map<String, Object> mapTitleInputRow(ResultSet rs, int rowNum) throws SQLException {
		return readRow(rs, TITLE_INPUT_COLUMNS);
	}

	private static Map<String, Object> mapDistributionEventRow(ResultSet rs, int rowNum) throws SQLException {
		return readRow(rs, DISTRIBUTION_EVENT_COLUMNS);
	}

	/**
	 * 컬럼 목록 순서의 맵. 값이 SQL NULL이어도 <b>키는 남긴다</b>. 정수로 읽는 것은 {@code id}(항상 값이
	 * 있다)와 {@code targetId}(NULL이면 null — 0이 아니다)뿐이고 나머지는 문자열이다(TEXT affinity라
	 * 저장도 조회도 문자열 — Node 동형).
	 */
	private static Map<String, Object> readRow(ResultSet rs, List<String> columns) throws SQLException {
		Map<String, Object> row = new LinkedHashMap<>();
		for (String column : columns) {
			if (column.equals(ID)) {
				row.put(column, rs.getLong(column));
			}
			else if (column.equals(TARGET_ID)) {
				long targetId = rs.getLong(column);
				// wasNull 없이 그대로 담으면 '수신처 없음'이 수신처 0번으로 둔갑한다.
				row.put(column, rs.wasNull() ? null : Long.valueOf(targetId));
			}
			else {
				row.put(column, rs.getString(column));
			}
		}
		return row;
	}

	private static String placeholders(int count) {
		return String.join(", ", Collections.nCopies(count, "?"));
	}
}
