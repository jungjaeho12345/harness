package harness.news.db;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
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
 *
 * <h2>존재 말고 하나를 더 본다 — 텍스트 PK의 collation (⑤ [med] 3)</h2>
 * MySQL 분기에서는 {@link RequiredSchema#TEXT_PRIMARY_KEYS} 세 컬럼의 <b>실제 collation</b>까지 읽어
 * {@link #REQUIRED_PK_COLLATION}과 대조한다. 존재 검증만으로 부족한 이유는 이 축이
 * <b>값이 아니라 비교 규칙</b>이기 때문이다: 컬럼이 {@code utf8mb4_0900_ai_ci}면 {@code WHERE userId = ?}가
 * 대소문자·전각·자모를 같다고 보고, {@code utf8mb4_bin}이면 PAD SPACE라 {@code 'x' = 'x '}가 참이 된다 —
 * 둘 다 <b>다른 계정으로 로그인이 되는</b> 상태이고, 그런데도 서버는 정상 기동하며 계약 하네스도 green이다
 * (하네스는 자기가 만든 계정만 쓰므로 그 차이를 밟지 않는다). 기반선 밖 수기 {@code ALTER}/{@code CONVERT}
 * 한 번이면 도달한다.
 *
 * <p>{@code NewsDataSource#verifySession}이 이미 {@code sql_mode}·문자셋·접속 collation을 read-back 하지만
 * <b>컬럼 collation이 접속 collation을 이긴다</b>(축 3·11 실측). 즉 세션은 전부 정상인 채로 이 축만 무너질
 * 수 있고, 그래서 확인 지점이 세션이 아니라 <b>스키마</b>다.
 *
 * <p><b>{@code DialectSeamTest}와의 관계(판정)</b>: 그 게이트가 한 파일로 모으는 것은 <b>실행되는 방언
 * 철자</b> 6종 — 두 방언의 <b>드라이버 좌표·URL 스킴·전용 함수 이름</b>이다(목록은 그 테스트의
 * {@code DIALECT_SPELLINGS}에 있다. 여기에 옮겨 적으면 <b>이 파일이 그 집합에 들어가</b> 게이트가 red다 —
 * 그 스캔은 주석을 구분하지 않는다. 2026-09-04 실측으로 확인했다). 아래 질의와 상수에는 그 6종이 하나도
 * 없어서 허용 집합은 그대로 {@code NewsDataSource.java} 하나로 남는다(충돌 없음).
 *
 * <p>자리도 여기가 맞다: 이것은 <b>스키마 요구사항</b>이지 접속 방식이 아니다. 요구 목록의 출처는 여전히
 * {@link RequiredSchema} 하나이고, 이 클래스는 "그 요구가 실제로 서 있는가"만 읽는다.
 */
public class SchemaGuard {

	/**
	 * 텍스트 PK가 반드시 가져야 하는 collation — phase 75 step1이 12축 실측으로 확정한 값이다.
	 *
	 * <p>세 축({@code =}·{@code ORDER BY}·{@code LIKE})을 동시에 만족하는 값은 <b>없다</b>. 이것만이
	 * {@code =}(보안 축)와 {@code ORDER BY}에서 SQLite BINARY와 완전히 일치하고, 포기한 축은
	 * {@code LIKE} 대소문자다(docs/db-mysql-mapping.md 축 3·4·5 · §4). 이 상수를 바꾸는 것은 인증
	 * 의미론을 바꾸는 일이고, 마이그레이터 기반선({@code V1__baseline.sql})의 값과 <b>같아야</b> 한다.
	 */
	public static final String REQUIRED_PK_COLLATION = "utf8mb4_0900_bin";

	/**
	 * 컬럼 collation을 읽는 질의 — <b>지금 접속한 스키마</b>로 좁힌다({@code DATABASE()}).
	 *
	 * <p>좁히지 않으면 접속 자격이 보는 다른 스키마의 동명 테이블이 섞여 들어와 "우리 컬럼"으로 오인된다
	 * ({@link #readColumns}가 카탈로그를 좁히는 것과 같은 이유다). 문자 컬럼이 아니면
	 * {@code COLLATION_NAME}이 {@code NULL}이므로 결과에 나타나지 않고, 그 부재 자체를 문제로 본다.
	 */
	private static final String COLUMN_COLLATION_QUERY =
			"SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME FROM information_schema.COLUMNS"
					+ " WHERE TABLE_SCHEMA = DATABASE() AND COLLATION_NAME IS NOT NULL";

	private final DataSource dataSource;

	private final String target;

	private final boolean mysql;

	/**
	 * @param dataSource 검증 대상 커넥션 풀
	 * @param target 실패 메시지가 지목할 대상 표기 — {@link NewsDataSource#describeTarget}가 만든다
	 *     (sqlite는 파일 경로, mysql은 권한부를 지운 URL)
	 * @param mysql collation 검증까지 할 것인가. <b>명시 주입이고 추론이 없다</b> — 판정의 단일 출처는
	 *     {@link DbProperties#mysql()}이다(URL이나 {@code DatabaseMetaData}의 제품명을 보고 짐작하면
	 *     "설정을 빠뜨린 배포가 조용히 검증을 건너뛰는" 경로가 생긴다)
	 */
	public SchemaGuard(DataSource dataSource, String target, boolean mysql) {
		this.dataSource = dataSource;
		this.target = target;
		this.mysql = mysql;
	}

	/**
	 * 요구 테이블·컬럼의 존재를 확인하고, mysql 분기에서는 텍스트 PK의 collation까지 확인한다. 읽기만 한다.
	 *
	 * @throws IllegalStateException 없는 테이블/컬럼이 있거나 텍스트 PK의 collation이 다를 때
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
		if (problems.isEmpty() && this.mysql) {
			problems.addAll(textPrimaryKeyCollationProblems());
		}
		if (!problems.isEmpty()) {
			throw new IllegalStateException(
					"DB 스키마가 이 서버의 요구를 만족하지 않습니다 (" + this.target + "): "
							+ String.join(" / ", problems)
							+ ". 이 서버는 스키마를 만들거나 고치지 않습니다 — Node 서버로 데이터 디렉토리를 준비한 뒤 다시 실행하세요.");
		}
	}

	/**
	 * 텍스트 PK 세 컬럼의 collation을 읽어 {@link #REQUIRED_PK_COLLATION}과 대조한다(mysql 전용).
	 *
	 * <p>테이블·컬럼 이름 대조는 대소문자를 무시한다 — MySQL은 {@code lower_case_table_names=1}이라
	 * 테이블 이름을 소문자로 돌려주고(축 10), 컬럼 이름은 원 표기를 보존한다. <b>읽히지 않은 컬럼도
	 * 문제로 본다</b>: 문자 컬럼이 아니게 바뀌었거나(예: {@code VARBINARY}) 카탈로그가 보여 주지 않는
	 * 상태라면 우리가 가정한 비교 의미론이 서 있다는 근거가 없다.
	 *
	 * <p>메시지는 <b>기대값과 실제값을 둘 다</b> 싣는다 — 운영자가 무엇을 무엇으로 되돌려야 하는지
	 * 알아야 한다. 값 자체는 collation 이름이라 비밀이 아니다.
	 */
	private List<String> textPrimaryKeyCollationProblems() {
		Map<String, String> actual = readTextPrimaryKeyCollations();
		List<String> problems = new ArrayList<>();
		for (Map.Entry<String, String> required : new TreeMap<>(RequiredSchema.TEXT_PRIMARY_KEYS).entrySet()) {
			String where = required.getKey() + "." + required.getValue();
			String collation = actual.get(key(required.getKey(), required.getValue()));
			if (collation == null) {
				problems.add("텍스트 기본키 " + where + " 의 collation 을 읽지 못했습니다"
						+ "(문자 컬럼이 아니거나 카탈로그에 없습니다 — 기대: " + REQUIRED_PK_COLLATION + ")");
			}
			else if (!REQUIRED_PK_COLLATION.equals(collation)) {
				problems.add("텍스트 기본키 " + where + " 의 collation 이 " + REQUIRED_PK_COLLATION
						+ " 가 아닙니다(actual=" + collation + ") — 이 컬럼의 비교 규칙이 곧 로그인·조회의 규칙입니다");
			}
		}
		return problems;
	}

	/** 지금 접속한 스키마의 문자 컬럼 collation 표({@code 테이블.컬럼} 소문자 키). */
	private Map<String, String> readTextPrimaryKeyCollations() {
		Map<String, String> byColumn = new LinkedHashMap<>();
		try (Connection connection = this.dataSource.getConnection();
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery(COLUMN_COLLATION_QUERY)) {
			while (rs.next()) {
				byColumn.put(key(rs.getString(1), rs.getString(2)), rs.getString(3));
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException(
					"텍스트 기본키의 collation 을 읽지 못했습니다 (" + this.target + ")", ex);
		}
		return byColumn;
	}

	private static String key(String table, String column) {
		return (table + "." + column).toLowerCase(Locale.ROOT);
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
