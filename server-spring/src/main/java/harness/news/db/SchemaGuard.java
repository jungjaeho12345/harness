package harness.news.db;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * 부팅 스키마 검증(읽기 전용).
 *
 * <p>이 서버는 스키마를 만들지도 고치지도 않는다 — 정본은 Node 서버의 {@code src/db/schema.js}다.
 * 그래서 부팅 시 할 수 있는 유일한 방어는 "요구하는 테이블·컬럼이 실제로 있는지 읽어 보는 것"이고,
 * 없으면 <b>무엇이 없는지 지목하고 뜨지 않는다</b>. 조용히 떠서 첫 로그인에서 터지면 원인이 설정인지
 * 코드인지 구분되지 않고, 특히 잠금 컬럼이 없으면 계정 잠금 계약이 런타임에 소리 없이 무력화된다.
 *
 * <p>요구 목록의 출처는 {@link RequiredSchema} 하나다.
 */
public class SchemaGuard {

	private final JdbcClient jdbcClient;

	private final Path dbFile;

	public SchemaGuard(JdbcClient jdbcClient, Path dbFile) {
		this.jdbcClient = jdbcClient;
		this.dbFile = dbFile;
	}

	/**
	 * 요구 테이블·컬럼의 존재를 확인한다. 읽기만 한다.
	 *
	 * @throws IllegalStateException 없는 테이블/컬럼이 하나라도 있을 때
	 */
	public void verify() {
		List<String> problems = new ArrayList<>();
		for (Map.Entry<String, List<String>> required : RequiredSchema.TABLES.entrySet()) {
			String table = required.getKey();
			Set<String> actual = columnsOf(table);
			if (actual.isEmpty()) {
				problems.add("테이블 없음 = " + table);
				continue;
			}
			List<String> missing = required.getValue().stream()
					.filter(column -> !actual.contains(column.toLowerCase(Locale.ROOT)))
					.toList();
			if (!missing.isEmpty()) {
				problems.add("테이블 " + table + " 에 없는 컬럼 = " + String.join(", ", missing));
			}
		}
		if (!problems.isEmpty()) {
			throw new IllegalStateException(
					"DB 스키마가 이 서버의 요구를 만족하지 않습니다 (" + dbFile.toAbsolutePath() + "): "
							+ String.join(" / ", problems)
							+ ". 이 서버는 스키마를 만들거나 고치지 않습니다 — Node 서버로 데이터 디렉토리를 준비한 뒤 다시 실행하세요.");
		}
	}

	/**
	 * 테이블의 실제 컬럼 이름(소문자). 테이블이 없으면 빈 집합.
	 *
	 * <p>SQLite 식별자는 대소문자를 구분하지 않으므로 소문자로 맞춰 비교한다(예전 DB가 다른 표기로 같은
	 * 컬럼을 가질 수 있다 — Node의 마이그레이션도 같은 보정을 한다). 테이블 이름은 바인딩 파라미터로
	 * 넘긴다(테이블 값 함수 {@code pragma_table_info}) — SQL 문자열에 식별자를 이어 붙이지 않는다.
	 */
	private Set<String> columnsOf(String table) {
		List<String> names = jdbcClient.sql("SELECT name FROM pragma_table_info(?)")
				.param(table)
				.query(String.class)
				.list();
		Set<String> lowered = new LinkedHashSet<>();
		for (String name : names) {
			lowered.add(name.toLowerCase(Locale.ROOT));
		}
		return lowered;
	}
}
