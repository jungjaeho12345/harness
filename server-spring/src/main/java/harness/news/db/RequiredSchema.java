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

	/** 기사 편집·전이·배부 이벤트 원장 테이블 이름. <b>append-only</b>(삽입과 조회뿐). */
	public static final String HISTORY_TABLE = "ArticleHistory";

	/**
	 * ArticleHistory 컬럼 12개 — {@code src/db/schema.js}의 {@code SCHEMA.ArticleHistory}와 순서까지 같다.
	 *
	 * <p>다른 테이블과 달리 <b>전부 TEXT affinity가 아니다</b>: {@code id}는 자동 증가 정수(ROWID 별칭)라
	 * 삽입 대상이 아니고, {@code targetId}도 정수 컬럼이다. {@code targetId}가 VARCHAR면 숫자 id가
	 * 문자열로 저장되어 {@code DistributionTarget.id}와의 매칭이 조용히 깨진다(SCHEMA.md가 명시한 예외).
	 *
	 * <p>{@code eventType} 어휘(create · edit · status · distribute · distribute-failed ·
	 * distribute-retry)는 <b>도메인 쪽 사실</b>이고 이 목록은 컬럼만 안다 — Node 모델도 같은 규율이다
	 * (모델은 도메인 비의존, 문자열만 둔다).
	 */
	public static final List<String> HISTORY_COLUMNS = List.of(
			"id", "articleId", "eventType", "action", "fromStatus", "toStatus",
			"actorUserId", "createdAt", "markupVersion", "snapshotTitle", "targetId", "reason");

	/** 수집(자동기사) 수신 설정 테이블 이름 — {@code rcvMgmt.do}의 저장 대상. */
	public static final String RECEIVER_CONFIG_TABLE = "ReceiverConfig";

	/**
	 * ReceiverConfig 컬럼 12개 — {@code src/db/schema.js}의 {@code SCHEMA.ReceiverConfig}와 순서까지 같다.
	 *
	 * <p>{@code id}는 자동 증가 정수(ROWID 별칭)라 삽입 대상이 아니다 — 리포지토리가 화이트리스트로
	 * 삽입 컬럼을 걸러낸다({@code ArticleHistory}의 {@code id}와 같은 규율). 나머지는 전부 VARCHAR다.
	 * {@code password}(FTP)·{@code apiKey}(API)는 <b>쓰기 전용 시크릿</b>이라 스키마에는 있지만 서비스
	 * 투영(SAFE_FIELDS)에는 없다.
	 */
	public static final List<String> RECEIVER_CONFIG_COLUMNS = List.of(
			"id", "sourceId", "type", "name", "host", "port", "username",
			"password", "apiEndpoint", "apiKey", "active", "createdAt");

	/** 배부 대상(수신처) 테이블 이름 — ADR-008. 삭제 없음(active='N' soft delete). */
	public static final String DISTRIBUTION_TARGET_TABLE = "DistributionTarget";

	/**
	 * DistributionTarget 컬럼 7개 — {@code src/db/schema.js}의 {@code SCHEMA.DistributionTarget}와
	 * 순서까지 같다. {@code id}는 자동 증가 정수(ROWID 별칭)라 삽입/수정 대상이 아니고 나머지는 VARCHAR다.
	 * {@code kind} enum·{@code spoolDir} 슬러그 검증은 서비스 계층 책임이다(모델은 도메인 비의존).
	 */
	public static final List<String> DISTRIBUTION_TARGET_COLUMNS = List.of(
			"id", "name", "kind", "spoolDir", "active", "createdAt", "updatedAt");

	/** 사진DB 테이블 이름. <b>append-only</b>(등록과 검색뿐 — 수정·삭제 API가 없다). */
	public static final String PHOTO_TABLE = "Photo";

	/**
	 * Photo 컬럼 6개 — {@code src/db/schema.js}의 {@code SCHEMA.Photo}와 순서까지 같다.
	 *
	 * <p>{@code id}는 자동 증가 정수(ROWID 별칭)라 삽입 대상이 아니고 나머지는 VARCHAR다. 검색 응답이
	 * 이 행을 <b>투영·마스킹 없이 그대로</b> 싣는다 — 즉 <b>이 목록이 곧 응답 원소 6키</b>이고 순서
	 * 드리프트도 계약 위반이다({@code SELECT *} 금지: Node 스키마에 컬럼이 늘어도 응답이 따라 넓어지지
	 * 않는 안전측을 택한다).
	 *
	 * <p>{@code registeredBy}는 <b>검증된 세션에서만</b> stamp되는 신원이다(ADR-004). 이 컬럼이 없는 DB로
	 * 뜨면 그 계약이 런타임에 조용히 깨지므로 부팅 검증이 컬럼 단위로 지목한다.
	 */
	public static final List<String> PHOTO_COLUMNS = List.of(
			"id", "src", "caption", "sourceArticleId", "registeredBy", "createdAt");

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
			CONTENTS_TABLE, CONTENTS_COLUMNS,
			HISTORY_TABLE, HISTORY_COLUMNS,
			RECEIVER_CONFIG_TABLE, RECEIVER_CONFIG_COLUMNS,
			DISTRIBUTION_TARGET_TABLE, DISTRIBUTION_TARGET_COLUMNS,
			PHOTO_TABLE, PHOTO_COLUMNS);

	private RequiredSchema() {
	}
}
