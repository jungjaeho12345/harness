package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Flyway 기반선이 SQLite 정본({@code src/db/schema.js})의 <b>번역</b>임을 기계로 대조한다.
 *
 * <p>대조 대상은 셋이다: <b>컬럼 이름</b> · <b>선언 순서</b> · <b>DEFAULT</b>. 순서까지 보는 이유는
 * step3 의 복사기가 컬럼 목록을 카탈로그에서 읽을 것이고, 순서가 어긋나면 값이 <b>엉뚱한 컬럼</b>에
 * 들어가도 행 수 대조는 통과하기 때문이다(행 수 단언은 그물이 아니다).
 *
 * <p>타입은 {@code docs/db-mysql-mapping.md} §6 의 규칙 넷으로 <b>계산</b>해서 비교한다 — 표를 손으로
 * 옮겨 적으면 그 표가 두 벌이 되고, 두 벌은 반드시 갈린다.
 */
class BaselineMatchesCanonicalSchemaTest {

	static final Path BASELINE = Path.of("src", "main", "resources", "db", "migration", "V1__baseline.sql");

	/**
	 * 테이블 옵션의 정본. collation 은 step1 이 <b>측정으로</b> 고른 값이다({@code utf8mb4_0900_bin} 만이
	 * {@code =} 6쌍과 40표본 {@code ORDER BY} 에서 SQLite BINARY 와 일치했다 — {@code utf8mb4_bin} 은
	 * PAD SPACE 라 후행 공백을 무시해 인증 축이 무너지고, {@code ai_ci} 는 대소문자·전각·자모를 같다고 본다).
	 */
	static final String TABLE_OPTIONS = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin";

	/** 텍스트 PK 의 타입. 768 은 계산이 아니라 실측이다 — 769 는 키 상한 초과(1071)로 스키마가 안 만들어진다. */
	static final String PK_TEXT_TYPE = "VARCHAR(768) NOT NULL PRIMARY KEY";

	/** {@code INTEGER PRIMARY KEY} 의 대응물. */
	static final String PK_INTEGER_TYPE = "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY";

	/** 나머지 텍스트. {@code markupVersion} 최대 165,802바이트라 {@code VARCHAR} 는 원천 불가(1406). */
	static final String TEXT_TYPE = "LONGTEXT";

	@Test
	void theBaselineDeclaresExactlyTheCanonicalTablesInOrder() {
		assertEquals(new ArrayList<>(CanonicalSchema.load().tables().keySet()),
				new ArrayList<>(baselineTables().keySet()),
				"기반선의 테이블 집합·순서가 정본과 다르다");
		assertEquals(7, baselineTables().size(), "정본은 7테이블이다(sqlite_sequence 는 없다 — AUTOINCREMENT 미사용)");
	}

	@Test
	void everyColumnNameOrderAndTypeMatchesTheCanonicalSchema() {
		Map<String, List<String>> expected = new LinkedHashMap<>();
		CanonicalSchema canonical = CanonicalSchema.load();
		for (Map.Entry<String, List<CanonicalSchema.Column>> table : canonical.tables().entrySet()) {
			List<String> columns = new ArrayList<>();
			for (CanonicalSchema.Column column : table.getValue()) {
				columns.add(column.name() + " " + translate(column));
			}
			expected.put(table.getKey(), columns);
		}

		Map<String, List<String>> actual = new LinkedHashMap<>();
		for (Map.Entry<String, List<BaselineSql.Column>> table : baselineTables().entrySet()) {
			List<String> columns = new ArrayList<>();
			for (BaselineSql.Column column : table.getValue()) {
				columns.add(column.name() + " " + column.definition());
			}
			actual.put(table.getKey(), columns);
		}

		assertEquals(expected, actual,
				"기반선이 정본의 번역이 아니다(컬럼 이름·순서·타입·DEFAULT 중 하나가 어긋났다)");
	}

