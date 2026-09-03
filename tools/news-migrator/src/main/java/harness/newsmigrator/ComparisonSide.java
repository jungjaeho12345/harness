package harness.newsmigrator;

import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * 대조·복사의 <b>한쪽</b> — SQLite 파일이든 MySQL 스키마든 같은 창구로 읽는다.
 *
 * <h2>왜 대칭이 필요한가</h2>
 * step3 의 대조기는 "소스는 SQLite · 대상은 MySQL" 로 굳어 있었다. step4 의 왕복 대조는
 * <b>SQLite ↔ SQLite</b> 다({@code news.db} 원본과 역방향 산출물). 방향마다 대조기를 하나씩 만들면
 * 비교 규칙이 두 벌이 되고, 두 벌은 반드시 갈린다 — 그리고 갈린 쪽은 <b>덜 엄격한 쪽</b>이다.
 * 그래서 저장소가 아니라 <b>행을 내주는 방법</b>만 다르게 두고 판정은 한 곳에 남긴다.
 *
 * <h2>행을 모아 주지 않고 흘려 주는 이유</h2>
 * {@code Article.markupVersion} 은 실측 최댓값이 165,802바이트다. 한쪽을 통째로 메모리에 올리는 것은
 * 대조기의 선택이어야지 이 창구의 강제가 아니다(대조기는 <b>한쪽만</b> PK 로 색인하고 다른 쪽은 흘려
 * 읽는다).
 */
public interface ComparisonSide extends AutoCloseable {

	/** 로그·리포트에 실어도 되는 표현 — <b>비밀번호는 들어가지 않는다.</b> */
	String describe();

	/** 이 쪽에 실제로 있는 테이블(내부 테이블과 {@link #excludedTables()} 는 빼고). */
	List<String> tableNames();

	/**
	 * 대조에서 <b>명시적으로</b> 빼는 테이블(예: 이관 원장).
	 *
	 * <p>"정본에 없으면 무시" 로 넓히지 않기 위해 이름을 밝혀 돌려준다 — 리포트가 그것을 적고,
	 * 그 밖의 예상 밖 테이블은 구조 문제로 남는다(ADR-016 트레이드오프 ⑨).
	 */
	default List<String> excludedTables() {
		return List.of();
	}

	/**
	 * 한 테이블의 전 행을 흘려 준다 — 컬럼은 <b>이름으로</b> 고르고 값은 {@link CellValues} 규칙으로 읽는다.
	 *
	 * @param table 읽을 테이블(기반선 선언)
	 * @param handler 행 하나마다 부르는 소비자(컬럼 이름 → 값)
	 */
	void forEachRow(BaselineSchema.Table table, Consumer<Map<String, Object>> handler);

	@Override
	void close();

}
