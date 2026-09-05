package harness.news.model;

import harness.news.db.RequiredSchema;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

/**
 * 배부 대상(수신처) 데이터 접근 계층 — 직접 SQL(ORM 없음, ADR-002). 비즈니스 규칙은 없다.
 *
 * <p>리포 루트 {@code src/models/distributionTargetModel.js}와 1:1이다. 연산은 넷이다:
 * 조회({@link #query}) · 단건({@link #findById}) · 생성({@link #insert}) · 부분 갱신({@link #update}).
 *
 * <p><b>삭제 연산은 두지 않는다.</b> 대상 제거는 {@code active='N'} 업데이트(soft delete)가 유일한
 * 경로다(SCHEMA.md 99행·ADR-008 — step1이 좁힌 유일 삭제 예외는 ReceiverConfig 하나뿐이고 이 테이블은
 * 그 예외에 들지 않는다). 이 테이블에 대한 행 삭제 SQL은 정적 스캔이 여전히 거부한다(주석에도 그 토큰을
 * 쓰지 않는다).
 *
 * <p>이 클래스의 계약 셋.
 * <ol>
 *   <li><b>컬럼은 화이트리스트({@link RequiredSchema#DISTRIBUTION_TARGET_COLUMNS})로만 다룬다.</b> 필터·삽입·
 *       갱신 모두 그 목록으로만 SQL을 조립한다.</li>
 *   <li><b>화이트리스트 밖 키는 조용히 무시한다.</b> {@code active}로 <b>자동 필터링하지 않는다</b> —
 *       비활성 행도 목록에 남는 것이 계약이다(decisions (5)).</li>
 *   <li><b>검증(kind enum·spoolDir 슬러그·name 필수)은 하지 않는다</b> — 서비스 계층 책임이다(step5).</li>
 * </ol>
 *
 * <p>{@code id}는 자동 증가 정수(ROWID 별칭)라 삽입/수정 대상이 아니고 조회 결과에서는 정수로 읽는다.
 * id 파라미터를 {@code double}로 받는 이유는 Node 동형이다: 서비스가 {@code Number(id)}로 정규화하며
 * 비수치 id는 NaN이 되어 어떤 행에도 매치되지 않는다(→ not-found, 500 아님). {@code long}이면 NaN을
 * 담을 수 없다. 값 바인딩 정책은 {@link ColumnValues}(phase 69 decisions (8)) 단일 출처다.
 */
@Repository
public class DistributionTargetRepository {

	/**
	 * 삽입/수정 화이트리스트 6개 = 요구 컬럼 7개 − {@code id}.
	 *
	 * <p>{@code id}는 자동 증가 정수(ROWID 별칭)라 삽입·SET 대상이 아니다.
	 */
	static final List<String> WRITABLE_COLUMNS = RequiredSchema.DISTRIBUTION_TARGET_COLUMNS.stream()
			.filter((column) -> !column.equals("id"))
			.toList();

	/** 조회 컬럼은 화이트리스트를 그대로 나열한다 — {@code SELECT *}는 쓰지 않는다. */
	private static final String SELECT_ALL_COLUMNS =
			"SELECT " + String.join(", ", RequiredSchema.DISTRIBUTION_TARGET_COLUMNS)
					+ " FROM " + RequiredSchema.DISTRIBUTION_TARGET_TABLE;

	/** 정수로 읽는 컬럼 — 나머지는 전부 문자열이다. */
	private static final String ID = "id";

	private final JdbcClient jdbcClient;

	public DistributionTargetRepository(JdbcClient jdbcClient) {
		this.jdbcClient = jdbcClient;
	}

	/**
	 * 화이트리스트 컬럼만 AND 동등 필터로 적용한다. 화이트리스트 밖 키·{@code null} 값은 무시하고
	 * {@code active}로 자동 필터링하지 않는다(비활성 행도 남는다). 정렬은 {@code ORDER BY id}.
	 */
	public List<Map<String, Object>> query(Map<String, ?> filters) {
		List<String> conditions = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		if (filters != null) {
			for (String column : RequiredSchema.DISTRIBUTION_TARGET_COLUMNS) {
				Object value = filters.get(column);
				if (value == null) {
					continue;
				}
				conditions.add(column + " = ?");
				params.add(ColumnValues.bind(value));
			}
		}
		String where = conditions.isEmpty() ? "" : " WHERE " + String.join(" AND ", conditions);
		return this.jdbcClient.sql(SELECT_ALL_COLUMNS + where + " ORDER BY id")
				.params(params)
				.query(DistributionTargetRepository::mapRow)
				.list();
	}