	/**
	 * <b>DEFAULT 는 식 DEFAULT 로 옮긴다</b>(step1 이 step2 로 넘긴 결정).
	 *
	 * <p>{@code LONGTEXT DEFAULT 'Y'} 는 <b>1101 로 불가</b>다(BLOB/TEXT 는 리터럴 DEFAULT 를 못 가진다).
	 * 남은 선택은 둘이었다: ① 8.0.13+ 의 식 DEFAULT {@code DEFAULT ('Y')} ② DEFAULT 를 버리고 애플리케이션에
	 * 맡기기. <b>①을 택한 근거는 실측이다</b> — 이 리포의 INSERT 는 전부 <b>동적 컬럼 목록</b>을 만든다
	 * ({@code UserRepository} 104행 · {@code ReceiverConfigRepository} 126행 …). 즉 값이 없는 컬럼은 SQL 에서
	 * <b>빠진다</b>. 정본(SQLite)에서 그 자리는 {@code DEFAULT 'Y'} 로 채워지는데 ②를 택하면 MySQL 에서는
	 * {@code NULL} 이 된다 — 이관이 <b>동작을 바꾸는</b> 것이고 그것이 이 phase 가 금지하는 바로 그 일이다.
	 * 그 divergence 를 실제로 재는 것은 {@code MysqlBaselineBehaviourTest} 다(정적 대조로는 못 본다).
	 */
	@Test
	void theCanonicalDefaultsAreCarriedOverAsExpressionDefaults() {
		Map<String, String> canonicalDefaults = new LinkedHashMap<>();
		for (Map.Entry<String, List<CanonicalSchema.Column>> table : CanonicalSchema.load().tables().entrySet()) {
			for (CanonicalSchema.Column column : table.getValue()) {
				if (column.defaultValue() != null) {
					canonicalDefaults.put(table.getKey() + "." + column.name(), column.defaultValue());
				}
			}
		}

		assertEquals(Map.of("User.active", "Y", "User.failedLoginCount", "0", "Contents.lockYN", "N",
				"ReceiverConfig.active", "Y", "DistributionTarget.active", "Y"), canonicalDefaults,
				"정본의 DEFAULT 선언이 실측(5건)과 다르다 — 기반선이 옮겨야 할 목록이 바뀌었다");

		Map<String, String> baselineDefaults = new LinkedHashMap<>();
		for (Map.Entry<String, List<BaselineSql.Column>> table : baselineTables().entrySet()) {
			for (BaselineSql.Column column : table.getValue()) {
				int at = column.definition().toUpperCase(Locale.ROOT).indexOf("DEFAULT ");
				if (at >= 0) {
					baselineDefaults.put(table.getKey() + "." + column.name(),
							column.definition().substring(at + "DEFAULT ".length()).strip());
				}
			}
		}

		Map<String, String> expected = new LinkedHashMap<>();
		canonicalDefaults.forEach((key, value) -> expected.put(key, "('" + value + "')"));
		assertEquals(expected, baselineDefaults,
				"정본의 DEFAULT 가 식 DEFAULT 로 그대로 옮겨지지 않았다(리터럴 DEFAULT 는 LONGTEXT 에서 1101 이다)");
	}

	/** 보조 인덱스·FK 를 만들지 않는다 — 정본이 PK 자동 인덱스만 쓴다({@code src/db/schema.js} 3행). */
	@Test
	void theBaselineCreatesNoSecondaryIndexAndNoForeignKey() {
		String sql = CanonicalSchema.read(BASELINE);
		for (Pattern forbidden : List.of(
				Pattern.compile("(?i)\\bFOREIGN\\s+KEY\\b"),
				Pattern.compile("(?i)\\bREFERENCES\\b"),
				Pattern.compile("(?i)\\bUNIQUE\\b"),
				Pattern.compile("(?i)\\bCONSTRAINT\\b"),
				Pattern.compile("(?i)\\bCREATE\\s+(UNIQUE\\s+)?INDEX\\b"),
				// PRIMARY KEY 가 아닌 KEY 절(= 보조 인덱스). 부정 lookbehind 로 PRIMARY 를 뺀다.
				Pattern.compile("(?i)(?<!PRIMARY )\\bKEY\\s*\\("))) {
			assertFalse(forbidden.matcher(sql).find(),
					"기반선이 보조 인덱스·FK 를 만든다(패리티 원칙 위반 — 성능 축은 P3): " + forbidden.pattern());
		}
	}

	/** 모든 문장이 멱등한 {@code CREATE TABLE IF NOT EXISTS} 이고 테이블 옵션이 하나로 고정돼 있다. */
	@Test
	void everyStatementIsAnIdempotentCreateWithTheDecidedCharsetAndCollation() {
		List<String> statements = BaselineSql.statements(CanonicalSchema.read(BASELINE));

		assertEquals(7, statements.size(), "기반선의 문장 수(테이블 7개 · 그 밖의 문장 0)");
		for (String statement : statements) {
			assertTrue(statement.toUpperCase(Locale.ROOT).startsWith("CREATE TABLE IF NOT EXISTS "),
					"멱등하지 않은 문장이 있다(비파괴·멱등 마이그레이션만 허용): " + statement);
		}
		for (Map.Entry<String, String> options : BaselineSql.tableOptions(CanonicalSchema.read(BASELINE)).entrySet()) {
			assertEquals(TABLE_OPTIONS, options.getValue(),
					"테이블 옵션이 결정값과 다르다: " + options.getKey());
		}
	}

	/**
	 * <b>날짜·시각을 승격하지 않는다</b>({@code docs/db-mysql-mapping.md} §0). 정본이 ISO 문자열을 TEXT 에
	 * 넣으므로 {@code DATETIME} 으로 올리면 포맷·타임존이 왕복에서 갈린다.
	 */
	@Test
	void noTemporalColumnIsPromotedToADateType() {
		String sql = CanonicalSchema.read(BASELINE).toUpperCase(Locale.ROOT);
		for (String promoted : List.of("DATETIME", "TIMESTAMP", " DATE ", " TIME ")) {
			assertFalse(sql.contains(promoted),
					"시각 컬럼이 날짜 타입으로 승격됐다(왕복에서 포맷·타임존이 갈린다): " + promoted);
		}
	}

	/** 정본의 SQLite 정의를 매핑 규칙 넷으로 번역한다. */
	static String translate(CanonicalSchema.Column column) {
		String type;
		if (column.isPrimaryKey()) {
			type = column.isInteger() ? PK_INTEGER_TYPE : PK_TEXT_TYPE;
		}
		else if (column.isInteger()) {
			type = "BIGINT";
		}
		else {
			type = TEXT_TYPE;
		}
		String value = column.defaultValue();
		return (value == null) ? type : type + " DEFAULT ('" + value + "')";
	}

	private static Map<String, List<BaselineSql.Column>> baselineTables() {
		return BaselineSql.tables(CanonicalSchema.read(BASELINE));
	}

}
