package harness.newsmigrator;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 이관이 다루는 <b>테이블·컬럼 목록</b> — 기반선({@code db/migration/V1__baseline.sql})에서 읽는다.
 *
 * <h2>왜 손으로 적지 않는가</h2>
 * 목록을 이 클래스에 손으로 적으면 정본({@code src/db/schema.js})에 컬럼이 늘 때 조용히 낡는다. 그리고
 * 그 낡음은 대조가 아니라 <b>운영 데이터가 들어간 뒤</b>에 드러난다. 기반선은 이미
 * {@code BaselineMatchesCanonicalSchemaTest} 가 정본과 기계로 맞춰 두었으므로, 그것을 읽으면 목록의 단일
 * 출처가 정본 하나로 이어진다.
 *
 * <h2>정수/문자열 판정도 여기에서 온다</h2>
 * "무엇을 정수로 옮기는가"는 매핑 규칙(축 6)의 결론이고, 기반선의 {@code BIGINT} 선언이 그 결론의 정본이다.
 * 복사기가 스스로 판단하면 규칙이 두 벌이 되고 두 벌은 반드시 갈린다.
 *
 * <h2>파서가 단순해도 되는 이유</h2>
 * 기반선의 문장은 {@code CREATE TABLE IF NOT EXISTS} 일곱 개뿐이고, 제약은 컬럼 줄 안에만 있으며, 보조
 * 인덱스도 외래 관계도 없다. 그 단순함 자체가 {@code BaselineMatchesCanonicalSchemaTest} 의 단언 대상이다
 * — 기반선이 복잡해지면 이 파서가 먼저 시끄럽게 실패한다.
 */
public final class BaselineSchema {

	/**
	 * 기반선을 적용하면 정본에 <b>없는</b> 테이블이 하나 생긴다 — 이관 원장이다.
	 *
	 * <p>이 이름을 코드 곳곳에서 즉석으로 비교하면 어느 날 한 곳이 빠진다. 그래서 상수로 두고, 대조기는
	 * 이 이름만을 <b>명시적으로</b> 제외한다(ADR-016 트레이드오프 ⑨). 제외가 명시라는 사실은
	 * {@code BaselineSchemaTest} 와 {@code RowCopyOnMysqlTest} 가 각각 단언한다.
	 */
	public static final String MIGRATION_LEDGER_TABLE = "flyway_schema_history";

	/** 기반선 리소스 경로 — 이 모듈의 클래스패스 안이다(실행 디렉토리에 의존하지 않는다). */
	public static final String BASELINE_RESOURCE = "/db/migration/V1__baseline.sql";

	private static final String TABLE_HEAD = "CREATE TABLE IF NOT EXISTS";

	private final Map<String, Table> tables;

	private BaselineSchema(Map<String, Table> tables) {
		this.tables = tables;
	}

	/** 컬럼 하나 — 이름과, 이관이 알아야 하는 두 성질. */
	public record Column(String name, boolean integer, boolean primaryKey) {
	}

	/** 테이블 하나 — 컬럼은 <b>선언 순서</b>를 지킨다. */
	public record Table(String name, List<Column> columns) {

		public List<String> columnNames() {
			return columns().stream().map(Column::name).toList();
		}

		/** 대조에서 행을 짝지을 키. 기반선의 모든 테이블은 단일 컬럼 PK 다. */
		public Column primaryKey() {
			return columns().stream().filter(Column::primaryKey).findFirst()
					.orElseThrow(() -> new IllegalStateException("기반선에 PK 가 없는 테이블이 있다: " + name()));
		}

		/** 이름으로 컬럼을 찾는다(대소문자 무시 — 카탈로그 표기가 서버 설정에 따라 달라진다). */
		public Column column(String columnName) {
			for (Column column : columns()) {
				if (column.name().equalsIgnoreCase(columnName)) {
					return column;
				}
			}
			throw new IllegalArgumentException(name() + " 에 그런 컬럼이 없다: " + columnName);
		}

	}

