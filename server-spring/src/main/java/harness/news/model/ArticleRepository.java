package harness.news.model;

import harness.news.db.RequiredSchema;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.random.RandomGenerator;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.SqlParameterValue;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 기사 데이터 접근 계층 — 직접 SQL(ORM 없음, ADR-002). 비즈니스 규칙은 없다.
 *
 * <p>리포 루트 {@code src/models/articleModel.js}와 1:1이다. {@code Article}(본문 마크업)과
 * {@code Contents}(공통정보·생애주기·잠금)는 {@code articleId}로 1:1이며, 둘을 함께 바꾸는 연산은 하나의
 * 트랜잭션이다(부분 저장은 본문과 목록행이 갈라진 기사를 만든다 — decisions (18)).
 *
 * <p><b>행 삭제 연산은 두지 않는다.</b> 삭제 승인은 {@code status} 전이이고 행은 남으며, 잠금 해제도
 * 갱신문으로 NULL을 쓴다(DB 비파괴 — 최상위 규칙).
 *
 * <p>이 클래스의 계약 넷.
 * <ol>
 *   <li><b>컬럼은 화이트리스트({@link RequiredSchema})로만 다루고 {@code SELECT *}를 쓰지 않는다.</b>
 *       그래서 응답 키 집합이 스키마 변경에 따라 조용히 넓어지지 않고, 식별자를 요청 입력에서 가져와
 *       SQL에 이어 붙이는 자리도 없다.</li>
 *   <li><b>화이트리스트 밖 키는 조용히 무시한다(거부가 아니다).</b> Node 모델이 그렇게 동작하고 그 결과가
 *       REST 계약으로 동결돼 있다(미지의 키만 온 수정 요청은 200 {@code {changes:0}}).</li>
 *   <li><b>present-only</b>: 주어지지 않은 컬럼은 문장에 넣지 않는다. 그래서 부분 수정이 본문·상태·잠금을
 *       조용히 지우지 않는다.</li>
 *   <li><b>값 바인딩은 문자열·숫자·{@code null}만</b> 받는다(decisions (8)). 불리언·객체·배열은 예외이며
 *       전역 핸들러가 500 {@code internal-error}로 만든다 — Node의 {@code node:sqlite}가 그 입력에
 *       TypeError를 던지기 때문이다. 조용히 문자열화하면 같은 입력에 두 서버가 갈린다.</li>
 * </ol>
 *
 * <p>반환은 <b>투영하지 않은 원본</b>이다 — 잠금 판정(재로그인 takeover)이 {@code lockerSessionId}를
 * 필요로 한다. 다만 {@code Contents} 원본 행은 불투명 명목 타입({@link ContentsRow})으로 감싸 돌려주므로
 * 컨트롤러가 미투영 맵을 손에 넣을 수 없다(decisions (4)①). 응답 투영은 서비스 계층의 단일 지점이다.
 */
@Repository
public class ArticleRepository {

	/**
	 * {@code GET /api/articles}가 허용하는 조회 필터 <b>13키</b> — {@code server/index.js}의
	 * {@code FILTER_KEYS}와 1:1이다(계획서 부록 A의 '15키'는 드리프트이며 코드가 정본이다).
	 */
	public static final List<String> FILTER_KEYS = List.of(
			"articleId", "author", "sender", "status", "excludeStatus",
			"department", "departments",
			"createdAtFrom", "createdAtTo", "sentAtFrom", "sentAtTo",
			"distributedAtFrom", "distributedAtTo");

	/**
	 * 값이 2개 이상 올 수 있는 키 <b>3개</b>(IN / NOT IN). 나머지 10키는 스칼라 전용이고 반복되면
	 * 예외다 — Node가 배열을 그대로 SQL 바인딩에 내려 500이 되는 것을 재현한다(결함 후보 #4,
	 * decisions (9)). <b>400으로 고치지 마라</b>: 계약이 500을 동결했다.
	 */
	public static final List<String> ARRAY_CAPABLE_FILTER_KEYS = List.of("status", "excludeStatus", "departments");

