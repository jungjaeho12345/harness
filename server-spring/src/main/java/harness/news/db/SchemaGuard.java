package harness.news.db;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.sql.DataSource;

/**
 * 부팅 스키마 검증(읽기 전용).
 *
 * <p>이 서버는 스키마를 만들지도 고치지도 않는다 — 정본은 Node 서버의 {@code src/db/schema.js}다.
 * 그래서 부팅 시 할 수 있는 유일한 방어는 "요구하는 테이블·컬럼이 실제로 있는지 읽어 보는 것"이고,
 * 없으면 <b>무엇이 없는지 지목하고 뜨지 않는다</b>. 조용히 떠서 첫 로그인에서 터지면 원인이 설정인지
 * 코드인지 구분되지 않고, 특히 잠금 컬럼이 없으면 계정 잠금 계약이 런타임에 소리 없이 무력화된다.
 *
 * <p>요구 목록의 출처는 {@link RequiredSchema} 하나다.
 *
 * <p><b>방언 중립이다</b>(ADR-016 · phase 75 step5): 컬럼 목록을 SQLite 전용 테이블 값 함수가 아니라
 * JDBC {@link DatabaseMetaData}로 읽는다. 같은 코드가 두 방언에서 그대로 돌고, 방언 철자는
 * {@link NewsDataSource} 한 파일에만 남는다.
 */
public class SchemaGuard {

	private final DataSource dataSource;

	private final String target;

	/**
	 * @param dataSource 검증 대상 커넥션 풀
	 * @param target 실패 메시지가 지목할 대상 표기 — {@link NewsDataSource#describeTarget}가 만든다
	 *     (sqlite는 파일 경로, mysql은 권한부를 지운 URL)
	 */
	public SchemaGuard(DataSource dataSource, String target) {
		this.dataSource = dataSource;
		this.target = target;
	}

	/**
	 * 요구 테이블·컬럼의 존재를 확인한다. 읽기만 한다.
	 *
	 * @throws IllegalStateException 없는 테이블/컬럼이 하나라도 있을 때
	 */
	public void verify() {
		Map<String, Set<String>> actual = readColumns(RequiredSchema.TABLES.keySet());
		List<String> problems = new ArrayList<>();
		for (Map.Entry<String, List<String>> required : RequiredSchema.TABLES.entrySet()) {
			String table = required.getKey();
			Set<String> columns = actual.getOrDefault(table, Set.of());
			if (columns.isEmpty()) {
				problems.add("테이블 없음 = " + table);
				continue;
			}
			List<String> missing = required.getValue().stream()
					.filter(column -> !columns.contains(column.toLowerCase(Locale.ROOT)))
					.toList();
			if (!missing.isEmpty()) {
				problems.add("테이블 " + table + " 에 없는 컬럼 = " + String.join(", ", missing));
			}
		}
		if (!problems.isEmpty()) {
			throw new IllegalStateException(
					"DB 스키마가 이 서버의 요구를 만족하지 않습니다 (" + this.target + "): "
							+ String.join(" / ", problems)
							+ ". 이 서버는 스키마를 만들거나 고치지 않습니다 — Node 서버로 데이터 디렉토리를 준비한 뒤 다시 실행하세요.");
		}
	}

	/**
	 * 요구 테이블들의 실제 컬럼 이름(소문자)을 <b>커넥션 하나로</b> 읽는다. 없는 테이블은 빈 집합이다.
	 *
	 * <p>이름 비교는 양쪽 모두 소문자로 접는다. SQLite 식별자는 대소문자를 구분하지 않고(예전 DB가 다른
	 * 표기로 같은 컬럼을 가질 수 있다 — Node의 마이그레이션도 같은 보정을 한다), MySQL은
	 * {@code lower_case_table_names=1}이라 테이블 이름이 소문자로 저장된다(컬럼 이름은 원래 표기가
	 * 보존된다 — 실측). 그래서 카탈로그가 돌려준 테이블 이름도 대소문자를 무시하고 대조한다.
	 *
	 * <p>커넥션을 하나만 여는 이유는 풀 상한이 1이기 때문이다({@link NewsDataSource#MAX_POOL_SIZE}) —
	 * 테이블마다 열고 닫으면 부팅 경로가 풀을 7번 오간다.
	 *
	 * <p>카탈로그는 <b>현재 접속한 것</b>으로 좁힌다. MySQL은 접속 자격이 보는 모든 스키마에서 같은 이름의
	 * 테이블을 돌려줄 수 있어(예: 시스템 스키마의 동명 테이블) 좁히지 않으면 다른 DB의 컬럼을 우리 것으로
	 * 오인할 수 있다. SQLite는 카탈로그 개념이 없어 {@code null}이고, 그때는 좁히지 않는다.
	 */
	private Map<String, Set<String>> readColumns(Set<String> tables) {
		Map<String, Set<String>> byTable = new LinkedHashMap<>();
		try (Connection connection = this.dataSource.getConnection()) {
			String catalog = connection.getCatalog();
			if (catalog != null && catalog.isBlank()) {
				catalog = null;
			}
			DatabaseMetaData metaData = connection.getMetaData();
			for (String table : tables) {
				byTable.put(table, columnsOf(metaData, catalog, table));
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("DB 스키마를 읽지 못했습니다 (" + this.target + ")", ex);
		}
		return byTable;
	}

	/**
	 * 테이블 하나의 컬럼 이름(소문자).
	 *
	 * <p>카탈로그가 돌려준 행을 <b>테이블 이름으로 한 번 더 거른다</b>: {@code getColumns}의 세 번째 인자는
	 * 패턴이라 {@code _}·{@code %}가 와일드카드로 해석된다(우리 테이블 이름에는 없지만, 그 사실에 기대는
	 * 대신 결과를 확인한다). 이름 대조는 대소문자를 무시한다 — MySQL이 소문자로 돌려주기 때문이다.
	 */
	private static Set<String> columnsOf(DatabaseMetaData metaData, String catalog, String table)
			throws SQLException {
		Set<String> lowered = new LinkedHashSet<>();
		try (ResultSet rs = metaData.getColumns(catalog, null, table, "%")) {
			while (rs.next()) {
				if (!table.equalsIgnoreCase(rs.getString("TABLE_NAME"))) {
					continue;
				}
				String name = rs.getString("COLUMN_NAME");
				if (name != null) {
					lowered.add(name.toLowerCase(Locale.ROOT));
				}
			}
		}
		return lowered;
	}
}