	/** 클래스패스의 기반선을 읽어 파싱한다. */
	public static BaselineSchema load() {
		try (InputStream stream = BaselineSchema.class.getResourceAsStream(BASELINE_RESOURCE)) {
			if (stream == null) {
				throw new IllegalStateException(
						"기반선 리소스를 찾지 못했다(조용히 건너뛰지 않는다): " + BASELINE_RESOURCE);
			}
			return parse(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	/** 기반선 SQL 원문에서 테이블·컬럼을 읽는다. */
	public static BaselineSchema parse(String sql) {
		Map<String, Table> parsed = new LinkedHashMap<>();
		String source = withoutComments(sql);
		int cursor = 0;
		while (true) {
			int head = indexOfIgnoreCase(source, TABLE_HEAD, cursor);
			if (head < 0) {
				break;
			}
			int nameStart = head + TABLE_HEAD.length();
			int open = source.indexOf('(', nameStart);
			if (open < 0) {
				throw new IllegalStateException("기반선의 테이블 선언이 닫히지 않았다: " + source.substring(head));
			}
			String name = source.substring(nameStart, open).strip();
			int close = matchingParenthesis(source, open);
			List<Column> columns = new ArrayList<>();
			for (String piece : splitTopLevel(source.substring(open + 1, close))) {
				columns.add(column(name, piece));
			}
			if (columns.isEmpty()) {
				throw new IllegalStateException("컬럼이 없는 테이블 선언이다: " + name);
			}
			parsed.put(name, new Table(name, List.copyOf(columns)));
			cursor = close + 1;
		}
		if (parsed.isEmpty()) {
			throw new IllegalStateException("기반선에서 테이블을 하나도 읽지 못했다 — 파서가 낡았다");
		}
		return new BaselineSchema(parsed);
	}

	public List<Table> tables() {
		return List.copyOf(this.tables.values());
	}

	public List<String> tableNames() {
		return List.copyOf(this.tables.keySet());
	}

	/** 이름으로 테이블을 찾는다(대소문자 무시). 없으면 <b>빈 결과가 아니라 오류</b>다. */
	public Table table(String name) {
		for (Table table : this.tables.values()) {
			if (table.name().equalsIgnoreCase(name)) {
				return table;
			}
		}
		throw new IllegalArgumentException("기반선에 그런 테이블이 없다: " + name + " (있는 것: " + tableNames() + ")");
	}

	// --- 파싱 도구 ---

	private static Column column(String table, String piece) {
		String definition = piece.strip();
		int space = definition.indexOf(' ');
		if (space < 0) {
			throw new IllegalStateException(table + " 의 컬럼 정의를 읽지 못했다: " + definition);
		}
		String name = definition.substring(0, space);
		String rest = definition.substring(space + 1).strip().toUpperCase(Locale.ROOT);
		return new Column(name, rest.startsWith("BIGINT"), rest.contains("PRIMARY KEY"));
	}

	private static String withoutComments(String sql) {
		StringBuilder cleaned = new StringBuilder(sql.length());
		for (String line : sql.split("\n", -1)) {
			int comment = line.indexOf("--");
			cleaned.append((comment < 0) ? line : line.substring(0, comment)).append('\n');
		}
		return cleaned.toString();
	}

	private static int indexOfIgnoreCase(String haystack, String needle, int from) {
		return haystack.toUpperCase(Locale.ROOT).indexOf(needle.toUpperCase(Locale.ROOT), from);
	}

	private static int matchingParenthesis(String source, int open) {
		int depth = 0;
		for (int i = open; i < source.length(); i++) {
			char at = source.charAt(i);
			if (at == '(') {
				depth++;
			}
			else if (at == ')') {
				depth--;
				if (depth == 0) {
					return i;
				}
			}
		}
		throw new IllegalStateException("기반선의 괄호가 닫히지 않았다");
	}

	private static List<String> splitTopLevel(String body) {
		List<String> pieces = new ArrayList<>();
		int depth = 0;
		StringBuilder piece = new StringBuilder();
		for (int i = 0; i < body.length(); i++) {
			char at = body.charAt(i);
			if (at == '(') {
				depth++;
			}
			else if (at == ')') {
				depth--;
			}
			if (at == ',' && depth == 0) {
				pieces.add(piece.toString());
				piece.setLength(0);
				continue;
			}
			piece.append(at);
		}
		if (!piece.toString().isBlank()) {
			pieces.add(piece.toString());
		}
		return pieces;
	}

}