	/** 두 테이블의 PK 컬럼 이름. SET 대상이 아니다. */
	private static final String PK = "articleId";

	private static final String SELECT_ARTICLE =
			"SELECT " + String.join(", ", RequiredSchema.ARTICLE_COLUMNS) + " FROM " + RequiredSchema.ARTICLE_TABLE;

	private static final String SELECT_CONTENTS =
			"SELECT " + String.join(", ", RequiredSchema.CONTENTS_COLUMNS) + " FROM " + RequiredSchema.CONTENTS_TABLE;

	/** 동등 비교로 들어가는 필터 키 3개 — 컬럼 이름과 같다. */
	private static final List<String> EQUALITY_KEYS = List.of("articleId", "author", "sender");

	/** 시각 범위 필터 3쌍 — {컬럼, from 키, to 키}. ISO-8601 UTC 문자열이라 사전식 비교로 범위가 성립한다. */
	private static final List<List<String>> RANGE_KEYS = List.of(
			List.of("createdAt", "createdAtFrom", "createdAtTo"),
			List.of("sentAt", "sentAtFrom", "sentAtTo"),
			List.of("distributedAt", "distributedAtFrom", "distributedAtTo"));

	/** {@code articleId} 재발급 상한. 상한에 걸리면 조용히 진행하지 않고 예외로 알린다. */
	private static final int ID_ATTEMPT_LIMIT = 100;

	private final JdbcClient jdbcClient;

	private final TransactionTemplate transactions;

	private final Clock clock;

	private final RandomGenerator random;

	/**
	 * 프로덕션 배선. {@code @Autowired}가 필요한 이유는 생성자가 둘이기 때문이다 — 실측: 표시가 없으면
	 * 컨테이너가 어느 쪽도 고르지 못하고 "No default constructor found"로 기동이 실패한다(공개 생성자가
	 * 하나뿐이어도 <b>선언된</b> 생성자가 둘이면 암묵 선택이 성립하지 않는다).
	 */
	@Autowired
	public ArticleRepository(JdbcClient jdbcClient, TransactionTemplate transactions, Clock clock) {
		this(jdbcClient, transactions, clock, RandomGenerator.getDefault());
	}

	/**
	 * 난수원 주입 seam — 테스트가 {@code articleId} 재발급 경계를 결정적으로 관측하기 위한 것이라
	 * 빈으로 노출하지 않는다(패키지 한정).
	 */
	ArticleRepository(JdbcClient jdbcClient, TransactionTemplate transactions, Clock clock,
			RandomGenerator random) {
		this.jdbcClient = jdbcClient;
		this.transactions = transactions;
		this.clock = clock;
		this.random = random;
	}

	/**
	 * 두 테이블을 각각 조회해 함께 돌려준다. <b>둘 다 없으면 {@code null}</b>이고, 한쪽만 있으면 없는 쪽이
	 * {@code null}이다(응답에서 그 키를 싣지 않는 근거 — decisions (20)①).
	 */
	public ArticleAggregate findById(String articleId) {
		if (articleId == null) {
			return null;
		}
		Map<String, Object> article = this.jdbcClient.sql(SELECT_ARTICLE + " WHERE " + PK + " = ?")
				.param(text(articleId))
				.query(ArticleRepository::mapArticle)
				.optional()
				.orElse(null);
		ContentsRow contents = this.jdbcClient.sql(SELECT_CONTENTS + " WHERE " + PK + " = ?")
				.param(text(articleId))
				.query(ArticleRepository::mapContents)
				.optional()
				.orElse(null);
		if (article == null && contents == null) {
			return null;
		}
		return new ArticleAggregate(article, contents);
	}

