package harness.newsmigrator;

import java.util.ArrayList;
import java.util.List;

/**
 * 역방향 export 산출물의 <b>SQLite 스키마</b> — 기반선을 정본 모양으로 되돌린다.
 *
 * <h2>왜 손으로 적지 않는가</h2>
 * 목록을 여기 적으면 정본({@code src/db/schema.js})에 컬럼이 늘 때 <b>조용히 낡는다</b>. 그래서
 * {@link BaselineSchema} 가 읽은 기반선에서 계산한다 — 그리고 기반선은 이미
 * {@code BaselineMatchesCanonicalSchemaTest} 가 정본과 기계로 맞춰 두었으므로, 산출물 스키마의 단일
 * 출처가 <b>정본 하나</b>로 이어진다. 그 사슬이 실제로 닫히는지는 {@code ExportSchemaTest} 가 다시
 * 정본과 직접 대조해 확인한다(사슬을 믿지 않고 양끝을 맞춰 본다).
 *
 * <h2>타입 표기를 하나로 모으는 이유</h2>
 * 정본은 같은 뜻을 두 표기로 쓴다 — {@code User} 는 {@code TEXT}, 나머지 여섯 테이블은 {@code VARCHAR}.
 * 기반선은 그 둘을 모두 {@code LONGTEXT}/{@code VARCHAR(768)} 로 옮기므로 <b>구분이 남아 있지 않고</b>,
 * 되살리려면 "테이블이 {@code User} 면 {@code TEXT}" 같은 표를 손으로 적어야 한다 — 정본이 바뀌면 낡는
 * 바로 그 코드다. SQLite 는 선언 타입의 철자가 아니라 <b>저장 타입 유사성(affinity)</b> 으로 값을 다루고
 * {@code TEXT} 와 {@code VARCHAR} 는 둘 다 TEXT affinity 이므로, 표기를 하나로 모아도 저장·비교·정렬 중
 * 무엇도 바뀌지 않는다. 그 사실은 {@code ExportSchemaTest} 가 컬럼마다 affinity 를 맞춰 단언하고,
 * {@code ExportRoundTripOnMysqlTest} 가 <b>실제 산출물의 카탈로그</b>를 정본으로 만든 DB 와 맞춰 본다.
 *
 * <h2>정수 PK 만은 글자까지 같다</h2>
 * SQLite 에서 rowid 별칭이 되는 선언은 {@code INTEGER PRIMARY KEY} <b>하나뿐</b>이다. 다르게 적으면
 * 별칭이 아니게 되어 다음 삽입의 채번이 달라지고 정수 자리에 문자열도 들어간다 — 이관이 동작을 바꾸는
 * 자리이므로 affinity 동일로 넘기지 않는다.
 *
 * <h2>보조 인덱스·외래 관계를 만들지 않는다</h2>
 * 정본이 PK 자동 인덱스만 쓴다({@code src/db/schema.js} 3행). 산출물이 정본보다 "더 좋은" 스키마가 되면
 * 그것은 이미 정본과 다른 DB 다.
 */
public final class ExportSchema {

	/** 정수 컬럼의 선언. 정본과 <b>글자까지</b> 같다(rowid 별칭). */
	public static final String INTEGER_TYPE = "INTEGER";

	/** 텍스트 컬럼의 선언 — 정본의 {@code TEXT}·{@code VARCHAR} 를 하나로 모은 표기(같은 affinity). */
	public static final String TEXT_TYPE = "VARCHAR";

	private ExportSchema() {
	}

	/** 기반선에서 계산한 {@code CREATE TABLE} 문 일곱 개(테이블 선언 순서 그대로). */
	public static List<String> ddl() {
		return ddl(BaselineSchema.load());
	}

	/** 주어진 스키마로 {@code CREATE TABLE} 문을 만든다(문장 끝에 구분자를 붙이지 않는다 — 한 문장씩 실행한다). */
	public static List<String> ddl(BaselineSchema schema) {
		List<String> statements = new ArrayList<>();
		for (BaselineSchema.Table table : schema.tables()) {
			List<String> columns = new ArrayList<>();
			for (BaselineSchema.Column column : table.columns()) {
				columns.add(Identifiers.require(column.name()) + " " + definitionOf(column));
			}
			statements.add("CREATE TABLE IF NOT EXISTS " + Identifiers.require(table.name()) + " ("
					+ String.join(", ", columns) + ")");
		}
		return List.copyOf(statements);
	}

	/**
	 * 컬럼 하나의 SQLite 선언 — 타입 · PK · DEFAULT.
	 *
	 * <p>기본값을 옮기는 이유는 실측이다: 이 리포의 삽입문은 전부 <b>동적 컬럼 목록</b>이라 값이 없는
	 * 컬럼은 문장에서 빠진다. 기본값이 없으면 정본에서 {@code 'Y'} 인 자리가 산출물에서만 NULL 이 되고,
	 * 그 파일로 되돌린 서버는 다른 동작을 한다.
	 */
	public static String definitionOf(BaselineSchema.Column column) {
		StringBuilder definition = new StringBuilder(column.integer() ? INTEGER_TYPE : TEXT_TYPE);
		if (column.primaryKey()) {
			definition.append(" PRIMARY KEY");
		}
		if (column.defaultValue() != null) {
			if (column.defaultValue().indexOf('\'') >= 0) {
				throw new IllegalStateException(column.name()
						+ ": 기본값에 따옴표가 들어 있다 — 조용히 옮기지 않는다(기반선을 먼저 보라)");
			}
			definition.append(" DEFAULT '").append(column.defaultValue()).append('\'');
		}
		return definition.toString();
	}

}
