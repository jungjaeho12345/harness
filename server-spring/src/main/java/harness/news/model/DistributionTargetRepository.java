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
 * 배부 수신처 데이터 접근 계층 — 직접 SQL(ORM 없음, ADR-002). 비즈니스 규칙은 없다.
 *
 * <p>리포 루트 {@code src/models/distributionTargetModel.js}와 1:1이다(query·findById·insert·update).
 *
 * <p><b>삭제 함수를 두지 않는다.</b> 대상 제거는 {@code active='N'} update(soft delete)가 유일한 경로다
 * (DB 비파괴 최상위 규칙 · SCHEMA.md · ADR-008 · index.json decisions (1)). 검증(kind enum·spoolDir
 * 슬러그·name 필수)과 stamp는 서비스 계층 책임이다(ADR-006). {@code spoolDir}는 문자열 컬럼일 뿐이며 이
 * 계층은 디렉토리를 만들거나 파일을 쓰지 않는다(스풀 쓰기는 배부 실행 phase).
 *
 * <p>이 클래스의 계약 셋(기사 리포지토리와 동형).
 * <ol>
 *   <li><b>컬럼은 화이트리스트({@link RequiredSchema#DISTRIBUTION_TARGET_COLUMNS})로만 다루고
 *       {@code SELECT *}를 쓰지 않는다.</b></li>
 *   <li><b>present-only</b>: insert·update 모두 값이 주어진 컬럼만 문장에 넣는다. {@code id}는
 *       INTEGER PK(ROWID 별칭)라 삽입/수정 대상이 아니다. update의 대상 컬럼이 0개면 문장을 실행하지
 *       않고 {@code 0}이다(no-op).</li>
 *   <li><b>값 바인딩은 {@link ColumnValues} 정책</b>(문자열 텍스트·숫자 REAL·null SQL NULL · gap #4).</li>
 * </ol>
 *
 * <p>{@code id}는 정수로 읽는다(Node가 number로 돌려주는 것과 동형). {@link #findById(double)}는 라우트가
 * {@code Number(req.params.id)}로 만든 값을 받으므로 <b>NaN이면 조회를 건너뛰어 {@code null}</b>이다
 * (Node {@code findById(NaN)}이 매치 없이 undefined를 돌려주는 것과 동형 — JDBC NaN 바인딩 거부 회피).
 */
@Repository
public class DistributionTargetRepository {

	private static final String ID = "id";

	private static final String SELECT = "SELECT " + String.join(", ", RequiredSchema.DISTRIBUTION_TARGET_COLUMNS)
			+ " FROM " + RequiredSchema.DISTRIBUTION_TARGET_TABLE;

	/** 필터 화이트리스트 = 요구 스키마 7컬럼(= {@code id} + Node COLUMNS 6개). */
	private static final List<String> FILTERABLE = RequiredSchema.DISTRIBUTION_TARGET_COLUMNS;

	/** 삽입/수정 화이트리스트 6개 = 요구 컬럼 7개 − {@code id}. */
	private static final List<String> WRITABLE = RequiredSchema.DISTRIBUTION_TARGET_COLUMNS.stream()
			.filter((column) -> !column.equals(ID))
			.toList();

	private final JdbcClient jdbcClient;

	public DistributionTargetRepository(JdbcClient jdbcClient) {
		this.jdbcClient = jdbcClient;
	}

	/**
	 * 화이트리스트 컬럼 AND 동등 필터로 조회한다({@code ORDER BY id}). 값이 {@code null}인 필터와
	 * 화이트리스트 밖 키는 조건에서 빠진다.
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
				.query(DistributionTargetRepository::mapRow)
				.list();
	}

	/**
	 * 한 행 또는 {@code null}. {@code id}가 NaN이면 조회를 건너뛴다(Node undefined 동형).
	 */
	public Map<String, Object> findById(double id) {
		if (Double.isNaN(id)) {
			return null;
		}
		return this.jdbcClient.sql(SELECT + " WHERE " + ID + " = ?")
				.param(id)
				.query(DistributionTargetRepository::mapRow)
				.optional()
				.orElse(null);
	}

	/**
	 * 값이 주어진 화이트리스트 컬럼만 삽입한다(present-only). {@code id}는 넣지 않는다(자동 증가).
	 *
	 * @return 새 행의 id(정수)
	 * @throws IllegalArgumentException 화이트리스트 컬럼이 하나도 없을 때
	 */
	public long insert(Map<String, ?> entry) {
		List<String> columns = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		for (String column : WRITABLE) {
			if (entry == null || !entry.containsKey(column)) {
				continue;
			}
			columns.add(column);
			params.add(ColumnValues.bind(entry.get(column)));
		}
		if (columns.isEmpty()) {
			throw new IllegalArgumentException(RequiredSchema.DISTRIBUTION_TARGET_TABLE + ": 입력할 컬럼이 없습니다");
		}

		KeyHolder keys = new GeneratedKeyHolder();
		this.jdbcClient.sql("INSERT INTO " + RequiredSchema.DISTRIBUTION_TARGET_TABLE + " ("
						+ String.join(", ", columns) + ") VALUES (" + placeholders(columns.size()) + ")")
				.params(params)
				.update(keys);
		Number id = keys.getKey();
		if (id == null) {
			throw new IllegalStateException("배부 수신처 행의 id를 돌려받지 못했습니다 — 삽입 결과를 신뢰할 수 없습니다");
		}
		return id.longValue();
	}

	/**
	 * present-only SET — 전달한 컬럼만 갱신하고 {@code id}는 SET 대상이 아니다. 대상 컬럼이 0개면 문장을
	 * 실행하지 않고 {@code 0}(no-op)이다. {@code id}가 NaN이면 매치 없이 {@code 0}이다.
	 *
	 * @return 영향 행 수(없는 id·no-op·NaN → {@code 0})
	 */
	public int update(double id, Map<String, ?> fields) {
		if (Double.isNaN(id)) {
			return 0;
		}
		List<String> assignments = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		for (String column : WRITABLE) {
			if (fields == null || !fields.containsKey(column)) {
				continue;
			}
			assignments.add(column + " = ?");
			params.add(ColumnValues.bind(fields.get(column)));
		}
		if (assignments.isEmpty()) {
			return 0;
		}
		params.add(id);
		return this.jdbcClient.sql("UPDATE " + RequiredSchema.DISTRIBUTION_TARGET_TABLE + " SET "
						+ String.join(", ", assignments) + " WHERE " + ID + " = ?")
				.params(params)
				.update();
	}

	/**
	 * 컬럼 목록 순서의 맵. 값이 SQL NULL이어도 <b>키는 남긴다</b>. {@code id}만 정수로 읽고 나머지는 문자열이다.
	 */
	private static Map<String, Object> mapRow(ResultSet rs, int rowNum) throws SQLException {
		Map<String, Object> row = new LinkedHashMap<>();
		for (String column : RequiredSchema.DISTRIBUTION_TARGET_COLUMNS) {
			row.put(column, column.equals(ID) ? rs.getLong(column) : rs.getString(column));
		}
		return row;
	}

	private static String placeholders(int count) {
		return String.join(", ", Collections.nCopies(count, "?"));
	}
}
