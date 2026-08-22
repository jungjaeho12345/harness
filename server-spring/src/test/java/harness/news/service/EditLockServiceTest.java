package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.ArticleRepository;
import harness.news.service.EditLockService.LockResult;
import harness.news.service.EditLockService.Requester;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.lang.reflect.RecordComponent;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 편집 잠금 서비스 — 리포 루트 {@code src/services/articleService.js}의 {@code acquireEditLock}·
 * {@code releaseEditLock}·{@code forceReleaseEditLock}·{@code assertLockHolder}와 1:1인 동작 계약.
 * HTTP는 없다({@code @TempDir} 임시 DB + 실제 리포지토리 + 고정 시계 — 리포 {@code news.db} 무접촉).
 *
 * <p>기대값의 출처는 계획서가 아니라 <b>Node 정본 실측</b>이다: 리포 밖 임시 DB에 스키마를 세우고
 * {@code createArticleService}의 잠금 4연산을 <b>행 상태 7종 × 요청자 9종</b>으로 전수 관측했다
 * (2026-08-21). 아래 테스트의 각 단언은 그 격자의 칸이다.
 *
 * <h2>여기서 잠그는 것</h2>
 * <ol>
 *   <li><b>DB NULL ≠ 헤더 부재</b>(decisions (11)) — {@code lockerUserId}는 있고
 *       {@code lockerClientId}는 NULL인 잠금 행은 <b>API로 도달 가능</b>하고(헤더 없이 획득하면 그 행이
 *       된다), 그 행에 헤더 없는 저장 요청이 오면 <b>거부</b>다. Java 기본 의미론
 *       ({@code Objects.equals(null, null)})으로 옮기면 그 자리가 인가 구멍이 된다.</li>
 *   <li><b>인가는 탭 문자열 하나로 하지 않는다</b>(ADR-004) — 남의 탭 식별자를 그대로 흉내내도 세션
 *       신원이 다르면 해제·저장이 거부된다.</li>
 *   <li><b>실패는 보유자를 노출하지 않는다</b> — 결과가 담는 것은 {@code ok}·{@code reason}뿐이다.</li>
 *   <li><b>세션 일치를 강제하지 않는다</b> — 재로그인한 편집자가 자기 잠금을 놓고 저장할 수 있다
 *       (강제하면 30분 동안 편집물이 유실된다).</li>
 *   <li><b>DB 비파괴</b> — 해제는 5컬럼 갱신이고 행은 남는다.</li>
 * </ol>
 */
class EditLockServiceTest {

	private static final String ID = "AKR20260820100000001";

	private static final String OTHER_ID = "AKR20260820100000002";

	/** {@code Article} 행만 있고 {@code Contents} 행이 없는 기사 — 정본은 이것도 not-found다. */
	private static final String ARTICLE_ONLY_ID = "AKR20260820100000003";

	private static final String NO_SUCH_ID = "AKR20260820999999999";

	private static final String U1 = "reporter1";

	private static final String U2 = "desk1";

	private static final String S1 = "session-1";

	private static final String S2 = "session-2";

	private static final String TAB_A = "tab-A";

	private static final String TAB_B = "tab-B";

	private static final Instant T0 = Instant.parse("2026-08-20T12:34:56.789Z");

	private static final String ISO_T0 = "2026-08-20T12:34:56.789Z";

	/** T0 + 1분 — 재획득이 시각을 갱신한다는 것의 기대값(상수로 박는다: 포매터를 테스트가 다시 부르지 않는다). */
	private static final String ISO_T0_PLUS_1MIN = "2026-08-20T12:35:56.789Z";

	private static final long ONE_MINUTE_MS = 60_000L;

	/** 30분. {@link EditLockTtl#TTL_MS}와 같은 값을 <b>테스트가 따로</b> 들고 있는다(상수 동시 변조 방지). */
	private static final long TTL_MS = 30L * 60L * 1000L;

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private JdbcClient client;

