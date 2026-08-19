package harness.news.db;

import java.util.List;
import java.util.Map;

/**
 * 이 서버가 DB에 요구하는 테이블·컬럼 목록 — <b>단일 상수</b>다.
 *
 * <p>두 곳이 이것 하나를 읽는다: 부팅 검증({@link SchemaGuard})과 리포지토리의 컬럼 화이트리스트
 * ({@code harness.news.model.UserRepository}). 목록을 두 벌 두면 "검증은 통과했는데 SQL이 없는 컬럼을
 * 건드리는" 상태가 만들어지므로 나누지 않는다.
 *
 * <p><b>이 서버는 스키마를 소유하지 않는다.</b> 정본은 Node 서버의 {@code src/db/schema.js}이고 여기 있는
 * 것은 "요구 사항"일 뿐이다 — 없으면 만드는 것이 아니라 뜨지 않는다. 컬럼이 늘어나는 마이그레이션도
 * Node 쪽에서 일어나며, 이 목록은 그 부분집합(이 phase가 실제로 읽고 쓰는 컬럼)이면 충분하다.
 */
public final class RequiredSchema {

	/** 사용자 테이블 이름. */
	public static final String USER_TABLE = "User";

	/**
	 * User 컬럼 화이트리스트 10개 — 리포 루트 {@code src/models/userModel.js}의 COLUMNS와 순서까지 같다.
	 *
	 * <p>뒤쪽 3개는 계정 잠금 상태다. 표현은 Node와 바이트 동형이어야 한다:
	 * {@code failedLoginCount}는 문자열 정수, {@code lockedUntil}·{@code lastFailedLoginAt}은
	 * <b>epoch ms 문자열</b>이다({@code src/db/schema.js} 주석의 'ISO-8601'은 드리프트이며
	 * {@code src/services/userService.js}가 정본이다). 전환기에 두 서버가 같은 파일을 보면 표현이
	 * 어긋나는 순간 계정 잠금이 조용히 깨진다.
	 */
	public static final List<String> USER_COLUMNS = List.of(
			"userId", "name", "password", "role", "department", "departmentCode", "active",
			"failedLoginCount", "lockedUntil", "lastFailedLoginAt");

	/** 부팅 시 존재를 확인하는 테이블 → 컬럼 목록. 이 phase가 쓰는 것은 User 하나다. */
	public static final Map<String, List<String>> TABLES = Map.of(USER_TABLE, USER_COLUMNS);

	private RequiredSchema() {
	}
}