	/**
	 * {@code status} 한 컬럼만 읽는 경량 조회 — 상태 판정만 필요한 경로가 본문 blob을 읽지 않게 한다.
	 *
	 * <p>Node가 {@code undefined}(행 없음)와 {@code null}(컬럼이 NULL)로 가르는 두 상태를
	 * {@link StatusLookup#present()}로 유지한다.
	 */
	public StatusLookup findStatus(String articleId) {
		if (articleId == null) {
			return new StatusLookup(false, null);
		}
		List<String> found = this.jdbcClient
				.sql("SELECT status FROM " + RequiredSchema.CONTENTS_TABLE + " WHERE " + PK + " = ?")
				.param(text(articleId))
				.query(String.class)
				.list();
		return found.isEmpty() ? new StatusLookup(false, null) : new StatusLookup(true, found.get(0));
	}

	/**
	 * 값이 주어진 화이트리스트 컬럼만 두 테이블에 삽입한다(하나의 트랜잭션).
	 *
	 * @return 삽입한 {@code articleId}
	 * @throws IllegalArgumentException 한쪽 맵에 화이트리스트 컬럼이 하나도 없을 때(빈 INSERT를 만들지 않는다)
	 */
	public String insert(Map<String, ?> article, Map<String, ?> contents) {
		this.transactions.executeWithoutResult(status -> {
			if (article != null) {
				insertInto(RequiredSchema.ARTICLE_TABLE, RequiredSchema.ARTICLE_COLUMNS, article);
			}
			if (contents != null) {
				insertInto(RequiredSchema.CONTENTS_TABLE, RequiredSchema.CONTENTS_COLUMNS, contents);
			}
		});
		String id = idOf(article);
		return (id == null || id.isEmpty()) ? idOf(contents) : id;
	}

	/**
	 * 값이 주어진 화이트리스트 컬럼만 두 테이블에서 수정한다(하나의 트랜잭션). PK는 SET 대상이 아니다.
	 *
	 * @return 두 갱신문의 영향 행 수 <b>합</b>. 대상 컬럼이 없으면 그 문장은 실행하지 않고 0이다.
	 *     계약 리포트가 이 정수를 그대로 비교하므로 1/0으로 정규화하지 않는다(decisions (18)).
	 */
	public int update(String articleId, Map<String, ?> article, Map<String, ?> contents) {
		Integer changes = this.transactions.execute(status -> {
			int sum = 0;
			if (article != null) {
				sum += updateSet(RequiredSchema.ARTICLE_TABLE, RequiredSchema.ARTICLE_COLUMNS, articleId, article);
			}
			if (contents != null) {
				sum += updateSet(RequiredSchema.CONTENTS_TABLE, RequiredSchema.CONTENTS_COLUMNS, articleId, contents);
			}
			return sum;
		});
		return changes == null ? 0 : changes;
	}

	/**
	 * {@code Contents} 목록 조회. 입력은 <b>키 → 값 배열(원문)</b>이며 콤마를 분해하지 않는다
	 * ({@code ?status=RDS,DDH}는 값이 하나인 문자열이고 매칭 0건인 것이 계약이다 — decisions (10)).
	 *
	 * <p>조건 조립 순서는 Node와 같다: 동등 3키 → {@code status} IN → {@code excludeStatus} NOT IN →
	 * 부서({@code departments} 우선) IN → 시각 3쌍 범위 → {@code ORDER BY createdAt DESC}.
	 * 화이트리스트 밖 키는 조용히 무시한다.
	 *
	 * @throws IllegalArgumentException 배열이 허용되지 않는 키에 값이 2개 이상일 때(결함 후보 #4)
	 */
	public List<ContentsRow> query(Map<String, List<String>> filters) {
		List<String> conditions = new ArrayList<>();
		List<Object> params = new ArrayList<>();

		for (String key : EQUALITY_KEYS) {
			String value = single(filters, key);
			if (value != null) {
				conditions.add(key + " = ?");
				params.add(text(value));
			}
		}

		addInCondition(conditions, params, "status IN", many(filters, "status"));
		addInCondition(conditions, params, "status NOT IN", many(filters, "excludeStatus"));

		// 부서 다중 선택 — departments 키가 있으면 그것만 본다(department는 평가조차 하지 않는다).
		List<String> departments = many(filters, "departments");
		if (departments == null) {
			String department = single(filters, "department");
			departments = (department == null) ? List.of() : List.of(department);
		}
		addInCondition(conditions, params, "department IN", departments);

		for (List<String> range : RANGE_KEYS) {
			String from = single(filters, range.get(1));
			if (from != null) {
				conditions.add(range.get(0) + " >= ?");
				params.add(text(from));
			}
			String to = single(filters, range.get(2));
			if (to != null) {
				conditions.add(range.get(0) + " <= ?");
				params.add(text(to));
			}
		}

		String where = conditions.isEmpty() ? "" : " WHERE " + String.join(" AND ", conditions);
		return this.jdbcClient.sql(SELECT_CONTENTS + where + " ORDER BY createdAt DESC")
				.params(params)
				.query(ArticleRepository::mapContents)
				.list();
	}

