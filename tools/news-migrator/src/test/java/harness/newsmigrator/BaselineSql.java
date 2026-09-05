package harness.newsmigrator;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Flyway 기반선({@code V1__baseline.sql})을 기계로 읽는 파서 — 사람 눈 대조를 금지하기 위한 도구다.
 *
 * <p>파서가 단순할 수 있는 이유는 <b>기반선이 단순하기 때문</b>이다: 문장은
 * {@code CREATE TABLE IF NOT EXISTS} 7개뿐이고, 컬럼 제약은 컬럼 줄 안에만 있으며(별도
 * {@code PRIMARY KEY (...)} 절을 쓰지 않는다), 보조 인덱스·FK 가 없다. 그 단순함 자체가
 * {@code BaselineMatchesCanonicalSchemaTest} 의 단언 대상이다 — 복잡해지면 파서가 먼저 죽는다.
 */
final class BaselineSql {

	/** {@code CREATE TABLE IF NOT EXISTS <이름> (} — 이 형태가 아닌 문장은 파서가 거부한다. */
	private static final Pattern CREATE_TABLE =
			Pattern.compile("(?is)^\\s*CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+(\\w+)\\s*\\((.*)\\)([^)]*)$");

	private BaselineSql() {
	}

	/** {@code ;} 로 끊어 빈 문장을 버린다(주석 줄은 문장이 아니다). */
	static List<String> statements(String sql) {
		List<String> statements = new ArrayList<>();
		for (String raw : stripComments(sql).split(";")) {
			String trimmed = raw.strip();
			if (!trimmed.isEmpty()) {
				statements.add(trimmed);
			}
		}
		return statements;
	}

	/** 테이블 이름 → 컬럼 정의 목록(선언 순서 보존). */
	static Map<String, List<Column>> tables(String sql) {
		Map<String, List<Column>> tables = new LinkedHashMap<>();
		for (String statement : statements(sql)) {
			Matcher matcher = CREATE_TABLE.matcher(statement);
			if (!matcher.matches()) {
				throw new IllegalStateException("기반선에 CREATE TABLE IF NOT EXISTS 가 아닌 문장이 있다: " + statement);
			}
			List<Column> columns = new ArrayList<>();
			for (String piece : splitTopLevel(matcher.group(2))) {
				String definition = piece.strip();
				int space = definition.indexOf(' ');
				if (space < 0) {
					throw new IllegalStateException("컬럼 정의를 읽지 못했다: " + definition);
				}
				columns.add(new Column(definition.substring(0, space), definition.substring(space + 1).strip()));
			}
			tables.put(matcher.group(1), columns);
		}
		return tables;
	}

	/** 테이블 이름 → {@code )} 뒤의 테이블 옵션({@code ENGINE=InnoDB ...}). */
	static Map<String, String> tableOptions(String sql) {
		Map<String, String> options = new LinkedHashMap<>();
		for (String statement : statements(sql)) {
			Matcher matcher = CREATE_TABLE.matcher(statement);
			if (matcher.matches()) {
				options.put(matcher.group(1), matcher.group(3).strip());
			}
		}
		return options;
	}

	/** 괄호 깊이 0의 쉼표로만 끊는다 — {@code VARCHAR(768)} 안의 쉼표에 속지 않기 위해서다. */
	private static List<String> splitTopLevel(String body) {
		List<String> pieces = new ArrayList<>();
		StringBuilder piece = new StringBuilder();
		int depth = 0;
		for (int i = 0; i < body.length(); i++) {
			char c = body.charAt(i);
			if (c == '(') {
				depth++;
			}
			else if (c == ')') {
				depth--;
			}
			if (c == ',' && depth == 0) {
				pieces.add(piece.toString());
				piece.setLength(0);
				continue;
			}
			piece.append(c);
		}
		if (!piece.toString().isBlank()) {
			pieces.add(piece.toString());
		}
		return pieces;
	}

	private static String stripComments(String sql) {
		StringBuilder out = new StringBuilder(sql.length());
		for (String line : sql.split("\n")) {
			String trimmed = line.strip();
			if (trimmed.startsWith("--")) {
				continue;
			}
			out.append(line).append('\n');
		}
		return out.toString();
	}

	/** 기반선의 한 컬럼 — 이름과 MySQL 정의 원문. */
	record Column(String name, String definition) {
	}

}
