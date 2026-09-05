package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * 역방향 export 가 만드는 SQLite 스키마가 정본({@code src/db/schema.js})과 <b>동형</b>임을 기계로 대조한다.
 *
 * <h2>왜 이 대조가 필요한가</h2>
 * export 산출물의 값어치는 "Node 서버가 실제로 열 수 있는 롤백 자산"이라는 데 있다(index.json
 * decisions (13)). 그 문장이 참이려면 파일의 스키마가 정본과 같은 모양이어야 한다 — 컬럼이 하나 빠지면
 * Node 는 부팅 중 {@code ALTER ... ADD COLUMN} 으로 <b>조용히</b> 채우고 그 컬럼의 값은 영영 없다.
 * 순서가 어긋나면 <b>위치로</b> 읽는 코드가 옆 컬럼을 읽는다(step3 이 실기 {@code news.db} 에서 실측한
 * 함정과 같은 축이다). 그래서 사람 눈이 아니라 기계가 맞춘다 —
 * {@code BaselineMatchesCanonicalSchemaTest} 와 같은 규율이고, 정본에 컬럼이 늘면 여기가 red 다.
 *
 * <h2>대조하는 것 넷</h2>
 * <b>컬럼 이름</b> · <b>선언 순서</b> · <b>PK</b> · <b>DEFAULT</b>. step4.md 의 A 가 열거한 그대로다.
 *
 * <h2>타입 표기는 왜 글자 그대로 같지 않은가(정직한 기록)</h2>
 * 정본은 같은 뜻을 두 표기로 쓴다 — {@code User} 는 {@code TEXT}, 나머지 여섯 테이블은 {@code VARCHAR}.
 * 그런데 export 의 스키마는 <b>기반선</b>({@code V1__baseline.sql})에서 파생되고, 기반선은 그 둘을 모두
 * {@code LONGTEXT}/{@code VARCHAR(768)} 로 옮기므로 <b>구분이 남아 있지 않다</b>. 되살리려면 "테이블이
 * {@code User} 면 {@code TEXT}" 같은 표를 손으로 적어야 하는데, 그 표는 정본이 바뀌면 조용히 낡는다 —
 * 이 모듈이 줄곧 거부해 온 종류의 코드다. 그래서 텍스트는 한 표기({@code VARCHAR})로 통일하고,
 * <b>SQLite 저장 타입 유사성(affinity)</b>이 같다는 것을 아래에서 기계로 단언한다. SQLite 는 선언 타입의
 * 철자가 아니라 affinity 로 값을 다루므로({@code TEXT} 와 {@code VARCHAR} 는 둘 다 TEXT affinity),
 * 이 차이는 저장·비교·정렬 중 어느 것도 바꾸지 않는다. 그리고 그 사실에 기대지 않는 실증이 따로 있다 —
 * {@code ExportRoundTripOnMysqlTest} 가 실제 산출물의 카탈로그를 정본으로 만든 DB 와 맞춰 본다.
 */
class ExportSchemaTest {

	/** 정수 컬럼의 SQLite 선언 — {@code INTEGER PRIMARY KEY} 는 rowid 별칭이라 <b>글자까지</b> 정본과 같아야 한다. */
	private static final String INTEGER_TYPE = "INTEGER";

	/** 텍스트 컬럼의 SQLite 선언(정본의 {@code TEXT}·{@code VARCHAR} 를 하나로 모은 표기). */
	private static final String TEXT_TYPE = "VARCHAR";

	@Test
	void theExportSchemaDeclaresExactlyTheCanonicalTablesInOrder() {
		assertEquals(new ArrayList<>(CanonicalSchema.load().tables().keySet()),
				new ArrayList<>(exportedTables().keySet()),
				"export 스키마의 테이블 집합·순서가 정본과 다르다");
		assertEquals(7, exportedTables().size(), "정본은 7테이블이다(이관 원장은 export 대상이 아니다)");
		assertFalse(exportedTables().containsKey(BaselineSchema.MIGRATION_LEDGER_TABLE),
				"이관 원장이 export 산출물에 섞였다 — 그 파일을 Node 서버가 열면 정본에 없는 테이블이 남는다");
	}

