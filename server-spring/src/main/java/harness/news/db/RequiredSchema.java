package harness.news.db;

import java.util.List;
import java.util.Map;

/**
 * 이 서버가 DB에 요구하는 테이블·컬럼 목록 — <b>단일 상수</b>다.
 *
 * <p>두 곳이 이것 하나를 읽는다: 부팅 검증({@link SchemaGuard})과 리포지토리의 컬럼 화이트리스트
 * ({@code harness.news.model.UserRepository}·{@code harness.news.model.ArticleRepository}). 목록을 두 벌
 * 두면 "검증은 통과했는데 SQL이 없는 컬럼을 건드리는" 상태가 만들어지므로 나누지 않는다.
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

	/** 기사 본문 마크업 테이블 이름. {@code Contents}와 {@code articleId}로 1:1이다. */
	public static final String ARTICLE_TABLE = "Article";

	/**
	 * Article 컬럼 5개 — {@code src/db/schema.js}의 {@code SCHEMA.Article}과 순서까지 같다.
	 *
	 * <p>검색 응답이 이 행을 그대로 싣는다(투영 대상이 아니다) — 즉 <b>이 목록이 곧 응답 5키</b>이고,
	 * 순서 드리프트도 계약 위반이다.
	 */
	public static final List<String> ARTICLE_COLUMNS = List.of(
			"articleId", "title", "content", "markupVersion", "modifier");

	/** 기사 공통정보·생애주기·편집 잠금 테이블 이름. */
	public static final String CONTENTS_TABLE = "Contents";

	/**
	 * Contents 컬럼 29개 — {@code src/db/schema.js}의 {@code SCHEMA.Contents}와 순서까지 같다.
	 *
	 * <p>이 목록이 <b>SELECT 나열의 단일 출처</b>다({@code SELECT *} 금지 — 그러면 응답 키 집합이 스키마
	 * 변경에 따라 조용히 넓어지고, 투영이 모르는 새 컬럼이 그대로 나간다). 응답은 여기서
	 * {@link harness.news.model.ContentsProjection#PRIVATE_COLUMNS} 2개를 뺀 27키다.
	 */
	public static final List<String> CONTENTS_COLUMNS = List.of(
			"articleId", "title", "content", "author", "modifier", "sender",
			"department", "departmentCode", "createdAt", "editedAt", "sentAt",
			"distributedAt", "embargoAt", "secondEmbargoAt", "status",
			"lockYN", "lockerUserId", "lockerSessionId", "lockerClientId", "lockedAt",
			"coAuthor", "category", "region", "attribute", "keyword",
			"internalComment", "externalComment", "attachmentFile", "referenceFile");

	/**
	 * 부팅 시 존재를 확인하는 테이블 → 컬럼 목록.
	 *
	 * <p><b>여기에 테이블을 넣는 것은 전역 파급이다</b>: {@link SchemaGuard}가 이 목록 전체를 부팅에서
	 * 검증하므로, 테스트 정본 픽스처({@code db/user-schema.sql})가 따라오지 않으면 그 픽스처로 시드된
	 * 모든 기동 테스트가 컨텍스트 로딩에서 죽는다. 목록 확장과 픽스처 확장은 같은 step에서 한다.
	 */
	public static final Map<String, List<String>> TABLES = Map.of(
			USER_TABLE, USER_COLUMNS,
			ARTICLE_TABLE, ARTICLE_COLUMNS,
			CONTENTS_TABLE, CONTENTS_COLUMNS);

	private RequiredSchema() {
	}
}
