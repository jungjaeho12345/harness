package harness.news.model;

/**
 * User 테이블 한 행 — 리포지토리가 주는 <b>raw</b>다(비밀번호 해시와 잠금 상태를 포함한다).
 *
 * <p>도메인 로직(로그인 판정·매 요청 신원 재도출)이 그 값들을 읽어야 하므로 담는 것이 맞다. 위험은
 * 이 객체가 실수로 그대로 응답 본문이나 로그 문자열이 되는 것이다({@code lockerSessionId} 유출 사례와
 * 같은 부류의 사고다). 그래서 두 가지를 형(型)에 박아 둔다.
 *
 * <ul>
 *   <li><b>record가 아니라 접근자 이름이 {@code getXxx}가 아닌 일반 클래스다.</b> JSON 매퍼는 이 타입에서
 *       속성을 하나도 찾지 못하므로, 그대로 응답으로 내보내면 값이 새는 대신 빈 객체가 되거나 예외로
 *       터진다 — 어느 쪽이든 유출이 아니다. 응답 투영은 서비스/컨트롤러가 <b>명시적으로</b> 만든다.
 *       (실측: record + {@code @JsonIgnoreType}은 이 방어가 되지 않는다. 그 애노테이션은 "다른 타입의
 *       속성으로 쓰일 때"만 무시하게 하고 루트 값 직렬화는 그대로 통과시킨다.)</li>
 *   <li><b>{@code toString()}이 비밀번호 해시를 가린다.</b> 기본 {@code toString()}은 전 필드를 그대로
 *       찍어서 로그 한 줄이 곧 자격 유출이 된다.</li>
 * </ul>
 *
 * <p>전 컬럼이 TEXT라 필드는 전부 String이다. 잠금 시각도 문자열(epoch ms)이며 그 표현이 Node와
 * 동형이어야 하는 이유는 {@link harness.news.db.RequiredSchema}에 적어 두었다.
 */
public final class UserRow {

	private final String userId;

	private final String name;

	private final String password;

	private final String role;

	private final String department;

	private final String departmentCode;

	private final String active;

	private final String failedLoginCount;

	private final String lockedUntil;

	private final String lastFailedLoginAt;

	public UserRow(String userId, String name, String password, String role, String department,
			String departmentCode, String active, String failedLoginCount, String lockedUntil,
			String lastFailedLoginAt) {
		this.userId = userId;
		this.name = name;
		this.password = password;
		this.role = role;
		this.department = department;
		this.departmentCode = departmentCode;
		this.active = active;
		this.failedLoginCount = failedLoginCount;
		this.lockedUntil = lockedUntil;
		this.lastFailedLoginAt = lastFailedLoginAt;
	}

	public String userId() {
		return this.userId;
	}

	public String name() {
		return this.name;
	}

	/** 저장된 비밀번호 해시. 응답·로그에 담지 마라 — 대조(BCrypt)에만 쓴다. */
	public String password() {
		return this.password;
	}

	public String role() {
		return this.role;
	}

	public String department() {
		return this.department;
	}

	public String departmentCode() {
		return this.departmentCode;
	}

	/** {@code 'Y'} 또는 {@code 'N'}. 비활성화는 행 삭제가 아니라 이 값의 변경이다. */
	public String active() {
		return this.active;
	}

	/** 연속 로그인 실패 횟수 — 문자열 정수({@code '0'}, {@code '1'} …). */
	public String failedLoginCount() {
		return this.failedLoginCount;
	}

	/** 잠금 해제 시각 — epoch ms 문자열. 비어 있으면(NULL) 미잠금. */
	public String lockedUntil() {
		return this.lockedUntil;
	}

	/** 마지막 실패 시각 — epoch ms 문자열. */
	public String lastFailedLoginAt() {
		return this.lastFailedLoginAt;
	}

	@Override
	public String toString() {
		return "UserRow[userId=" + this.userId + ", role=" + this.role + ", active=" + this.active
				+ ", password=***]";
	}
}