	/**
	 * 제목·본문·마크업 3컬럼 LIKE 검색({@code Article} 행을 돌려준다 — 목록의 {@code Contents} 행과
	 * 동형이 아니다). 빈 질의는 거부가 아니라 전 행 매칭이다.
	 */
	public List<Map<String, Object>> searchByText(String query) {
		String like = "%" + (query == null ? "" : query) + "%";
		return this.jdbcClient
				.sql(SELECT_ARTICLE + " WHERE title LIKE ? OR content LIKE ? OR markupVersion LIKE ?")
				.params(List.of(text(like), text(like), text(like)))
				.query(ArticleRepository::mapArticle)
				.list();
	}

	/**
	 * 편집 잠금 획득 — 5컬럼을 한 문장으로 세팅한다. 값이 없는 컬럼은 SQL NULL이다.
	 *
	 * @return 영향 받은 행 수(대상 기사가 없으면 0)
	 */
	public int setLock(String articleId, EditLock lock) {
		EditLock held = (lock == null) ? new EditLock(null, null, null, null) : lock;
		return this.jdbcClient.sql("UPDATE " + RequiredSchema.CONTENTS_TABLE
						+ " SET lockYN = 'Y', lockerUserId = ?, lockerSessionId = ?, lockerClientId = ?,"
						+ " lockedAt = ? WHERE " + PK + " = ?")
				.params(List.of(text(held.lockerUserId()), text(held.lockerSessionId()),
						text(held.lockerClientId()), text(held.lockedAt()), text(articleId)))
				.update();
	}

	/**
	 * 편집 잠금 해제 — 같은 5컬럼을 {@code 'N'}과 NULL로 되돌린다. <b>행을 지우지 않는다</b>(DB 비파괴).
	 *
	 * @return 영향 받은 행 수(대상 기사가 없으면 0)
	 */
	public int clearLock(String articleId) {
		return this.jdbcClient.sql("UPDATE " + RequiredSchema.CONTENTS_TABLE
						+ " SET lockYN = 'N', lockerUserId = NULL, lockerSessionId = NULL,"
						+ " lockerClientId = NULL, lockedAt = NULL WHERE " + PK + " = ?")
				.param(text(articleId))
				.update();
	}

	/**
	 * 두 테이블 어느 쪽에도 없는 {@code articleId}를 발급한다(형식은 {@link ArticleIds}).
	 *
	 * @throws IllegalStateException 상한까지 계속 중복일 때 — 조용히 진행하지 않는다
	 */
	public String generateArticleId() {
		for (int attempt = 0; attempt < ID_ATTEMPT_LIMIT; attempt++) {
			String candidate = ArticleIds.generate(this.clock, this.random);
			if (!exists(candidate)) {
				return candidate;
			}
		}
		throw new IllegalStateException(
				"articleId 발급 실패 — 후보가 " + ID_ATTEMPT_LIMIT + "회 연속 중복입니다(난수원 또는 데이터 이상)");
	}