	/**
	 * <b>이 step 의 A 가 요구하는 동형성</b> — 컬럼 이름 · 순서 · PK · DEFAULT.
	 *
	 * <p>M3(컬럼을 빼거나 순서를 바꾼다)이 red 를 내는 자리가 여기다.
	 */
	@Test
	void everyColumnNameOrderPrimaryKeyAndDefaultMatchesTheCanonicalSchema() {
		Map<String, List<String>> expected = new LinkedHashMap<>();
		for (Map.Entry<String, List<CanonicalSchema.Column>> table : CanonicalSchema.load().tables().entrySet()) {
			List<String> columns = new ArrayList<>();
			for (CanonicalSchema.Column column : table.getValue()) {
				columns.add(column.name() + " " + translate(column));
			}
			expected.put(table.getKey(), columns);
		}

		Map<String, List<String>> actual = new LinkedHashMap<>();
		for (Map.Entry<String, List<BaselineSql.Column>> table : exportedTables().entrySet()) {
			List<String> columns = new ArrayList<>();
			for (BaselineSql.Column column : table.getValue()) {
				columns.add(column.name() + " " + column.definition());
			}
			actual.put(table.getKey(), columns);
		}

		assertEquals(expected, actual,
				"export 스키마가 정본과 동형이 아니다(컬럼 이름·순서·PK·DEFAULT 중 하나가 어긋났다)");
	}

	/**
	 * 정본과 <b>글자까지 다른 컬럼</b>은 정확히 "정본이 {@code TEXT} 로 선언한 것들"이고, 그 차이는
	 * SQLite affinity 로 같다.
	 *
	 * <p>이 단언이 위 머리말의 주장을 기계로 붙잡는다 — 목록을 손으로 적지 않고 정본에서 계산하므로,
	 * 어느 날 다른 컬럼이 표기를 벗어나면 여기가 red 다.
	 */
	@Test
	void theOnlyTextualDeviationFromTheCanonicalDeclarationIsTheInterchangeableTextKeyword() {
		List<String> deviating = new ArrayList<>();
		List<String> declaredAsText = new ArrayList<>();
		Map<String, List<BaselineSql.Column>> exported = exportedTables();
		for (Map.Entry<String, List<CanonicalSchema.Column>> table : CanonicalSchema.load().tables().entrySet()) {
			List<BaselineSql.Column> columns = exported.get(table.getKey());
			for (int i = 0; i < table.getValue().size(); i++) {
				CanonicalSchema.Column canonical = table.getValue().get(i);
				String where = table.getKey() + "." + canonical.name();
				if (canonical.definition().toUpperCase(Locale.ROOT).startsWith("TEXT")) {
					declaredAsText.add(where);
				}
				if (!canonical.definition().equals(columns.get(i).definition())) {
					deviating.add(where);
				}
				assertEquals(affinity(canonical.definition()), affinity(columns.get(i).definition()),
						where + " 의 저장 타입 유사성(affinity)이 정본과 다르다 — 값의 저장·비교가 갈린다");
			}
		}

		assertEquals(declaredAsText, deviating,
				"정본과 표기가 다른 컬럼이 'TEXT 로 선언된 것들' 이외로 번졌다(또는 그 목록이 비었다)");
		assertFalse(declaredAsText.isEmpty(), "정본에 TEXT 선언이 하나도 없다 — 이 단언이 공허해졌다");
	}

	/**
	 * {@code INTEGER PRIMARY KEY} 는 <b>글자까지</b> 정본과 같다.
	 *
	 * <p>SQLite 에서 그 선언만이 rowid 별칭이다. {@code BIGINT PRIMARY KEY} 로 적으면 별칭이 아니게 되어
	 * 다음 삽입의 id 채번이 달라지고, 정수 대신 문자열을 넣어도 받아 준다. 이관이 <b>동작을 바꾸는</b>
	 * 자리이므로 affinity 동일로 넘기지 않는다.
	 */
	@Test
	void theIntegerPrimaryKeyIsDeclaredExactlyAsTheCanonicalRowidAlias() {
		List<String> keys = new ArrayList<>();
		for (Map.Entry<String, List<BaselineSql.Column>> table : exportedTables().entrySet()) {
			BaselineSql.Column first = table.getValue().get(0);
			if (first.definition().toUpperCase(Locale.ROOT).startsWith(INTEGER_TYPE)) {
				keys.add(table.getKey() + "." + first.name() + " " + first.definition());
			}
		}

		assertEquals(List.of("ArticleHistory.id INTEGER PRIMARY KEY", "ReceiverConfig.id INTEGER PRIMARY KEY",
				"DistributionTarget.id INTEGER PRIMARY KEY", "Photo.id INTEGER PRIMARY KEY"), keys,
				"정수 PK 가 rowid 별칭 선언이 아니다");
	}

