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
 * 수집 수신 설정 데이터 접근 계층 — 직접 SQL(ORM 없음, ADR-002). 비즈니스 규칙은 없다.
 *
 * <p>리포 루트 {@code src/models/receiverConfigModel.js}와 1:1이다(query·insert·remove 3연산).
 *
 * <p><b>이 서버 유일의 행 삭제 SQL이 여기 있다.</b> {@link #remove(double)}는 {@code ReceiverConfig}
 * 테이블 <b>하나에만</b> {@code DELETE}를 낸다 — 설정 행만 지우고 그 sourceId로 이미 수집된
 * Article/Contents는 건드리지 않는다(DB 비파괴 최상위 규칙의 유일한 설계 예외 · SCHEMA.md ·
 * index.json decisions (1)). 다른 어떤 테이블에도 행 {@code DELETE}를 추가하지 마라.
 *
 * <p>이 클래스의 계약 셋.
 * <ol>
 *   <li><b>컬럼은 화이트리스트({@link RequiredSchema#RECEIVER_CONFIG_COLUMNS})로만 다루고 {@code SELECT *}를
 *       쓰지 않는다.</b> 응답 키 집합이 스키마 변경에 조용히 넓어지지 않는다({@code password}·{@code apiKey}
 *       같은 시크릿을 뺀 투영은 서비스 계층의 몫이다 — 모델은 컬럼만 안다).</li>
 *   <li><b>필터는 화이트리스트 컬럼 AND 동등 비교</b>이고 그 밖의 키는 조용히 무시한다(거부가 아니다).
 *       {@code FILTERABLE}이 {@code password}·{@code apiKey}를 포함하는 것은 Node 동형이다
 *       (결함 후보 #3 — 여기서 고치지 않는다).</li>
 *   <li><b>값 바인딩은 {@link ColumnValues} 정책</b>: 문자열은 텍스트, 숫자는 REAL({@code 42 → "42.0"}),
 *       {@code null}은 SQL NULL. 자체 숫자 포매터를 만들지 않는다(node:sqlite 동형 · gap #4).</li>
 * </ol>
 *
 * <p>{@code id}는 INTEGER PK(ROWID 별칭)라 삽입 대상이 아니고 <b>정수로 읽는다</b>(Node가 number로
 * 돌려주는 것과 동형). 나머지는 VARCHAR라 전부 문자열이다.
 */
@Repository
public class ReceiverConfigRepository {

	private static final String ID = "id";

	private static final String SELECT = "SELECT " + String.join(", ", RequiredSchema.RECEIVER_CONFIG_COLUMNS)
			+ " FROM " + RequiredSchema.RECEIVER_CONFIG_TABLE;

	/**
	 * 필터 화이트리스트 = 요구 스키마 12컬럼(= {@code id} + Node COLUMNS 11개). Node
	 * {@code FILTERABLE = ['id', ...COLUMNS]}와 1:1이다.
	 */
	private static final List<String> FILTERABLE = RequiredSchema.RECEIVER_CONFIG_COLUMNS;

	/** 삽입 화이트리스트 11개 = 요구 컬럼 12개 − {@code id}(자동 증가라 호출자가 값을 줘도 문장에 넣지 않는다). */
	private static final List<String> INSERTABLE = RequiredSchema.RECEIVER_CONFIG_COLUMNS.stream()
			.filter((column) -> !column.equals(ID))
			.toList();

	private final JdbcClient jdbcClient;

	public ReceiverConfigRepository(JdbcClient jdbcClient) {
		this.jdbcClient = jdbcClient;
	}

	/**
	 * 화이트리스트 컬럼 AND 동등 필터로 조회한다({@code ORDER BY id}). 값이 {@code null}인 필터와
	 * 화이트리스트 밖 키는 조건에서 빠진다(Node {@code v === undefined || v === null} 동형).
	 *
	 * @return 각 행은 12키 전부를 스키마 순서로 담고, 값이 SQL NULL이어도 키는 남는다
	 */
	public List<Map<String, Object>> query(Map<String, ?> filters) {
		List<String> conditions = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		for (String column : FILTERABLE) {
			if (filters == null || !filters.containsKey(column)) {
				continue;
			}
			Object value = filters.get(column);
			if (value == null) {
				continue;
			}
			conditions.add(column + " = ?");
			params.add(ColumnValues.bind(value));
		}
		String where = conditions.isEmpty() ? "" : " WHERE " + String.join(" AND ", conditions);
		return this.jdbcClient.sql(SELECT + where + " ORDER BY " + ID)
				.params(params)
				.query(ReceiverConfigRepository::mapRow)
				.list();
	}

	/**
	 * 값이 주어진 화이트리스트 컬럼만 삽입한다(present-only). {@code id}는 넣지 않는다(자동 증가).
	 *
	 * @return 새 행의 id(정수)
	 * @throws IllegalArgumentException 화이트리스트 컬럼이 하나도 없을 때(빈 INSERT를 만들지 않는다)
	 */
	public long insert(Map<String, ?> entry) {
		List<String> columns = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		for (String column : INSERTABLE) {
			if (entry == null || !entry.containsKey(column)) {
				continue;
			}
			columns.add(column);
			params.add(ColumnValues.bind(entry.get(column)));
		}
		if (columns.isEmpty()) {
			throw new IllegalArgumentException(RequiredSchema.RECEIVER_CONFIG_TABLE + ": 입력할 컬럼이 없습니다");
		}

		KeyHolder keys = new GeneratedKeyHolder();
		this.jdbcClient.sql("INSERT INTO " + RequiredSchema.RECEIVER_CONFIG_TABLE + " ("
						+ String.join(", ", columns) + ") VALUES (" + placeholders(columns.size()) + ")")
				.params(params)
				.update(keys);
		Number id = keys.getKey();
		if (id == null) {
			throw new IllegalStateException("수신 설정 행의 id를 돌려받지 못했습니다 — 삽입 결과를 신뢰할 수 없습니다");
		}
		return id.longValue();
	}

	/**
	 * 설정 행을 지운다 — {@code DELETE FROM ReceiverConfig WHERE id = ?}. 이 서버 유일의 행 삭제다.
	 *
	 * <p>라우트가 {@code Number(req.params.id)}로 경로 변수를 숫자화하므로 {@code 'abc'} 같은 값은
	 * {@code NaN}이 된다. Node node:sqlite는 NaN을 바인딩해 매치 0건({@code changes:0})이 되고 던지지
	 * 않는다(2026-08-22 작업 A 실측). JDBC 드라이버가 NaN을 거부해 500이 나지 않도록 <b>NaN이면 조회 자체를
	 * 건너뛰어</b> 같은 결과({@code 0})로 수렴한다(decisions (7)).
	 *
	 * @return 영향 행 수(없는 id·재삭제·NaN → {@code 0})
	 */
	public int remove(double id) {
		if (Double.isNaN(id)) {
			return 0;
		}
		return this.jdbcClient.sql("DELETE FROM " + RequiredSchema.RECEIVER_CONFIG_TABLE + " WHERE " + ID + " = ?")
				.param(id)
				.update();
	}

	/**
	 * 컬럼 목록 순서의 맵. 값이 SQL NULL이어도 <b>키는 남긴다</b>. {@code id}만 정수로 읽고 나머지는
	 * 문자열이다(VARCHAR affinity라 저장도 조회도 문자열 — Node 동형).
	 */
	private static Map<String, Object> mapRow(ResultSet rs, int rowNum) throws SQLException {
		Map<String, Object> row = new LinkedHashMap<>();
		for (String column : RequiredSchema.RECEIVER_CONFIG_COLUMNS) {
			row.put(column, column.equals(ID) ? rs.getLong(column) : rs.getString(column));
		}
		return row;
	}

	private static String placeholders(int count) {
		return String.join(", ", Collections.nCopies(count, "?"));
	}
}