	private MutableClock clock;

	private ArticleRepository articles;

	private EditLockService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(tempDir);
		dataSource = NewsDataSource.create(tempDir);
		client = JdbcClient.create(dataSource);
		clock = new MutableClock(T0.toEpochMilli());
		articles = new ArticleRepository(client, new TransactionTemplate(new JdbcTransactionManager(dataSource)),
				clock);
		service = new EditLockService(articles, clock);
		seedArticle(ID);
	}

	@AfterEach
	void tearDown() {
		if (dataSource != null) {
			dataSource.close();
		}
	}

	// --- 1. 획득 ------------------------------------------------------------------------------

	@Test
	void acquiringAnUnlockedArticleStampsTheFiveLockColumns() {
		LockResult res = service.acquire(ID, who(U1, S1, TAB_A));

		assertTrue(res.ok());
		assertNull(res.reason(), "성공에는 사유가 없다");
		assertEquals("Y", column(ID, "lockYN"));
		assertEquals(U1, column(ID, "lockerUserId"));
		assertEquals(S1, column(ID, "lockerSessionId"));
		assertEquals(TAB_A, column(ID, "lockerClientId"));
		assertEquals(ISO_T0, column(ID, "lockedAt"), "시각은 주입된 시계 + 소수 3자리 포매터가 만든다");
	}

	@Test
	void theSameTabReacquiresTheLockAndTheTimeIsRefreshed() {
		service.acquire(ID, who(U1, S1, TAB_A));
		clock.advance(ONE_MINUTE_MS);

		LockResult again = service.acquire(ID, who(U1, S1, TAB_A));

		assertTrue(again.ok(), "같은 탭의 재획득(F5 새로고침)은 허용된다");
		assertEquals(ISO_T0_PLUS_1MIN, column(ID, "lockedAt"), "재획득도 시각을 갱신한다(TTL이 다시 시작된다)");
		assertEquals(TAB_A, column(ID, "lockerClientId"));
	}

	@Test
	void theSameUserFromANewSessionTakesOverTheLock() {
		service.acquire(ID, who(U1, S1, TAB_A));
		clock.advance(ONE_MINUTE_MS);

		LockResult reLogin = service.acquire(ID, who(U1, S2, TAB_B));

		assertTrue(reLogin.ok(), "같은 사용자가 다른 세션으로 재로그인하면 이전 세션은 만료된 것으로 본다");
		assertEquals(U1, column(ID, "lockerUserId"));
		assertEquals(S2, column(ID, "lockerSessionId"), "잠금은 새 세션으로 넘어간다");
		assertEquals(TAB_B, column(ID, "lockerClientId"));
		assertEquals(ISO_T0_PLUS_1MIN, column(ID, "lockedAt"));
	}

	@Test
	void everyOtherAcquirerIsLockedOutAndTheReasonRevealsNothingAboutTheHolder() {
		service.acquire(ID, who(U1, S1, TAB_A));

		LockResult secondTab = service.acquire(ID, who(U1, S1, TAB_B));
		LockResult otherUser = service.acquire(ID, who(U2, S2, TAB_B));
		LockResult noTabHeader = service.acquire(ID, who(U1, S1, null));

		for (LockResult denied : List.of(secondTab, otherUser, noTabHeader)) {
			assertFalse(denied.ok());
			assertEquals("locked", denied.reason(), "획득 충돌의 사유는 언제나 locked 하나다");
		}

		// 결과가 담을 수 있는 것은 두 값뿐이다 — 보유자 userId·세션·탭을 실을 자리가 구조적으로 없다.
		List<String> components = Arrays.stream(LockResult.class.getRecordComponents())
				.map(RecordComponent::getName)
				.toList();
		assertEquals(List.of("ok", "reason"), components, "실패 응답에 보유자 식별자를 담지 않는다");
		for (LockResult denied : List.of(secondTab, otherUser, noTabHeader)) {
			String text = String.valueOf(denied);
			assertFalse(text.contains(U1), "보유자 userId가 결과에 새어 나오면 안 된다");
			assertFalse(text.contains(S1), "세션 토큰은 어떤 결과에도 없다");
			assertFalse(text.contains(TAB_A), "탭 식별자는 사칭 재료다");
		}

		assertEquals(U1, column(ID, "lockerUserId"), "거부된 시도는 기존 잠금을 건드리지 않는다");
		assertEquals(TAB_A, column(ID, "lockerClientId"));
		assertEquals(ISO_T0, column(ID, "lockedAt"));
	}

	@Test
	void aLockGoesStaleAfterThirtyMinutesAndOnlyThenCanAnyoneTakeIt() {
		lockRow(ID, U1, S1, TAB_A, ISO_T0);

		clock.setMillis(T0.toEpochMilli() + TTL_MS - 1);
		assertEquals("locked", service.acquire(ID, who(U2, S2, TAB_B)).reason(), "29:59.999는 아직 유효한 잠금이다");

		clock.setMillis(T0.toEpochMilli() + TTL_MS);
		assertEquals("locked", service.acquire(ID, who(U2, S2, TAB_B)).reason(), "정각 30:00.000도 아직 유효하다(초과일 때만 stale)");

		clock.setMillis(T0.toEpochMilli() + TTL_MS + 1);
		assertTrue(service.acquire(ID, who(U2, S2, TAB_B)).ok(), "30분을 넘기면 다음 시도자가 가져간다");
		assertEquals(U2, column(ID, "lockerUserId"));
		assertEquals(TAB_B, column(ID, "lockerClientId"));

		// 시각을 모르는 잠금은 stale이다 — 모르는 잠금을 유효하다고 보면 그 기사는 아무도 편집할 수 없다.
		lockRow(ID, U1, S1, TAB_A, null);
		assertTrue(service.acquire(ID, who(U2, S2, TAB_B)).ok(), "lockedAt이 NULL이면 stale이다");
		lockRow(ID, U1, S1, TAB_A, "언제인지 모르는 값");
		assertTrue(service.acquire(ID, who(U2, S2, TAB_B)).ok(), "lockedAt을 읽을 수 없어도 stale이다");
	}

	// --- 2. 해제 ------------------------------------------------------------------------------

	@Test
	void theHolderReleasesTheLockAndTheRowSurvives() {
		service.acquire(ID, who(U1, S1, TAB_A));
		int contentsBefore = rowCount("Contents");
		int articleBefore = rowCount("Article");

		LockResult res = service.release(ID, who(U1, S1, TAB_A));

		assertTrue(res.ok());
		assertEquals("N", column(ID, "lockYN"));
		assertNull(column(ID, "lockerUserId"), "해제는 보유자 표시도 지운다");
		assertNull(column(ID, "lockerSessionId"));
		assertNull(column(ID, "lockerClientId"));
		assertNull(column(ID, "lockedAt"));
		assertEquals(contentsBefore, rowCount("Contents"), "해제는 갱신이다 — 행을 지우지 않는다(DB 비파괴)");
		assertEquals(articleBefore, rowCount("Article"));
		assertNotNull(articles.findById(ID).article(), "본문 행도 그대로다");
	}

	@Test
	void releasingAnArticleThatIsNotLockedIsIdempotentAndWritesNothing() {
		LockResult fresh = service.release(ID, who(U1, S1, TAB_A));

		assertTrue(fresh.ok(), "탭 닫기·pagehide가 중복 호출한다 — 잠겨 있지 않아도 성공이다");
		assertEquals("N", column(ID, "lockYN"));

		// 플래그는 N인데 잠금 컬럼이 남아 있는 행(레거시) — 정본은 조기 반환이라 그 값을 건드리지 않는다.
		client.sql("UPDATE Contents SET lockYN = 'N', lockerUserId = ?, lockerSessionId = ?, lockerClientId = ?,"
						+ " lockedAt = ? WHERE articleId = ?")
				.params(List.of(U1, S1, TAB_A, ISO_T0, ID))
				.update();

		assertTrue(service.release(ID, who(U1, S1, TAB_A)).ok());
		assertEquals(U1, column(ID, "lockerUserId"), "멱등 성공은 아무것도 쓰지 않는다");
		assertEquals(TAB_A, column(ID, "lockerClientId"));
		assertEquals(ISO_T0, column(ID, "lockedAt"));
	}

	@Test
	void neitherAnotherUserNorAnotherTabCanRelease() {
		service.acquire(ID, who(U1, S1, TAB_A));

		LockResult stolenTab = service.release(ID, who(U2, S2, TAB_A));
		LockResult otherTab = service.release(ID, who(U1, S1, TAB_B));
		LockResult noTabHeader = service.release(ID, who(U1, S1, null));

		for (LockResult denied : List.of(stolenTab, otherTab, noTabHeader)) {
			assertFalse(denied.ok());
			assertEquals("not-holder", denied.reason(), "해제 실패 사유는 전부 not-holder로 수렴한다");
		}
		assertEquals("Y", column(ID, "lockYN"), "거부된 해제는 잠금을 풀지 않는다");
		assertEquals(U1, column(ID, "lockerUserId"));
		assertEquals(TAB_A, column(ID, "lockerClientId"));
	}

	@Test
	void theReleasePathIsLenientWhenTheLockRowCarriesNoTab() {
		lockRow(ID, U1, S1, null, ISO_T0);
		assertTrue(service.release(ID, who(U1, S1, TAB_A)).ok(), "행에 탭이 없으면 탭 검사를 건너뛴다(정본의 의도된 관용)");

		lockRow(ID, U1, S1, null, ISO_T0);
		assertTrue(service.release(ID, who(U1, S1, null)).ok(), "헤더가 없어도 사용자가 맞으면 해제된다");

		lockRow(ID, U1, S1, null, ISO_T0);
		assertEquals("not-holder", service.release(ID, who(U2, S2, TAB_A)).reason(),
				"관용은 탭에만 있다 — 사용자 대조는 그대로다");
		assertEquals("Y", column(ID, "lockYN"));
	}

	@Test
	void aRenewedSessionOfTheHolderStillReleasesAndSaves() {
		lockRow(ID, U1, S1, TAB_A, ISO_T0);

		assertTrue(service.assertHolder(ID, who(U1, S2, TAB_A)).ok(), "세션이 갱신돼도 보유 탭의 저장은 인가된다");
		assertTrue(service.release(ID, who(U1, S2, TAB_A)).ok(), "세션 일치를 강제하면 편집자가 자기 잠금을 놓지 못한다");
		assertEquals("N", column(ID, "lockYN"));
	}

	// --- 3. 보유자 검사(저장 인가) --------------------------------------------------------------

	@Test
	void savingIsDeniedWhenTheArticleIsNotLocked() {
		assertEquals("not-holder", service.assertHolder(ID, who(U1, S1, TAB_A)).reason(),
				"잠금이 없으면 저장 인가도 없다");
	}

	/**
	 * <b>이 step의 핵심 인가 함정</b>(decisions (11)). 구성으로 만든 특수 행이 아니라 <b>API로 도달하는
	 * 조합</b>이다 — {@code x-edit-client} 없이 잠금을 획득하면 {@code lockerUserId}는 있고
	 * {@code lockerClientId}는 NULL인 행이 만들어진다. 그 행에 헤더 없는 저장 요청이 오면
	 * {@code null == null}을 동치로 보는 순진한 포팅이 <b>보유자가 아닌 요청에 저장 인가</b>를 준다.
	 */
	@Test
	void savingIsDeniedWhenTheRowHasNoTabEvenIfTheRequestHasNoTabEither() {
		LockResult acquired = service.acquire(ID, who(U1, S1, null));
		assertTrue(acquired.ok(), "전제: 탭 헤더 없이도 잠금은 획득된다(그래서 이 조합이 실제로 존재한다)");
		assertEquals(U1, column(ID, "lockerUserId"));
		assertNull(column(ID, "lockerClientId"), "전제: 헤더 부재는 컬럼 NULL로 저장된다");

		assertEquals("not-holder", service.assertHolder(ID, who(U1, S1, null)).reason(),
				"DB NULL과 헤더 부재는 같은 값이 아니다 — 잠금 행의 본인이어도 탭을 증명하지 못하면 저장 불가다");
		assertEquals("not-holder", service.assertHolder(ID, who(U2, S2, null)).reason(),
				"남의 잠금 아래에서 헤더 없이 저장하는 경로가 열리면 그것이 인가 우회다");
		assertEquals("not-holder", service.assertHolder(ID, who(U1, S1, TAB_A)).reason(),
				"행에 탭이 없으면 어떤 탭 문자열도 그 자리를 차지하지 못한다");
	}

	/**
	 * 대조군 — 빈 문자열 탭은 <b>부재가 아니라 값</b>이다(Node {@code '' === ''}). 이 행은 보유로 치지
	 * 않으므로(다음 시도자가 그대로 덮어쓴다) 남는 인가는 "같은 사용자 + 같은 빈 값"뿐이고, 그것은
	 * 탭을 증명하지 못한 요청이 <b>남의</b> 잠금을 통과하는 경로가 아니다.
	 */
	@Test
	void anEmptyTabIsAValueNotAnAbsence() {
		seedArticle(OTHER_ID);
		assertTrue(service.acquire(OTHER_ID, who(U1, S1, "")).ok());
		assertEquals("", column(OTHER_ID, "lockerClientId"));

		assertTrue(service.assertHolder(OTHER_ID, who(U1, S1, "")).ok(), "빈 값끼리는 Node에서 같은 값이다");
		assertEquals("not-holder", service.assertHolder(OTHER_ID, who(U1, S1, null)).reason(),
				"빈 값과 부재는 다르다");
		assertEquals("not-holder", service.assertHolder(OTHER_ID, who(U2, S2, "")).reason(),
				"빈 탭이어도 사용자 대조는 그대로다");
		assertTrue(service.acquire(OTHER_ID, who(U2, S2, TAB_B)).ok(), "빈 탭은 보유로 치지 않는다 — 다음 시도자가 덮어쓴다");
	}

	@Test
	void savingIsDeniedWhenEitherIdentityIsUnknown() {
		lockRow(ID, U1, S1, TAB_A, ISO_T0);
		assertEquals("not-holder", service.assertHolder(ID, who(null, S1, TAB_A)).reason(),
				"요청 신원이 없으면 거부다 — '미전달이면 통과' 폴백은 인가를 조용히 여는 구멍이다");

		// 보유자 id가 비어 있는 레거시 잠금 행 — 저장도 해제도 거부다(남는 수단은 강제 해제와 30분 stale이다).
		lockRow(ID, null, S1, TAB_A, ISO_T0);
		assertEquals("not-holder", service.assertHolder(ID, who(U1, S1, TAB_A)).reason());
		assertEquals("not-holder", service.release(ID, who(U1, S1, TAB_A)).reason());
		assertEquals("Y", column(ID, "lockYN"));
	}

	@Test
	void theHolderTabIsAuthorizedToSaveEvenAfterTheLockWentStale() {
		lockRow(ID, U1, S1, TAB_A, ISO_T0);

		assertTrue(service.assertHolder(ID, who(U1, S1, TAB_A)).ok());
		assertNull(service.assertHolder(ID, who(U1, S1, TAB_A)).reason());

		clock.setMillis(T0.toEpochMilli() + TTL_MS + 1);
		assertTrue(service.assertHolder(ID, who(U1, S1, TAB_A)).ok(),
				"TTL은 획득 경쟁에만 쓰인다 — 30분 넘게 편집하던 보유자의 저장을 막지 않는다");
	}

	@Test
	void neitherASecondTabNorAStolenTabStringCanSave() {
		lockRow(ID, U1, S1, TAB_A, ISO_T0);

		assertEquals("not-holder", service.assertHolder(ID, who(U1, S1, TAB_B)).reason(),
				"같은 사용자의 2번째 탭도 저장할 수 없다");
		assertEquals("not-holder", service.assertHolder(ID, who(U2, S2, TAB_A)).reason(),
				"남의 탭 문자열을 알아도 사람이 다르면 거부다(ADR-004 — 탭 문자열 하나로 인가하지 않는다)");
	}

	// --- 4. 강제 해제 --------------------------------------------------------------------------

	@Test
	void forceReleaseClearsAnyLockRegardlessOfTheHolder() {
		service.acquire(ID, who(U1, S1, TAB_A));
		int contentsBefore = rowCount("Contents");

		LockResult forced = service.forceRelease(ID);

		assertTrue(forced.ok());
		assertNull(forced.reason());
		assertEquals("N", column(ID, "lockYN"));
		assertNull(column(ID, "lockerUserId"));
		assertNull(column(ID, "lockerSessionId"));
		assertNull(column(ID, "lockerClientId"));
		assertNull(column(ID, "lockedAt"));
		assertEquals(contentsBefore, rowCount("Contents"), "강제 해제도 갱신이다 — 행을 지우지 않는다");

		assertTrue(service.forceRelease(ID).ok(), "잠겨 있지 않은 기사도 성공이다(존재만 확인한다)");

		lockRow(ID, null, S1, TAB_A, ISO_T0);
		assertTrue(service.forceRelease(ID).ok(), "보유자 id가 비어 있는 잠금도 푼다");
		assertEquals("N", column(ID, "lockYN"));
	}

	// --- 5. 존재 판정이 먼저다 -----------------------------------------------------------------

	@Test
	void everyOperationReportsNotFoundBeforeItJudgesTheHolder() {
		seedArticleRowOnly();

		for (String target : List.of(NO_SUCH_ID, ARTICLE_ONLY_ID)) {
			assertEquals("not-found", service.acquire(target, who(U1, S1, TAB_A)).reason(), target);
			assertEquals("not-found", service.release(target, who(U1, S1, TAB_A)).reason(), target);
			assertEquals("not-found", service.assertHolder(target, who(U1, S1, TAB_A)).reason(), target);
			assertEquals("not-found", service.forceRelease(target).reason(), target);
		}
	}

	// --- 픽스처 ------------------------------------------------------------------------------

	private static Requester who(String userId, String sessionId, String clientId) {
		return new Requester(userId, sessionId, clientId);
	}

	private void seedArticle(String articleId) {
		articles.insert(Map.of("articleId", articleId, "title", "제목"),
				Map.of("articleId", articleId, "status", "RDS"));
	}

	/** {@code Contents} 행이 없는 기사 — 정본 {@code !row.contents} 분기를 관측하기 위한 픽스처다. */
	private void seedArticleRowOnly() {
		articles.insert(Map.of("articleId", ARTICLE_ONLY_ID, "title", "본문만"), null);
	}

	/** 잠금 행을 직접 만든다(플래그는 언제나 {@code 'Y'}) — 레거시·부분 잠금 조합의 재현 수단이다. */
	private void lockRow(String articleId, String userId, String sessionId, String clientId, String lockedAt) {
		articles.setLock(articleId, new ArticleRepository.EditLock(userId, sessionId, clientId, lockedAt));
	}

	private Object column(String articleId, String name) {
		return articles.findById(articleId).contents().column(name);
	}

	private int rowCount(String table) {
		return client.sql("SELECT COUNT(*) FROM " + table).query(Integer.class).single();
	}
}