	/** 보조 인덱스·FK 를 만들지 않는다 — 정본이 PK 자동 인덱스만 쓴다({@code src/db/schema.js} 3행). */
	@Test
	void theExportSchemaCreatesNoSecondaryIndexAndNoForeignKey() {
		String sql = String.join(";\n", ExportSchema.ddl());
		for (Pattern forbidden : List.of(
				Pattern.compile("(?i)\\bFOREIGN\\s+KEY\\b"),
				Pattern.compile("(?i)\\bREFERENCES\\b"),
				Pattern.compile("(?i)\\bUNIQUE\\b"),
				Pattern.compile("(?i)\\bCONSTRAINT\\b"),
				Pattern.compile("(?i)\\bCREATE\\s+(UNIQUE\\s+)?INDEX\\b"),
				Pattern.compile("(?i)(?<!PRIMARY )\\bKEY\\s*\\("),
				// MySQL 방언이 산출물로 새면 SQLite 가 그 문장을 거부한다(=열 수 없는 롤백 자산).
				Pattern.compile("(?i)\\bLONGTEXT\\b"),
				Pattern.compile("(?i)\\bAUTO_INCREMENT\\b"),
				Pattern.compile("(?i)\\bENGINE\\s*="),
				Pattern.compile("(?i)\\bCOLLATE\\b"),
				Pattern.compile("`"))) {
			assertFalse(forbidden.matcher(sql).find(),
					"export 스키마가 정본의 모양을 벗어났다: " + forbidden.pattern() + "\n" + sql);
		}
	}

	/** 모든 문장이 멱등한 {@code CREATE TABLE IF NOT EXISTS} 다(Node 의 {@code createSchema} 와 같은 형태). */
	@Test
	void everyStatementIsAnIdempotentCreateTable() {
		List<String> statements = ExportSchema.ddl();

		assertEquals(7, statements.size(), "문장 수(테이블 7개 · 그 밖의 문장 0)");
		for (String statement : statements) {
			assertTrue(statement.startsWith("CREATE TABLE IF NOT EXISTS "),
					"멱등하지 않은 문장이 있다(비파괴·멱등 마이그레이션만 허용): " + statement);
			assertFalse(statement.endsWith(";"), "문장 끝에 구분자를 붙이지 않는다(실행은 한 문장씩 한다): " + statement);
		}
	}

	/** 정본의 SQLite 정의를 export 표기로 옮긴다(PK·DEFAULT 는 그대로, 텍스트 표기만 하나로 모은다). */
	private static String translate(CanonicalSchema.Column column) {
		String definition = column.isInteger() ? INTEGER_TYPE : TEXT_TYPE;
		if (column.isPrimaryKey()) {
			definition += " PRIMARY KEY";
		}
		return (column.defaultValue() == null) ? definition : definition + " DEFAULT '" + column.defaultValue() + "'";
	}

	/**
	 * SQLite 의 선언 타입 → 저장 타입 유사성(affinity). 규칙은 SQLite 문서의 다섯 단계이고 이 스키마가
	 * 닿는 것은 앞의 둘뿐이다({@code INT} 포함 → INTEGER · {@code CHAR}/{@code CLOB}/{@code TEXT} 포함 →
	 * TEXT). 나머지 단계에 걸리면 그 자체가 예상 밖이므로 <b>이름을 그대로 돌려주어</b> 대조가 실패하게 둔다.
	 */
	private static String affinity(String definition) {
		String type = definition.toUpperCase(Locale.ROOT);
		if (type.contains("INT")) {
			return "INTEGER";
		}
		if (type.contains("CHAR") || type.contains("CLOB") || type.contains("TEXT")) {
			return "TEXT";
		}
		return "예상 밖 선언: " + definition;
	}

	private static Map<String, List<BaselineSql.Column>> exportedTables() {
		return BaselineSql.tables(String.join(";\n", ExportSchema.ddl()) + ";");
	}

}