	/**
	 * 단건 조회(전체 행). 존재 판정에 쓴다 — 비수치 id는 NaN으로 넘어와 어떤 행에도 매치되지 않아 빈
	 * {@link Optional}이다(서비스가 not-found로 수렴시킨다).
	 *
	 * <p>그 "매치되지 않는다"를 <b>SQL 이전에</b> 판정한다 — 근거는 {@link ColumnValues#matchesNoRow(double)}
	 * (MySQL은 NaN 바인딩에서 문장 자체가 깨져 404가 500이 된다. phase 75 step7 실측).
	 */
	public Optional<Map<String, Object>> findById(double id) {
		if (ColumnValues.matchesNoRow(id)) {
			return Optional.empty();
		}
		return this.jdbcClient.sql(SELECT_ALL_COLUMNS + " WHERE id = ?")
				.param(ColumnValues.bind(Double.valueOf(id)))
				.query(DistributionTargetRepository::mapRow)
				.optional();
	}

	/**
	 * 값이 주어진 화이트리스트 컬럼만 삽입한다({@code id} 제외 — 자동 증가).
	 *
	 * <p><b>id는 삽입한 그 문장에서 회수한다</b>({@link GeneratedKeyHolder} — {@code PhotoRepository}·
	 * {@code ArticleHistoryRepository}의 확립된 패턴). 별도 문장으로 되읽으면 두 문장 사이에서 커넥션이
	 * 풀에 반납되고, 풀 상한이 1이라 모든 스레드가 같은 물리 커넥션을 쓰므로 A의 INSERT → B의 INSERT →
	 * A의 되읽기 순서에서 A가 <b>B의 id</b>를 받는다(그 뒤의 수정·비활성이 남의 행에 적용된다). Node는
	 * 단일 스레드라 없는 결함이라 계약이 관측하지 않는다 — {@code DistributionTargetRepositoryTest}의
	 * 동시 삽입 테스트가 유일 방어선이다.
	 *
	 * <p>2026-09-03(phase 75 step5): 예전 근거인 "삽입과 id 판독을 한 트랜잭션으로 묶는다"(2026-08-24
	 * 리뷰 med)는 <b>더 이상 유효하지 않다</b> — 되읽는 두 번째 문장 자체가 사라져 묶을 대상이 없다.
	 * 그래서 트랜잭션 경계도 함께 걷어냈다(방언 중립이라는 이득이 덤이다: 되읽기 함수는 SQLite 전용이었다).
	 *
	 * @return 새 행의 id(정수)
	 * @throws IllegalArgumentException 화이트리스트 컬럼이 하나도 남지 않을 때(빈 삽입문을 만들지 않는다)
	 */
	public int insert(Map<String, ?> entry) {
		List<String> columns = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		if (entry != null) {
			for (String column : WRITABLE_COLUMNS) {
				if (!entry.containsKey(column)) {
					continue;
				}
				columns.add(column);
				params.add(ColumnValues.bind(entry.get(column)));
			}
		}
		if (columns.isEmpty()) {
			throw new IllegalArgumentException(RequiredSchema.DISTRIBUTION_TARGET_TABLE + ": 입력할 컬럼이 없습니다");
		}
		KeyHolder keys = new GeneratedKeyHolder();
		this.jdbcClient.sql("INSERT INTO " + RequiredSchema.DISTRIBUTION_TARGET_TABLE
						+ " (" + String.join(", ", columns) + ") VALUES (" + placeholders(columns.size()) + ")")
				.params(params)
				.update(keys);
		Number id = keys.getKey();
		if (id == null) {
			throw new IllegalStateException("배부 대상 행의 id를 돌려받지 못했습니다 — 삽입 결과를 신뢰할 수 없습니다");
		}
		return id.intValue();
	}

	/**
	 * present-only SET — 전달한 화이트리스트 컬럼만 바꾸고 나머지는 불변. {@code id}는 SET 대상이 아니다.
	 * 대상 컬럼이 없으면 SQL을 실행하지 않고 0이다(계약이 이 수를 그대로 싣는다).
	 *
	 * @return 영향 받은 행 수
	 */
	public int update(double id, Map<String, ?> fields) {
		List<String> assignments = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		if (fields != null) {
			for (String column : WRITABLE_COLUMNS) {
				if (!fields.containsKey(column)) {
					continue;
				}
				assignments.add(column + " = ?");
				params.add(ColumnValues.bind(fields.get(column)));
			}
		}
		if (assignments.isEmpty()) {
			return 0;
		}
		// 유한하지 않은 id는 0행이다({@link ColumnValues#matchesNoRow}). 값 바인딩이 <b>먼저</b> 도는 순서를
		// 지킨다 — 잘못된 값 타입은 여기서도 예외(500)여야 Node와 같은 답이 된다.
		if (ColumnValues.matchesNoRow(id)) {
			return 0;
		}
		params.add(ColumnValues.bind(Double.valueOf(id)));
		return this.jdbcClient.sql("UPDATE " + RequiredSchema.DISTRIBUTION_TARGET_TABLE
						+ " SET " + String.join(", ", assignments) + " WHERE id = ?")
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