	/** 유일성 확인은 두 테이블을 모두 본다({@code src/db/articleId.js}와 같은 문장). */
	private boolean exists(String articleId) {
		return !this.jdbcClient.sql("SELECT 1 FROM " + RequiredSchema.ARTICLE_TABLE + " WHERE " + PK + " = ?"
						+ " UNION ALL SELECT 1 FROM " + RequiredSchema.CONTENTS_TABLE + " WHERE " + PK + " = ?"
						+ " LIMIT 1")
				.params(List.of(text(articleId), text(articleId)))
				.query(Integer.class)
				.list()
				.isEmpty();
	}

	private void insertInto(String table, List<String> whitelist, Map<String, ?> row) {
		List<String> columns = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		for (String column : whitelist) {
			if (!row.containsKey(column)) {
				continue;
			}
			columns.add(column);
			params.add(text(row.get(column)));
		}
		if (columns.isEmpty()) {
			throw new IllegalArgumentException(table + ": 입력할 컬럼이 없습니다");
		}
		this.jdbcClient.sql("INSERT INTO " + table + " (" + String.join(", ", columns) + ") VALUES ("
						+ placeholders(columns.size()) + ")")
				.params(params)
				.update();
	}

	private int updateSet(String table, List<String> whitelist, String articleId, Map<String, ?> row) {
		List<String> assignments = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		for (String column : whitelist) {
			if (column.equals(PK) || !row.containsKey(column)) {
				continue;
			}
			assignments.add(column + " = ?");
			params.add(text(row.get(column)));
		}
		if (assignments.isEmpty()) {
			return 0;
		}
		params.add(text(articleId));
		return this.jdbcClient.sql("UPDATE " + table + " SET " + String.join(", ", assignments)
						+ " WHERE " + PK + " = ?")
				.params(params)
				.update();
	}

	private static void addInCondition(List<String> conditions, List<Object> params, String operator,
			List<String> values) {
		if (values == null || values.isEmpty()) {
			return;
		}
		conditions.add(operator + " (" + placeholders(values.size()) + ")");
		for (String value : values) {
			params.add(text(value));
		}
	}

	/**
	 * 배열이 허용되는 키의 값 목록. 키 자체가 없으면 {@code null}이다 — 부서 우선순위 규칙이
	 * "{@code departments} 키의 존재"로 갈리기 때문에 "없음"과 "빈 목록"을 구분한다.
	 */
	private static List<String> many(Map<String, List<String>> filters, String key) {
		if (filters == null || !filters.containsKey(key)) {
			return null;
		}
		List<String> values = filters.get(key);
		if (values == null) {
			return null;
		}
		List<String> present = new ArrayList<>();
		for (String value : values) {
			if (value != null) {
				present.add(value);
			}
		}
		return present;
	}

	/**
	 * 스칼라 전용 키의 값 하나. 없으면 {@code null}이고, <b>2개 이상이면 예외</b>다(결함 후보 #4).
	 * 빈 문자열은 값이 있는 것이다({@code ?author=}도 조건이다 — Node {@code query[k] !== undefined} 동형).
	 */
	private static String single(Map<String, List<String>> filters, String key) {
		if (filters == null) {
			return null;
		}
		List<String> values = filters.get(key);
		if (values == null || values.isEmpty()) {
			return null;
		}
		if (values.size() > 1) {
			throw new IllegalArgumentException(
					"필터 키 " + key + "는 값을 하나만 받는다(배열 허용 키: " + String.join(", ", ARRAY_CAPABLE_FILTER_KEYS) + ")");
		}
		return values.get(0);
	}

	private static String placeholders(int count) {
		return String.join(", ", Collections.nCopies(count, "?"));
	}

