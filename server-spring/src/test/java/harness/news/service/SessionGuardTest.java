package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.UserRepository;
import harness.news.model.UserRow;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * 세션 가드 — ADR-004의 심장부. 세션은 로그인 시점 스냅샷이 아니라 <b>매 조회마다 User 행을 다시 읽어</b>
 * 신원을 재도출하고, 행이 없거나 {@code active='N'}이면 그 세션을 즉시·영구 무효화한다.
 *
 * <p>이 축이 비면 "비활성화·강등된 계정이 최대 1시간(슬라이딩) 동안 이전 권한을 유지"하는 권한 상승이 된다
 * (phase 67 테스트 게이트가 Node에서 발견한 공백 — 재도출을 지워도 계약 267 케이스가 전부 green이었다).
 * 그래서 여기서는 <b>재조회 횟수</b>와 <b>무효화의 영구성</b>을 직접 관측한다.
 *
 * <p>DB는 임시 파일({@code @TempDir})이고 리포 {@code news.db}는 열지 않는다. 행은 지우지 않는다 —
 * "행 없음" 상황은 <b>처음부터 없는 userId</b>로 세션을 만들어 재현한다(DB 비파괴).
 */
class SessionGuardTest {

	private static final long HOUR_MS = 60L * 60L * 1000L;

	/** Node {@code sessionService.IDENTITY_FIELDS}와 같은 순서·같은 키. */
	private static final List<String> IDENTITY_KEYS =
			List.of("userId", "role", "department", "departmentCode", "name");

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private CountingUserRepository users;

	private MutableClock clock;

	private SessionStore store;

	private SessionGuard guard;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		this.users = new CountingUserRepository(JdbcClient.create(this.dataSource));
		this.clock = new MutableClock(1_700_000_000_000L);
		this.store = new SessionStore(this.clock);
		this.guard = new SessionGuard(this.store, this.users);
		this.users.insert(row(
				"userId", "desk", "name", "김데스크", "password", "$2a$10$hashhashhashhashhashha",
				"role", "Z", "department", "편집국", "departmentCode", "EDT", "active", "Y",
				"failedLoginCount", "3", "lockedUntil", "1787126400000",
				"lastFailedLoginAt", "1787125500000"));
		this.users.findCalls.set(0);
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	// --- 재도출 ------------------------------------------------------------------------------

	@Test
	void identityComesFromTheCurrentDatabaseRow() {
		String sessionId = this.guard.createSession("desk");

		Identity me = this.guard.touchSession(sessionId);

		assertNotNull(me);
		assertEquals("desk", me.userId());
		assertEquals("Z", me.role());
		assertEquals("편집국", me.department());
		assertEquals("EDT", me.departmentCode());
		assertEquals("김데스크", me.name());
	}

	@Test
	void everyLookupReadsTheUserRowAgain() {
		String sessionId = this.guard.createSession("desk");

		this.guard.touchSession(sessionId);
		this.guard.touchSession(sessionId);
		this.guard.peekSession(sessionId);

		assertEquals(3, this.users.findCalls.get(),
				"신원은 세션 캐시가 아니라 매 조회의 DB 재조회에서 온다(캐시·TTL 금지 — ADR-004)");
	}

	@Test
	void roleDemotionAppliesOnTheNextRequestWithoutReLogin() {
		String sessionId = this.guard.createSession("desk");
		assertEquals("Z", this.guard.touchSession(sessionId).role());

		this.users.update("desk", row("role", "R")); // 재로그인 없음 — 토큰은 그대로다.

		assertEquals("R", this.guard.touchSession(sessionId).role(),
				"강등이 다음 요청에 반영되지 않으면 최대 1시간 이전 권한이 유지된다(권한 상승)");
		assertEquals("R", this.guard.peekSession(sessionId).role(), "비연장 조회도 같은 재도출을 거친다");
	}

	@Test
	void deactivationInvalidatesTheSessionImmediatelyAndPermanently() {
		String sessionId = this.guard.createSession("desk");
		assertNotNull(this.guard.touchSession(sessionId));

		this.users.update("desk", row("active", "N")); // 행 삭제가 아니라 soft delete.

		assertNull(this.guard.touchSession(sessionId), "active='N'은 그 세션을 즉시 무효화한다");
		assertNull(this.store.peekSession(sessionId), "스토어에서 제거됐다는 음성 증거(다른 라우트로도 못 산다)");

		this.users.update("desk", row("active", "Y")); // 다시 활성화해도 이미 버려진 토큰은 살아나지 않는다.
		assertNull(this.guard.touchSession(sessionId), "무효화는 영구적이다 — 재로그인만이 새 토큰을 준다");
		assertNull(this.guard.peekSession(sessionId));
	}

