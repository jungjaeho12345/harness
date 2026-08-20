package harness.news.service;

import harness.news.model.UserRow;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 인증된 요청의 신원 — DB {@link UserRow}에서 <b>화이트리스트 5필드</b>만 투영한 값이다.
 * 리포 루트 {@code src/services/sessionService.js}의 {@code identityOf}/{@code IDENTITY_FIELDS}와 1:1이다.
 *
 * <p>비밀번호 해시와 잠금 메타({@code failedLoginCount}·{@code lockedUntil}·{@code lastFailedLoginAt})는
 * 담지 않는다 — 이 타입이 응답·로그에 흘러도 유출할 값이 없어야 한다. {@code active}도 담지 않는다:
 * 비활성 계정은 애초에 신원이 만들어지지 않으므로(가드가 세션을 무효화한다) 실릴 이유가 없고,
 * {@code GET /api/session}의 user 키 집합이 5개로 동결돼 있다(로그인 응답 6키와 다른 shape이다).
 *
 * <p><b>NULL 처리 주의.</b> {@link #asMap()}은 값이 {@code null}인 필드도 <b>키를 남긴다</b>.
 * Node의 {@code identityOf}는 5필드를 무조건 채우므로 부서가 비어 있는 계정도 응답에
 * {@code "department":null}이 실린다. "값이 없으면 키를 뺀다"로 뭉개면 정확 5키 계약이 깨진다
 * (흡수 대상 클라우드 구현의 실제 결함 — index.json decisions (18)(c)). 응답 조립은 이 맵에서 시작하고,
 * JSON 직렬화 설정에 null 제외(non_null 포함 규칙)를 걸지 않는다.
 *
 * @param userId 로그인 아이디(PK)
 * @param role 권한 — <b>DB 최신값</b>이다(로그인 시점 스냅샷이 아니다, ADR-004)
 * @param department 부서명(없으면 {@code null})
 * @param departmentCode 부서 코드(없으면 {@code null})
 * @param name 표시 이름
 */
public record Identity(String userId, String role, String department, String departmentCode,
		String name) {

	/** DB 행에서 신원을 투영한다 — 행 전체를 들고 다니지 않는 유일한 진입점이다. */
	public static Identity of(UserRow row) {
		return new Identity(row.userId(), row.role(), row.department(), row.departmentCode(),
				row.name());
	}

	/**
	 * 응답 조립용 순서 있는 맵 — 키 5개가 <b>항상</b> 있고 값이 없으면 {@code null}이다
	 * (Node {@code IDENTITY_FIELDS} 순서). 호출자가 바꿔도 신원에 되먹임되지 않는 새 맵을 돌려준다.
	 */
	public Map<String, Object> asMap() {
		Map<String, Object> map = new LinkedHashMap<>();
		map.put("userId", this.userId);
		map.put("role", this.role);
		map.put("department", this.department);
		map.put("departmentCode", this.departmentCode);
		map.put("name", this.name);
		return map;
	}
}
