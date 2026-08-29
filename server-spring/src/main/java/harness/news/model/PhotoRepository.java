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
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

/**
 * 사진DB 데이터 접근 계층 — 직접 SQL(ORM 없음, ADR-002). 비즈니스 규칙은 없다.
 *
 * <p>리포 루트 {@code src/models/photoModel.js}와 1:1이다(적재 1개와 캡션 검색 1개).
 *
 * <p><b>이 테이블은 append-only다.</b> 여기 있는 연산은 삽입과 조회뿐이고 행을 고치거나 지우는 연산은
 * 없다 — 등록된 {@code src}는 재임베드로 발행 HTML까지 흐르는 참조이고, 수정·삭제 API 자체가 존재하지
 * 않는다(최상위 규칙: DB에 있는 내용은 절대 지우지 않는다). 그 사실은 정적 스캔
 * ({@code NoSchemaSqlInMainSourcesTest})과 리플렉션 단언({@code PhotoRepositoryTest})이 함께 지킨다.
 *
 * <p>이 클래스의 계약 셋.
 * <ol>
 *   <li><b>컬럼은 화이트리스트({@link RequiredSchema#PHOTO_COLUMNS})로만 다루고 {@code SELECT *}를
 *       쓰지 않는다.</b> 정본({@code photoModel.searchByCaption})은 {@code SELECT *}라 오늘의 결과는
 *       같지만, Node 스키마에 컬럼이 추가되면 Node는 노출하고 이쪽은 노출하지 않는 <b>안전측</b>
 *       divergence로 수렴한다(사진 행은 투영 없이 전 사용자에게 그대로 나가는 응답이다).</li>
 *   <li><b>삽입은 present-only</b>다 — 화이트리스트 컬럼 중 키가 주어진 것만 문장에 넣는다(주지 않은
 *       컬럼은 SQL NULL로 남는다. Node {@code record[c] !== undefined} 동형).</li>
 *   <li><b>{@code LIKE}에 {@code ESCAPE}를 붙이지 않는다.</b> 정본이 {@code %q%}를 그대로 바인딩하므로
 *       {@code q='%'}는 전체 매칭이다 — 이스케이프를 더하면 같은 질의에 두 서버가 다른 행 집합을 준다.
 *       계약이 관측하지 않는 축이라 {@code PhotoRepositoryTest}가 유일 방어선이다.</li>
 * </ol>
 *
 * <p>돌려주는 행은 평범한 {@code LinkedHashMap}이다(조회 SQL이 이미 나갈 컬럼만 고른다). 값이 SQL
 * NULL이어도 <b>키는 남긴다</b>(키 없음과 null은 다르다).
 */
@Repository
public class PhotoRepository {

	/**
	 * 삽입 화이트리스트 5개 = 요구 컬럼 6개 − {@code id}.
	 *
	 * <p>{@code id}는 자동 증가 정수(ROWID 별칭)라 삽입 대상이 아니다 — 호출자가 값을 주더라도 문장에
	 * 들어가지 않는다(들어가면 등록 순서를 호출자가 정하게 된다).
	 */
	static final List<String> INSERTABLE_COLUMNS = RequiredSchema.PHOTO_COLUMNS.stream()
			.filter((column) -> !column.equals("id"))
			.toList();

	/** 정수로 읽는 컬럼 — 나머지는 전부 문자열이다(TEXT affinity라 저장도 조회도 문자열 · Node 동형). */
	private static final String ID = "id";

	private final JdbcClient jdbcClient;

	public PhotoRepository(JdbcClient jdbcClient) {
		this.jdbcClient = jdbcClient;
	}

	/**
	 * 사진 1행 적재. 화이트리스트 컬럼 중 <b>키가 주어진 것만</b> 넣는다.
	 *
	 * <p>id 회수는 {@link GeneratedKeyHolder}로 <b>같은 문장에서</b> 한다 — {@code last_insert_rowid()}를
	 * 별도 문장으로 부르면 두 문장 사이에서 커넥션이 반납되고(풀 상한 1) 동시 삽입에서 남의 id를
	 * 돌려준다(phase 70 실측). 이 id는 {@code {ok,id}} 응답으로 나가 클라이언트가 행을 지목하는
	 * 식별자라 오배정은 곧 오식별이다.
	 *
	 * @return 새 행의 id(정수)
	 * @throws IllegalArgumentException 화이트리스트 컬럼이 하나도 없을 때(빈 INSERT를 만들지 않는다)
	 */
	public long insert(Map<String, ?> record) {
		List<String> columns = new ArrayList<>();
		List<Object> params = new ArrayList<>();
		for (String column : INSERTABLE_COLUMNS) {
			if (record == null || !record.containsKey(column)) {
				continue;
			}
			columns.add(column);
			params.add(ColumnValues.bind(record.get(column)));
		}
		if (columns.isEmpty()) {
			throw new IllegalArgumentException(RequiredSchema.PHOTO_TABLE + ": 입력할 컬럼이 없습니다");
		}

		KeyHolder keys = new GeneratedKeyHolder();
		this.jdbcClient.sql("INSERT INTO " + RequiredSchema.PHOTO_TABLE + " ("
						+ String.join(", ", columns) + ") VALUES (" + placeholders(columns.size()) + ")")
				.params(params)
				.update(keys);
		Number id = keys.getKey();
		if (id == null) {
			throw new IllegalStateException("사진 행의 id를 돌려받지 못했습니다 — 삽입 결과를 신뢰할 수 없습니다");
		}
		return id.longValue();
	}

	/**
	 * 캡션 부분일치({@code LIKE '%q%'}) 검색 — 최신 등록이 위에 오도록 <b>id DESC</b>다.
	 *
	 * <p>빈 질의는 {@code LIKE '%%'}라 전체가 나온다(400이 아니다). 문자열 문맥으로 접는 정규화
	 * ({@code String(...)} 의미론 · 반복 쿼리 키)는 <b>서비스 계층</b>의 책임이고, 여기서는 {@code null}이
	 * 500으로 번지지 않도록 빈 문자열로만 접는다.
	 */
	public List<Map<String, Object>> searchByCaption(String q) {
		String needle = "%" + ((q == null) ? "" : q) + "%";
		return this.jdbcClient.sql("SELECT " + String.join(", ", RequiredSchema.PHOTO_COLUMNS)
						+ " FROM " + RequiredSchema.PHOTO_TABLE + " WHERE caption LIKE ? ORDER BY id DESC")
				.param(ColumnValues.bind(needle))
				.query(PhotoRepository::mapRow)
				.list();
	}

	/**
	 * 스키마 순서의 6키 맵. 값이 SQL NULL이어도 <b>키는 남긴다</b>. {@code id}만 정수로 읽고 나머지는
	 * 문자열이다.
	 */
	private static Map<String, Object> mapRow(ResultSet rs, int rowNum) throws SQLException {
		Map<String, Object> row = new LinkedHashMap<>();
		for (String column : RequiredSchema.PHOTO_COLUMNS) {
			if (column.equals(ID)) {
				row.put(column, rs.getLong(column));
			}
			else {
				row.put(column, rs.getString(column));
			}
		}
		return row;
	}

	private static String placeholders(int count) {
		return String.join(", ", Collections.nCopies(count, "?"));
	}
}
