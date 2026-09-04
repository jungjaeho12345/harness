package harness.news.model;

import java.sql.Types;
import org.springframework.jdbc.core.SqlParameterValue;

/**
 * 기사 도메인 리포지토리의 <b>값 바인딩 정책 단일 출처</b>(phase 69 decisions (8)).
 *
 * <p>규칙은 셋이다: 문자열은 텍스트로, <b>숫자는 REAL로</b>, {@code null}은 SQL NULL로 바인딩하고,
 * <b>그 밖(불리언·객체·배열)은 예외</b>다. 예외는 전역 핸들러가 500 {@code internal-error}로 만든다 —
 * Node의 {@code node:sqlite}가 그 입력에 TypeError를 던지기 때문이다. 조용히 문자열화하면 같은 입력에
 * 두 서버가 갈린다. 예외 메시지에 값을 담지 않는다(본문·토큰이 로그로 새지 않게).
 *
 * <p>숫자를 <b>Java에서 문자열로 만들지 않는</b> 이유는 실측이다: {@code node:sqlite}는 JS number를
 * 예외 없이 REAL로 내리고, 그 REAL을 <b>컬럼의 affinity</b>가 저장 표현으로 바꾼다
 * (2026-08-21 실측 — TEXT affinity: {@code 42 → "42.0"} · {@code 1e9 → "1000000000.0"} ·
 * {@code 1.2345678901234567e19 → "1.2345678901234567e+19"} / INTEGER affinity({@code ArticleHistory.targetId}):
 * {@code 42 → 정수 42} · {@code 1.5 → 실수 1.5}). 여기서 {@code String.valueOf(42)}로 바꾸면 TEXT
 * 컬럼에 {@code "42"}가 저장돼 같은 입력에 두 서버의 저장값이 갈린다. REAL로 내리면 <b>같은 SQLite
 * 변환 코드</b>가 돌아 두 종류의 컬럼 모두에서 표현이 저절로 일치한다 — 자체 숫자 포매터를 만들지 않는다.
 *
 * <p>타입을 명시하는 것은 {@code null}도 확정적으로 SQL NULL이 되게 하기 위해서다(타입 미상 null
 * 바인딩은 드라이버마다 동작이 갈린다).
 *
 * <p>정책을 두 벌 두지 않는 이유: 한쪽만 고쳐지는 순간 같은 값이 테이블마다 다르게 저장되고, 그
 * 어긋남은 계약이 관측하지 않는 축이라 조용히 산다.
 */
final class ColumnValues {

	private ColumnValues() {
	}

	/** 위 정책대로 값 하나를 바인딩 파라미터로 만든다. */
	static SqlParameterValue bind(Object value) {
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
				"DB 컬럼에 바인딩할 수 없는 값 타입입니다: " + value.getClass().getName());
	}

	/**
	 * 유한하지 않은 id({@code NaN}·±무한대)인가 — <b>그런 id는 어떤 행에도 매치되지 않는다.</b>
	 *
	 * <p>이 판정을 SQL <b>이전에</b> 하는 이유는 방언 실측이다(2026-09-04 · phase 75 step7이 MySQL 계약
	 * 패리티에서 잡았다). 비수치 경로 파라미터는 Node 의미론({@code Number('abc')})을 따라 {@code NaN}으로
	 * 넘어오는데, SQLite는 {@code id = NaN}을 조용히 0행으로 답하는 반면 <b>MySQL은 문장 자체가 깨진다</b>:
	 * Connector/J가 {@code NaN}을 리터럴 {@code NaN}으로 보내고 서버는 그것을 컬럼 이름으로 읽어
	 * {@code Unknown column 'NaN' in 'where clause'}를 낸다. 그 결과가
	 * {@code PUT /api/distribution-targets/abc} <b>404 → 500</b>,
	 * {@code DELETE /api/receiver-config/abc} <b>200 → 500</b> 이었다.
	 *
	 * <p>방언 분기로 고치지 않는다. "유한하지 않은 id는 매치되지 않는다"는 것은 <b>정본(Node·SQLite)의
	 * 의미론</b>이고, 그것을 코드로 옮기면 두 방언이 같은 답을 주며 sqlite 경로의 동작은 한 톨도 바뀌지
	 * 않는다. 무한대를 함께 막는 이유도 같다({@code Number('Infinity')}가 실제로 도달 가능한 경로다).
	 *
	 * <p>범위는 <b>{@code double}로 받는 id 파라미터</b>뿐이다 — 값 컬럼의 숫자 바인딩은 위
	 * {@link #bind(Object)} 정책 그대로다(그쪽을 건드리면 저장 표현이 갈린다).
	 */
	static boolean matchesNoRow(double id) {
		return !Double.isFinite(id);
	}
}
