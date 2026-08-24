package harness.news.model;

import harness.news.db.RequiredSchema;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 수집(자동기사) 수신 설정 데이터 접근 계층 — 직접 SQL(ORM 없음, ADR-002). 비즈니스 규칙은 없다.
 *
 * <p>리포 루트 {@code src/models/receiverConfigModel.js}와 1:1이다. 연산은 셋이다: 조회({@link #query}) ·
 * 생성({@link #insert}) · <b>삭제({@link #remove})</b>.
 *
 * <p><b>{@link #remove}는 이 서버 전체에서 유일한 행 삭제 연산이다.</b> {@code DELETE FROM ReceiverConfig
 * WHERE id = ?}는 설정 행만 지우고 그 sourceId로 이미 수집된 {@code Article}·{@code Contents}는 절대
 * 건드리지 않는다 — DB 비파괴 원칙의 <b>명시적 예외 경계</b>다(SCHEMA.md 76행·계약 파일 7~9행이 동결).
 * 그 예외 하나만 {@code NoSchemaSqlInMainSourcesTest}가 허용하도록 좁혀져 있고, 나머지 6테이블의 행
 * 삭제는 여전히 정적 스캔이 거부한다.
 *
 * <p>이 클래스의 계약 셋.
 * <ol>
 *   <li><b>컬럼은 화이트리스트({@link RequiredSchema#RECEIVER_CONFIG_COLUMNS})로만 다룬다.</b> 필터·삽입
 *       모두 그 목록으로만 SQL을 조립하므로 임의 컬럼명 주입이 성립하지 않는다.</li>
 *   <li><b>화이트리스트 밖 키는 조용히 무시한다(거부가 아니다).</b> Node 모델이 그렇게 동작하고 그 위의
 *       REST 계약이 결과를 동결한다(미지의 키가 섞인 조회는 400이 아니라 무시다).</li>
 *   <li><b>반환은 투영하지 않은 원본(시크릿 포함)이다.</b> {@code password}·{@code apiKey}를 여기서 걸러내지
 *       않는다 — 노출 정책은 서비스 계층의 단일 지점이다(계층 분리).</li>
 * </ol>
 *
 * <p>{@code id}는 자동 증가 정수(ROWID 별칭)라 삽입 대상이 아니고 조회 결과에서는 정수로 읽는다
 * (문자열로 읽으면 생성 응답의 정수 id와 목록의 문자열 id가 갈려 계약이 깨진다). 값 바인딩 정책은
 * {@link ColumnValues}(phase 69 decisions (8)) 단일 출처를 쓴다 — 계약 케이스는 문자열만 보내므로 이
 * 축은 관측되지 않지만 정책을 두 벌 두지 않는다.
 */
@Repository
public class ReceiverConfigRepository {

	/**
	 * 삽입 화이트리스트 11개 = 요구 컬럼 12개 − {@code id}.
	 *
	 * <p>{@code id}는 자동 증가 정수(ROWID 별칭)라 삽입 대상이 아니다 — 호출자가 값을 주더라도 문장에
	 * 들어가지 않는다.
	 */
	static final List<String> INSERTABLE_COLUMNS = RequiredSchema.RECEIVER_CONFIG_COLUMNS.stream()
			.filter((column) -> !column.equals("id"))
			.toList();

	/** 조회 컬럼은 화이트리스트를 그대로 나열한다 — {@code SELECT *}는 쓰지 않는다(응답 투영이 조용히 넓어진다). */
	private static final String SELECT_ALL_COLUMNS =
			"SELECT " + String.join(", ", RequiredSchema.RECEIVER_CONFIG_COLUMNS)
					+ " FROM " + RequiredSchema.RECEIVER_CONFIG_TABLE;

	/** 정수로 읽는 컬럼 — 나머지는 전부 문자열이다(TEXT affinity라 저장도 조회도 문자열 — Node 동형). */
	private static final String ID = "id";

	private final JdbcClient jdbcClient;

	private final TransactionTemplate transactions;

	public ReceiverConfigRepository(JdbcClient jdbcClient, TransactionTemplate transactions) {
		this.jdbcClient = jdbcClient;
		this.transactions = transactions;
	}

	/**
	 * 화이트리스트 컬럼만 AND 동등 필터로 적용한다. 화이트리스트 밖 키와 {@code null} 값은 무시한다
	 * (Node는 {@code undefined}와 {@code null}을 똑같이 건너뛴다). 정렬은 {@code ORDER BY id}.
	 *
	 * @return 전체 행(시크릿 포함) — 투영은 서비스 책임이다.
	 */
	public List<Map<String, Object>> query(Map<String, ?> filters) {
		List<String> conditions = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		if (filters != null) {
			for (String column : RequiredSchema.RECEIVER_CONFIG_COLUMNS) {
				Object value = filters.get(column);
				if (value == null) {
					continue;
				}
				conditions.add(column + " = ?");
				params.add(ColumnValues.bind(value));
			}
		}
		String where = conditions.isEmpty() ? "" : " WHERE " + String.join(" AND ", conditions);
		return this.jdbcClient.sql(SELECT_ALL_COLUMNS + where + " ORDER BY id")
				.params(params)
				.query(ReceiverConfigRepository::mapRow)
				.list();
	}

	/**
	 * 값이 주어진 화이트리스트 컬럼만 삽입한다({@code id} 제외 — 자동 증가).
	 *
	 * <p><b>삽입과 id 판독은 한 트랜잭션이다</b>(2026-08-24 리뷰 med): {@code last_insert_rowid()}는
	 * <b>커넥션 단위 상태</b>이고 풀 상한이 1이라 모든 스레드가 같은 물리 커넥션을 쓴다. 두 문장을 따로
	 * 실행하면 그 사이에 커넥션이 반납돼 A의 INSERT → B의 INSERT → A의 SELECT 순서에서 A가 <b>B의 id</b>를
	 * 받고, 그 id로 삭제하면 남의 설정 행이 사라진다. Node는 단일 스레드라 없는 결함이라 계약이 관측하지
	 * 않는다 — 묶는 것이 유일한 방어선이다({@code ArticleRepository}의 확립된 관례).
	 *
	 * @return 새 행의 id(정수)
	 * @throws IllegalArgumentException 화이트리스트 컬럼이 하나도 남지 않을 때(빈 삽입문을 만들지 않는다)
	 */
	public int insert(Map<String, ?> entry) {
		List<String> columns = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		if (entry != null) {
			for (String column : INSERTABLE_COLUMNS) {
				if (!entry.containsKey(column)) {
					continue;
				}
				columns.add(column);
				params.add(ColumnValues.bind(entry.get(column)));
			}
		}
		if (columns.isEmpty()) {
			throw new IllegalArgumentException(RequiredSchema.RECEIVER_CONFIG_TABLE + ": 입력할 컬럼이 없습니다");
		}
		Integer id = this.transactions.execute((status) -> {
			this.jdbcClient.sql("INSERT INTO " + RequiredSchema.RECEIVER_CONFIG_TABLE
							+ " (" + String.join(", ", columns) + ") VALUES (" + placeholders(columns.size()) + ")")
					.params(params)
					.update();
			return lastInsertRowId();
		});
		return id == null ? 0 : id;
	}

	/**
	 * 설정 행 하나를 지운다 — {@code DELETE FROM ReceiverConfig WHERE id = ?}. <b>존재 판정을 하지 않는다</b>:
	 * 없는 id·재삭제는 예외가 아니라 changes 0이다(멱등).
	 *
	 * <p>id를 {@code double}로 받아 {@link ColumnValues} 정책으로 <b>REAL 바인딩</b>하는 이유는 Node 동형이다:
	 * Node 라우트는 {@code Number(req.params.id)}로 id를 만들어 그대로 바인딩하고, 비수치 경로({@code /abc})는
	 * {@code Number('abc')=NaN}이 되어 어떤 행에도 매치되지 않는다(200 changes:0, 500 아님 — 2026-08 실측).
	 * {@code long}이면 NaN을 담을 수 없어 이 결과를 재현할 수 없다. SQLite는 {@code id = NaN}을 어떤 정수와도
	 * 같지 않다고 보고, {@code id = 5.0}은 정수 5와 수치적으로 같다고 본다 — 그래서 유효 id·NaN id가 한
	 * 경로로 수렴한다.
	 *
	 * @return 영향 받은 행 수(0 또는 1)
	 */
	public int remove(double id) {
		// 테이블 이름을 상수 연결이 아니라 리터럴로 쓴다: 정적 삭제 금지 스캔
		// (NoSchemaSqlInMainSourcesTest)이 허용하는 유일한 예외가 소스 텍스트에 "DELETE FROM ReceiverConfig"로
		// 그대로 드러나야 하기 때문이다(negative-lookahead가 그 하나만 통과시킨다). 이 이름은
		// RequiredSchema.RECEIVER_CONFIG_TABLE와 같은 값이며, 값이 갈리면 SELECT/INSERT가 즉시 깨져 드러난다.
		return this.jdbcClient.sql("DELETE FROM ReceiverConfig WHERE id = ?")
				.param(ColumnValues.bind(Double.valueOf(id)))
				.update();
	}

	/** 방금 삽입한 행의 ROWID(= INTEGER PK 값). <b>반드시 삽입과 같은 트랜잭션(=같은 커넥션)에서 부른다.</b> */
	private int lastInsertRowId() {
		Integer id = this.jdbcClient.sql("SELECT last_insert_rowid()")
				.query(Integer.class)
				.single();
		return id == null ? 0 : id;
	}

	/**
	 * 컬럼 목록 순서의 맵. 값이 SQL NULL이어도 <b>키는 남긴다</b>(키 없음과 null은 다르다). {@code id}만
	 * 정수로 읽고 나머지는 문자열이다.
	 */
	private static Map<String, Object> mapRow(ResultSet rs, int rowNum) throws SQLException {
		Map<String, Object> row = new LinkedHashMap<>();
		for (String column : RequiredSchema.RECEIVER_CONFIG_COLUMNS) {
			row.put(column, column.equals(ID) ? rs.getLong(column) : rs.getString(column));
		}
		return row;
	}

	private static String placeholders(int count) {
		return String.join(", ", Collections.nCopies(count, "?"));
	}
}