	/** 삽입이 성공한 뒤 호출자가 준 {@code articleId}를 그대로 돌려준다(값 검증은 삽입이 이미 했다). */
	private static String idOf(Map<String, ?> row) {
		Object id = (row == null) ? null : row.get(PK);
		return (id == null) ? null : String.valueOf(id);
	}

	private static Map<String, Object> mapArticle(ResultSet rs, int rowNum) throws SQLException {
		return readRow(rs, RequiredSchema.ARTICLE_COLUMNS);
	}

	private static ContentsRow mapContents(ResultSet rs, int rowNum) throws SQLException {
		return ContentsRow.of(readRow(rs, RequiredSchema.CONTENTS_COLUMNS));
	}

	/**
	 * 컬럼 목록 순서의 맵. 값이 SQL NULL이어도 <b>키는 남긴다</b>(decisions (5) — 키 없음과 null은 다르다).
	 * 전 컬럼이 TEXT affinity라 저장도 조회도 문자열이다(숫자를 넣어도 텍스트로 돌아온다 — Node 동형).
	 */
	private static Map<String, Object> readRow(ResultSet rs, List<String> columns) throws SQLException {
		Map<String, Object> row = new LinkedHashMap<>();
		for (String column : columns) {
			row.put(column, rs.getString(column));
		}
		return row;
	}

	/**
	 * 바인딩 정책(decisions (8)) — 문자열은 텍스트로, <b>숫자는 REAL로</b>, {@code null}은 SQL NULL로,
	 * <b>그 밖(불리언·객체·배열)은 예외</b>다. 예외 메시지에 값을 담지 않는다(본문·토큰이 로그로 새지 않게).
	 *
	 * <p>숫자를 <b>Java에서 문자열로 만들지 않는</b> 이유는 실측이다: {@code node:sqlite}는 JS number를
	 * 예외 없이 REAL로 내리고, TEXT affinity 컬럼이 그 REAL을 SQLite의 규칙으로 문자열화한다
	 * (2026-08-21 실측 — {@code 42 → "42.0"} · {@code 1e9 → "1000000000.0"} ·
	 * {@code 1.2345678901234567e19 → "1.2345678901234567e+19"}). 여기서 {@code String.valueOf(42)}로
	 * 바꾸면 {@code "42"}가 저장돼 같은 입력에 두 서버의 저장값이 갈린다. REAL로 내리면 <b>같은 SQLite
	 * 변환 코드</b>가 돌아 표현이 저절로 일치한다 — 자체 숫자 포매터를 만들지 않는다.
	 *
	 * <p>타입을 명시하는 것은 {@code null}도 확정적으로 SQL NULL이 되게 하기 위해서다(타입 미상 null
	 * 바인딩은 드라이버마다 동작이 갈린다).
	 */
	private static SqlParameterValue text(Object value) {
		if (value == null) {
			return new SqlParameterValue(Types.VARCHAR, null);
		}
		if (value instanceof CharSequence characters) {
			return new SqlParameterValue(Types.VARCHAR, characters.toString());
		}
		if (value instanceof Number number) {
			return new SqlParameterValue(Types.DOUBLE, number.doubleValue());
		}
		throw new IllegalArgumentException(
				"기사 컬럼에 바인딩할 수 없는 값 타입입니다: " + value.getClass().getName());
	}

	/** 편집 잠금 5컬럼의 값 묶음({@code lockYN}은 언제나 {@code 'Y'}라 여기 없다). */
	public record EditLock(String lockerUserId, String lockerSessionId, String lockerClientId,
			String lockedAt) {
	}

	/**
	 * {@code status} 경량 조회 결과 — {@code present}는 <b>행의 존재</b>이고 {@code status}는 컬럼 값이다.
	 * 행이 없는 것과 컬럼이 NULL인 것은 다르다(Node {@code undefined} / {@code null}).
	 */
	public record StatusLookup(boolean present, String status) {
	}
}
