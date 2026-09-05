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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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

	/** 기본값의 두 형태 — 식(기반선이 쓰는 형태)과 리터럴. 값 자체만 뽑는다. */
	private static final Pattern DEFAULT_LITERAL = Pattern.compile("(?i)\\bDEFAULT\\s*\\(?\\s*'([^']*)'");

	private final Map<String, Table> tables;

	private BaselineSchema(Map<String, Table> tables) {
		this.tables = tables;
	}

	/**
	 * 컬럼 하나 — 이름과, 이관이 알아야 하는 세 성질.
	 *
	 * <p>{@code defaultValue} 는 기반선의 식 기본값({@code DEFAULT ('Y')})에서 읽은 <b>값</b>이다(없으면
	 * {@code null}). 역방향 export 가 그것을 SQLite 표기로 되돌려야 하기 때문에 여기서 들고 있는다 —
	 * 기본값이 산출물에서 빠지면, 값 없이 넣는 삽입문(이 리포의 삽입은 전부 동적 컬럼 목록이다)이
	 * 정본에서는 {@code 'Y'} 를 얻고 산출물에서는 NULL 을 얻는다. 그 파일은 "같은 DB" 가 아니다.
	 */
	public record Column(String name, boolean integer, boolean primaryKey, String defaultValue) {
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
		String rest = definition.substring(space + 1).strip();
		String upper = rest.toUpperCase(Locale.ROOT);
		return new Column(name, upper.startsWith("BIGINT"), upper.contains("PRIMARY KEY"), defaultValue(rest));
	}

	/**
	 * 기본값을 읽는다 — 기반선은 식 형태({@code DEFAULT ('Y')})를 쓰지만 리터럴 형태도 받아 준다.
	 *
	 * <p>두 형태를 다 읽는 이유: 기반선이 어느 날 리터럴 형태로 바뀌어도 <b>기본값이 조용히 사라지는</b>
	 * 것보다는 읽히는 편이 안전하다. 어느 형태를 쓸지는 {@code BaselineMatchesCanonicalSchemaTest} 가
	 * 따로 잠근다(LONGTEXT 는 리터럴 기본값을 가질 수 없다 — 1101).
	 */
	private static String defaultValue(String definition) {
		Matcher matcher = DEFAULT_LITERAL.matcher(definition);
		return matcher.find() ? matcher.group(1) : null;
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
