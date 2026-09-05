package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.junit.jupiter.api.Test;

/**
 * 복사기·대조기가 <b>어디에서 테이블·컬럼 목록을 얻는가</b>를 고정한다.
 *
 * <h2>왜 기반선을 읽는가(손으로 적지 않고)</h2>
 * 목록을 main 소스에 손으로 적으면 정본에 컬럼이 늘 때 <b>조용히 낡는다</b> — 그리고 그 낡음은 대조가
 * 아니라 운영 데이터가 들어간 뒤에 드러난다. 기반선({@code V1__baseline.sql})은 이미
 * {@code BaselineMatchesCanonicalSchemaTest} 가 정본({@code src/db/schema.js})과 기계로 맞춰 놓았으므로,
 * 그것을 읽으면 목록의 단일 출처가 <b>정본 하나</b>로 이어진다.
 *
 * <h2>정수/문자열 판정도 여기에서 온다</h2>
 * "무엇을 정수로 옮기는가"는 매핑 규칙(축 6)의 결론이고 기반선의 {@code BIGINT} 선언이 그 결론의 정본이다.
 * 복사기가 따로 판단하면 규칙이 두 벌이 된다.
 */
class BaselineSchemaTest {

	@Test
	void theSchemaIsReadFromTheBaselineAndListsTheCanonicalTablesInOrder() {
		BaselineSchema schema = BaselineSchema.load();

		assertEquals(new ArrayList<>(CanonicalSchema.load().tables().keySet()), schema.tableNames(),
				"기반선에서 읽은 테이블 목록이 정본과 다르다(선언 순서까지 같아야 한다)");
		assertEquals(7, schema.tables().size(), "정본은 7테이블이다");
	}

	@Test
	void everyColumnOfEveryTableMatchesTheCanonicalDeclarationOrder() {
		BaselineSchema schema = BaselineSchema.load();

		for (String table : schema.tableNames()) {
			assertEquals(CanonicalSchema.load().columnNames(table), schema.table(table).columnNames(),
					table + " 의 컬럼 이름·순서가 정본과 다르다");
		}
	}

	/** 정수로 옮기는 컬럼은 <b>정확히 5개</b>다(정수 PK 4 + {@code targetId}). */
	@Test
	void exactlyTheIntegerColumnsAreMarkedAsIntegers() {
		BaselineSchema schema = BaselineSchema.load();

		List<String> integers = new ArrayList<>();
		for (BaselineSchema.Table table : schema.tables()) {
			for (BaselineSchema.Column column : table.columns()) {
				if (column.integer()) {
					integers.add(table.name() + "." + column.name());
				}
			}
		}

		assertEquals(List.of("ArticleHistory.id", "ArticleHistory.targetId", "ReceiverConfig.id",
				"DistributionTarget.id", "Photo.id"), integers,
				"정수 컬럼 집합이 매핑 규칙과 다르다 — 문자열로 옮기면 targetId 매칭이 조용히 깨진다");
	}

	@Test
	void everyTableHasExactlyOnePrimaryKeyAndItIsTheFirstColumn() {
		BaselineSchema schema = BaselineSchema.load();

		List<String> keys = new ArrayList<>();
		for (BaselineSchema.Table table : schema.tables()) {
			keys.add(table.name() + "." + table.primaryKey().name());
			assertEquals(table.columns().get(0).name(), table.primaryKey().name(), table.name() + " 의 PK 가 첫 컬럼이 아니다");
		}

		assertEquals(List.of("User.userId", "Article.articleId", "Contents.articleId", "ArticleHistory.id",
				"ReceiverConfig.id", "DistributionTarget.id", "Photo.id"), keys, "PK 컬럼 집합");
	}

	/**
	 * <b>이관 원장은 대조 대상이 아니다</b> — 그러나 그 제외는 <b>명시</b>여야 한다.
	 *
	 * <p>기반선을 적용하면 정본에 없는 테이블이 하나 생긴다({@code flyway_schema_history}). 이름을 코드
	 * 곳곳에서 즉석으로 비교하면 어느 날 한 곳이 빠지고, 그 순간 대조는 "정본에 없는 테이블이 있다"로
	 * 영원히 red 이거나 반대로 조용히 무엇이든 무시하게 된다(ADR-016 트레이드오프 ⑨).
	 */
	@Test
	void theMigrationLedgerIsANamedExclusionNotACanonicalTable() {
		BaselineSchema schema = BaselineSchema.load();

		assertEquals("flyway_schema_history", BaselineSchema.MIGRATION_LEDGER_TABLE, "이관 원장 이름");
		assertFalse(schema.tableNames().contains(BaselineSchema.MIGRATION_LEDGER_TABLE), "원장이 정본 테이블에 섞였다");
		for (String table : schema.tableNames()) {
			assertFalse(table.toLowerCase(Locale.ROOT).equals(BaselineSchema.MIGRATION_LEDGER_TABLE),
					"원장 이름이 정본 테이블과 겹친다");
		}
	}

	@Test
	void anUnknownTableIsAnErrorNotAnEmptyResult() {
		BaselineSchema schema = BaselineSchema.load();

		IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
				() -> schema.table("NoSuchTable"));

		assertTrue(failure.getMessage().contains("NoSuchTable"), "어느 이름을 못 찾았는지 밝히지 않는다");
	}

}
