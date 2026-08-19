package harness.news.model;

import harness.news.db.RequiredSchema;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.SqlParameterValue;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * 사용자 데이터 접근 계층 — 직접 SQL(ORM 없음, ADR-002). 비즈니스 규칙은 없다.
 *
 * <p>리포 루트 {@code src/models/userModel.js}와 1:1이다. 연산은 넷뿐이고 <b>삭제 연산은 두지 않는다</b> —
 * 비활성화는 {@code active='N'} 업데이트다(DB 비파괴).
 *
 * <p>두 가지가 이 클래스의 계약이다.
 * <ol>
 *   <li><b>컬럼은 화이트리스트({@link RequiredSchema#USER_COLUMNS})로만 다룬다.</b> 식별자를 요청 입력에서
 *       가져와 SQL에 이어 붙이지 않으므로 임의 컬럼명 주입이 성립하지 않는다.</li>
 *   <li><b>화이트리스트 밖 키는 조용히 무시한다(거부가 아니다).</b> Node 모델이 그렇게 동작하고, 그 위의
 *       REST 계약이 결과를 동결하고 있다: 미지의 필드가 섞인 생성 요청은 200이고, 미지의 키만 온 수정
 *       요청은 200 {@code {changes:0}}이다. 여기서 예외를 던지면 전역 핸들러가 500으로 바꿔 패리티가 깨진다.</li>
 * </ol>
 *
 * <p>반환값은 비밀번호 해시를 포함한 raw({@link UserRow})다 — 응답 투영은 서비스 계층 책임이다.
 */
@Repository
public class UserRepository {

	private static final String COLUMN_LIST = String.join(", ", RequiredSchema.USER_COLUMNS);

	/** 조회 컬럼은 화이트리스트를 그대로 나열한다 — {@code SELECT *}는 쓰지 않는다(응답 투영이 조용히 넓어진다). */
	private static final String SELECT_ALL_COLUMNS =
			"SELECT " + COLUMN_LIST + " FROM " + RequiredSchema.USER_TABLE;

	private final JdbcClient jdbcClient;

	public UserRepository(JdbcClient jdbcClient) {
		this.jdbcClient = jdbcClient;
	}

	/** PK 조회. 없으면 {@code null}. */
	public UserRow findById(String userId) {
		if (userId == null) {
			return null;
		}
		return jdbcClient.sql(SELECT_ALL_COLUMNS + " WHERE userId = ?")
				.param(text(userId))
				.query(UserRepository::mapRow)
				.optional()
				.orElse(null);
	}

	/**
	 * 화이트리스트 컬럼만 AND 동등 필터로 적용한다. 화이트리스트 밖 키와 {@code null} 값은 무시한다
	 * (Node는 {@code undefined}와 {@code null}을 똑같이 건너뛴다 — "값이 null인 행 찾기"는 이 API의 기능이 아니다).
	 */
	public List<UserRow> query(Map<String, ?> filters) {
		List<String> conditions = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		if (filters != null) {
			for (String column : RequiredSchema.USER_COLUMNS) {
				Object value = filters.get(column);
				if (value == null) {
					continue;
				}
				conditions.add(column + " = ?");
				params.add(text(value));
			}
		}
		String where = conditions.isEmpty() ? "" : " WHERE " + String.join(" AND ", conditions);
		return jdbcClient.sql(SELECT_ALL_COLUMNS + where)
				.params(params)
				.query(UserRepository::mapRow)
				.list();
	}

	/**
	 * 값이 주어진 화이트리스트 컬럼만 삽입한다. 비밀번호는 이미 해시된 값을 받는다(해싱은 서비스 책임).
	 *
	 * @return 삽입한 {@code userId}
	 * @throws IllegalArgumentException 화이트리스트 컬럼이 하나도 남지 않을 때(빈 삽입문을 만들지 않는다)
	 */
	public String insert(Map<String, ?> row) {
		List<String> columns = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		if (row != null) {
			for (String column : RequiredSchema.USER_COLUMNS) {
				if (!row.containsKey(column)) {
					continue;
				}
				columns.add(column);
				params.add(text(row.get(column)));
			}
		}
		if (columns.isEmpty()) {
			throw new IllegalArgumentException("UserRepository.insert: 입력할 컬럼이 없습니다");
		}
		String placeholders = String.join(", ", java.util.Collections.nCopies(columns.size(), "?"));
		jdbcClient.sql("INSERT INTO " + RequiredSchema.USER_TABLE
						+ " (" + String.join(", ", columns) + ") VALUES (" + placeholders + ")")
				.params(params)
				.update();
		return row == null ? null : asString(row.get("userId"));
	}

	/**
	 * 값이 주어진 화이트리스트 컬럼만 수정한다. {@code userId}는 SET 대상이 아니다(PK는 바뀌지 않는다).
	 * 값이 {@code null}이면 SQL NULL로 채운다 — 로그인 성공 시 잠금 상태를 비우는 경로가 이것이다(행 삭제 없음).
	 *
	 * @return 영향 받은 행 수. 대상 컬럼이 없으면 SQL을 실행하지 않고 0이다(계약이 이 수를 그대로 싣는다).
	 */
	public int update(String userId, Map<String, ?> patch) {
		List<String> assignments = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		if (patch != null) {
			for (String column : RequiredSchema.USER_COLUMNS) {
				if (column.equals("userId") || !patch.containsKey(column)) {
					continue;
				}
				assignments.add(column + " = ?");
				params.add(text(patch.get(column)));
			}
		}
		if (assignments.isEmpty() || userId == null) {
			return 0;
		}
		params.add(text(userId));
		return jdbcClient.sql("UPDATE " + RequiredSchema.USER_TABLE
						+ " SET " + String.join(", ", assignments) + " WHERE userId = ?")
				.params(params)
				.update();
	}

	private static UserRow mapRow(ResultSet rs, int rowNum) throws SQLException {
		return new UserRow(
				rs.getString("userId"),
				rs.getString("name"),
				rs.getString("password"),
				rs.getString("role"),
				rs.getString("department"),
				rs.getString("departmentCode"),
				rs.getString("active"),
				rs.getString("failedLoginCount"),
				rs.getString("lockedUntil"),
				rs.getString("lastFailedLoginAt"));
	}

	/**
	 * 전 컬럼이 TEXT라 값은 문자열로 바인딩한다. 타입을 명시해 {@code null}도 확정적으로 SQL NULL이 되게 한다
	 * (타입 미상 null 바인딩은 드라이버마다 동작이 갈린다).
	 */
	private static SqlParameterValue text(Object value) {
		return new SqlParameterValue(Types.VARCHAR, asString(value));
	}

	private static String asString(Object value) {
		return value == null ? null : String.valueOf(value);
	}
}