	@Test
	void sessionOfAnUnknownUserRowIsInvalidated() {
		// 행을 지우지 않는다(DB 비파괴) — 처음부터 존재하지 않는 userId의 세션으로 같은 상황을 만든다.
		String sessionId = this.guard.createSession("ghost");

		assertNull(this.guard.touchSession(sessionId), "행이 없으면 통과시킬 신원이 없다");
		assertNull(this.store.peekSession(sessionId), "행 없음도 세션을 스토어에서 제거한다");
	}

	@Test
	void legacyRowWithBlankActiveStillPasses() {
		// 비활성 판정은 정확히 'N'일 때만(Node sessionGuard·userService.login과 동형).
		// active를 명시적으로 NULL로 넣는다 — 컬럼 DEFAULT가 'Y'라 키를 빼면 이 상황이 재현되지 않는다.
		this.users.insert(row("userId", "legacy", "name", "옛계정", "role", "R", "active", null));
		String sessionId = this.guard.createSession("legacy");

		Identity me = this.guard.touchSession(sessionId);

		assertNotNull(me, "active가 NULL인 레거시 행을 막으면 기존 사용자가 로그인 후 즉시 튕긴다");
		assertEquals("R", me.role());
	}

	// --- 투영 --------------------------------------------------------------------------------

	@Test
	void identityCarriesNoPasswordOrLockMetadata() {
		String sessionId = this.guard.createSession("desk");

		Identity me = this.guard.touchSession(sessionId);

		assertEquals(IDENTITY_KEYS, List.copyOf(me.asMap().keySet()), "신원은 정확히 5키다");
		String rendered = me.asMap().toString() + me;
		assertFalse(rendered.contains("$2a$10$"), "비밀번호 해시가 신원에 실리면 안 된다: " + rendered);
		assertFalse(rendered.contains("1787126400000"), "잠금 메타가 신원에 실리면 안 된다: " + rendered);
		assertFalse(rendered.contains("active"), "active는 세션 신원 키가 아니다(로그인 응답과 다른 shape): " + rendered);
	}

	@Test
	void sqlNullColumnsStayAsNullValuedKeys() {
		// department/departmentCode 없이 만든 행 — SQL NULL이다. Node identityOf는 5키를 항상 채우므로
		// 응답에 "department":null이 남는다. 키를 지우면 계약(정확 5키)이 깨진다.
		this.users.insert(row("userId", "nodept", "name", "무부서", "role", "R", "active", "Y"));
		String sessionId = this.guard.createSession("nodept");

		Map<String, Object> identity = this.guard.touchSession(sessionId).asMap();

		assertEquals(IDENTITY_KEYS, List.copyOf(identity.keySet()));
		assertTrue(identity.containsKey("department"), "NULL 컬럼도 키는 남는다");
		assertNull(identity.get("department"));
		assertNull(identity.get("departmentCode"));
	}

	// --- DB를 읽지 않는 경로 -------------------------------------------------------------------

	@Test
	void unknownTokenIsRejectedWithoutReadingTheDatabase() {
		assertNull(this.guard.touchSession("not-a-real-token"));
		assertNull(this.guard.peekSession(null));

		assertEquals(0, this.users.findCalls.get(), "존재하지 않는 세션은 DB를 읽지 않는다");
	}

	@Test
	void expiredSessionIsRejectedWithoutReadingTheDatabase() {
		String sessionId = this.guard.createSession("desk");
		this.clock.advance(HOUR_MS);

		assertNull(this.guard.touchSession(sessionId));

		assertEquals(0, this.users.findCalls.get(), "만료 판정이 DB 조회보다 앞선다");
	}

	// --- 위임 --------------------------------------------------------------------------------

	@Test
	void createSessionEnforcesTheSingleSessionPolicyThroughTheStore() {
		String first = this.guard.createSession("desk");
		String second = this.guard.createSession("desk");

		assertNull(this.guard.touchSession(first), "재로그인은 이전 세션을 무효화한다");
		assertNotNull(this.guard.touchSession(second));
	}

	@Test
	void invalidateDelegatesToTheStore() {
		String sessionId = this.guard.createSession("desk");

		assertTrue(this.guard.invalidate(sessionId));

		assertNull(this.guard.touchSession(sessionId));
		assertNull(this.store.peekSession(sessionId));
	}

	// --- 테스트 지원 --------------------------------------------------------------------------

	/** 재조회 횟수를 세는 리포지토리 — "매 요청 DB를 다시 읽는다"를 음성이 아니라 수치로 관측한다. */
	private static final class CountingUserRepository extends UserRepository {

		private final AtomicInteger findCalls = new AtomicInteger();

		CountingUserRepository(JdbcClient jdbcClient) {
			super(jdbcClient);
		}

		@Override
		public UserRow findById(String userId) {
			this.findCalls.incrementAndGet();
			return super.findById(userId);
		}
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}
}
