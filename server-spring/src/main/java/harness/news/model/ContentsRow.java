package harness.news.model;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.ValueSerializer;
import tools.jackson.databind.annotation.JsonSerialize;

/**
 * {@code Contents} 테이블 한 행 — 리포지토리가 주는 <b>원본</b>이다(세션 토큰과 편집 탭 식별자를 포함한다).
 *
 * <p>담는 것이 맞다: 재로그인 takeover 판정({@code lockerSessionId})과 보유 탭 검사
 * ({@code lockerClientId})가 그 값을 읽어야 한다. 위험은 이 행이 <b>그대로 응답 본문이 되는 것</b>이다 —
 * 그러면 인증된 아무 사용자나 목록을 한 번 조회하는 것만으로 데스크의 유효 세션 토큰을 얻는다.
 *
 * <p>그래서 이 타입은 <b>불투명</b>하다(decisions (4)① 타입 경계).
 * <ul>
 *   <li><b>공개 getter도 직렬화 프로퍼티도 없다.</b> 컬럼 접근은 {@link #column(String)} 하나이고,
 *       컬럼 <b>전체</b>를 볼 수 있는 것은 같은 패키지의 {@link ContentsProjection}뿐이다. 서비스·컨트롤러가
 *       "전 컬럼 맵"을 손에 넣을 방법이 구조적으로 없다.</li>
 *   <li><b>직렬화를 거부한다.</b> 응답 본문으로 넘어가면 예외이며, 투영 우회가 조용한 200이 아니라
 *       500으로 드러난다. (실측: Jackson 3은 프로퍼티가 없는 값을 {@code {}}로 직렬화하고 예외를
 *       던지지 않는다. 즉 "getter가 없으니 안전하다"는 것은 <b>유출 방지</b>이지 <b>탐지</b>가 아니라서,
 *       탐지는 이 전용 serializer가 맡는다.)</li>
 *   <li><b>{@code toString()}이 컬럼 값을 찍지 않는다.</b> 로그 한 줄이 곧 토큰 유출이 되지 않게 한다.</li>
 * </ul>
 *
 * <p>키 집합·순서·NULL 키 보존은 감싸기 전과 같다(decisions (5)) — 감싸는 것은 타입뿐이다.
 */
@JsonSerialize(using = ContentsRow.NotAResponseBody.class)
public final class ContentsRow {

	private final Map<String, Object> columns;

	private ContentsRow(Map<String, Object> columns) {
		this.columns = columns;
	}

	/**
	 * 컬럼 순서 맵을 감싼다. 방어적 복사라 이후 원본 맵을 고쳐도 행은 변하지 않는다.
	 * 값이 SQL NULL인 컬럼도 <b>키는 그대로 둔다</b>(decisions (5) — 키 없음과 null은 다르다).
	 */
	public static ContentsRow of(Map<String, Object> columns) {
		return new ContentsRow(Collections.unmodifiableMap(new LinkedHashMap<>(columns)));
	}

	/**
	 * 컬럼 하나를 읽는다 — 내부 판정 경로(잠금 획득·보유자 검사·전이)가 쓰는 유일한 접근 수단이다.
	 * 없는 컬럼은 {@code null}이며, 값이 {@code null}인 컬럼과 구분하지 않는다(둘 다 "값이 없다"다).
	 */
	public Object column(String name) {
		return this.columns.get(name);
	}

	/** 투영 전용(패키지 한정) 전 컬럼 보기. 읽기 전용이며 이 패키지 밖으로 나가지 않는다. */
	Map<String, Object> columns() {
		return this.columns;
	}

	@Override
	public String toString() {
		return "ContentsRow[articleId=" + this.columns.get("articleId") + ", columns=" + this.columns.size() + "]";
	}

	/**
	 * 이 타입을 JSON으로 쓰려는 시도를 <b>실패로 만든다</b>. 응답에 실릴 수 있는 것은
	 * {@link ContentsProjection#toPublic(ContentsRow)}의 결과뿐이다.
	 */
	public static final class NotAResponseBody extends ValueSerializer<ContentsRow> {

		@Override
		public void serialize(ContentsRow value, JsonGenerator generator, SerializationContext context) {
			throw new IllegalStateException(
					"ContentsRow는 응답 본문이 될 수 없다 — ContentsProjection.toPublic(row)을 거쳐라");
		}
	}
}
