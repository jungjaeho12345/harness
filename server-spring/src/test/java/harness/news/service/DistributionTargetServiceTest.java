package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.ArticleRepository;
import harness.news.model.DistributionTargetRepository;
import harness.news.model.UserRepository;
import harness.news.testsupport.MutableClock;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
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
 * 배부 수신처 서비스 — 리포 루트 {@code src/services/distributionTargetService.js}와 1:1(게이트·검증·soft
 * delete·투영). HTTP·파일시스템 비의존.
 *
 * <p>2026-08-22 Node 대조 실측(작업 A)과 1:1이다: 검증 순서 name→kind→spoolDir→active, name trim 저장,
 * kind/active 대소문자 보정 없음, create가 createdAt·updatedAt 둘 다 stamp, update/deactivate는 updatedAt만
 * stamp(createdAt 불변), self-exclusion 엄격 비교(자기 slug 재저장 허용), NaN id → not-found(500 아님),
 * soft delete(행 안 지움).
 */
class DistributionTargetServiceTest {

	private static final List<String> SAFE_FIELDS =
			List.of("id", "name", "kind", "spoolDir", "active", "createdAt", "updatedAt");

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private DistributionTargetRepository targets;

	private SessionGuard guard;

	private MutableClock clock;

	private DistributionTargetService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(tempDir);
		dataSource = NewsDataSource.create(tempDir);
		JdbcClient jdbc = JdbcClient.create(dataSource);
		UserRepository users = new UserRepository(jdbc);
		ArticleRepository articles = new ArticleRepository(jdbc,
				new TransactionTemplate(new JdbcTransactionManager(dataSource)),
				Clock.fixed(Instant.parse("2026-08-22T00:00:00.000Z"), ZoneOffset.UTC));
		this.guard = new SessionGuard(new SessionStore(new MutableClock(1_700_000_000_000L)), users);
		Authorization authorization = new Authorization(this.guard, articles);
		this.targets = new DistributionTargetRepository(jdbc);
		this.clock = new MutableClock(Instant.parse("2026-08-22T10:00:00.000Z").toEpochMilli());
		this.service = new DistributionTargetService(this.targets, authorization, this.clock);
		insertUser(users, "dt-z", "Z");
		insertUser(users, "dt-r", "R");
		insertUser(users, "dt-d", "D");
	}

	@AfterEach
	void tearDown() {
		if (dataSource != null) {
			dataSource.close();
		}
	}

	private String zToken() {
		return this.guard.createSession("dt-z");
	}

	private String stamp() {
		return Iso8601.now(this.clock);
	}

	// --- 인가(모든 op) -------------------------------------------------------------------------

	@Test
	void everyOperationRequiresAnAdminSession() {
		Map<String, Object> entry = row("name", "n", "kind", "press", "spoolDir", "z1");
		for (Map<String, Object> denied : List.of(
				this.service.query(null, Map.of()),
				this.service.create(null, entry),
				this.service.update(null, 1, entry),
				this.service.deactivate(null, 1))) {
			assertFalse((Boolean) denied.get("ok"));
			assertEquals("unauthenticated", denied.get("reason"));
		}
		for (String userId : List.of("dt-r", "dt-d")) {
			String token = this.guard.createSession(userId);
			assertEquals("forbidden", this.service.query(token, Map.of()).get("reason"), userId);
			assertEquals("forbidden", this.service.create(token, entry).get("reason"), userId);
			assertEquals("forbidden", this.service.update(token, 1, entry).get("reason"), userId);
			assertEquals("forbidden", this.service.deactivate(token, 1).get("reason"), userId);
		}
	}

	// --- create ------------------------------------------------------------------------------

	@Test
	void createStampsBothTimestampsTrimsTheNameAndDefaultsActiveToY() {
		String expected = stamp();
		Map<String, Object> result = this.service.create(zToken(),
				row("name", "  언론사  ", "kind", "press", "spoolDir", "press-1"));

		assertEquals(List.of("ok", "id"), List.copyOf(result.keySet()), "create 응답은 정확 {ok,id} 2키다");
		assertEquals(1L, result.get("id"));

		Map<String, Object> stored = this.targets.findById(1);
		assertEquals("언론사", stored.get("name"), "name은 trim해 저장한다");
		assertEquals("Y", stored.get("active"), "active 미지정 기본은 'Y'");
		assertEquals(expected, stored.get("createdAt"), "createdAt을 now()로 stamp");
		assertEquals(expected, stored.get("updatedAt"), "updatedAt을 now()로 stamp");
	}

	@Test
	void createLetsTheServerOwnIdAndTimestampsIgnoringEntryFields() {
		String expected = stamp();
		this.service.create(zToken(), row("name", "n", "kind", "nonpress", "spoolDir", "np1",
				"id", 999, "createdAt", "HACK", "updatedAt", "HACK"));

		Map<String, Object> stored = this.targets.findById(1);
		assertEquals(1L, stored.get("id"), "id는 서버가 정한다(entry.id 무시)");
		assertEquals(expected, stored.get("createdAt"), "entry.createdAt는 채택하지 않는다");
		assertEquals(expected, stored.get("updatedAt"));
	}

	@Test
	void createValidationOrderIsNameThenKindThenSpoolDirThenActive() {
		String z = zToken();
		// name이 먼저다 — name·kind가 둘 다 나빠도 invalid-name.
		assertEquals("invalid-name",
				this.service.create(z, row("name", "", "kind", "BAD", "spoolDir", "x/y")).get("reason"));
		// kind가 spoolDir보다 먼저 — kind·spoolDir가 둘 다 나빠도 invalid-kind.
		assertEquals("invalid-kind",
				this.service.create(z, row("name", "ok", "kind", "BAD", "spoolDir", "x/y")).get("reason"));
		// spoolDir가 active보다 먼저 — spoolDir·active가 둘 다 나빠도 invalid-spool-dir.
		assertEquals("invalid-spool-dir",
				this.service.create(z, row("name", "ok", "kind", "press", "spoolDir", "BAD/x", "active", "Q"))
						.get("reason"));
		// 마지막이 active.
		assertEquals("invalid-active",
				this.service.create(z, row("name", "ok", "kind", "press", "spoolDir", "good1", "active", "Q"))
						.get("reason"));
	}

	@Test
	void createRejectsInvalidNamesAndKindsWithoutCoercion() {
		String z = zToken();
		assertEquals("invalid-name",
				this.service.create(z, row("kind", "press", "spoolDir", "s1")).get("reason"), "비문자열/부재 name");
		assertEquals("invalid-name",
				this.service.create(z, row("name", "   ", "kind", "press", "spoolDir", "s2")).get("reason"),
				"공백뿐인 name");
		assertEquals("invalid-name",
				this.service.create(z, row("name", "a".repeat(101), "kind", "press", "spoolDir", "s3")).get("reason"),
				"100자 초과 name");
		assertEquals("invalid-kind",
				this.service.create(z, row("name", "ok", "kind", "PRESS", "spoolDir", "s4")).get("reason"),
				"대문자 PRESS는 거부(대소문자 보정 없음)");
	}

	@Test
	void createRejectsADuplicateSpoolDirIncludingInactiveRows() {
		String z = zToken();
		this.service.create(z, row("name", "a", "kind", "press", "spoolDir", "shared"));
		this.service.deactivate(z, 1); // 비활성이어도 slug는 유일성에 포함된다.

		assertEquals("duplicate-spool-dir",
				this.service.create(z, row("name", "b", "kind", "press", "spoolDir", "shared")).get("reason"));
	}

	// --- update(present-only) ------------------------------------------------------------------

	@Test
	void updatePatchesOnlyGivenFieldsStampsUpdatedAtAndKeepsCreatedAt() {
		String created = stamp();
		this.service.create(zToken(), row("name", "옛이름", "kind", "press", "spoolDir", "press-1"));

		this.clock.advance(60_000);
		String updated = stamp();
		Map<String, Object> result = this.service.update(zToken(), 1, row("name", "새이름"));

		assertEquals(List.of("ok", "changes"), List.copyOf(result.keySet()), "정확 {ok,changes} 2키");
		assertEquals(1, result.get("changes"));

		Map<String, Object> stored = this.targets.findById(1);
		assertEquals("새이름", stored.get("name"));
		assertEquals("press-1", stored.get("spoolDir"), "주지 않은 필드는 불변");
		assertEquals(created, stored.get("createdAt"), "createdAt은 update가 바꾸지 않는다(계약 createdAtStable)");
		assertEquals(updated, stored.get("updatedAt"), "updatedAt은 now()로 갱신");
	}

	@Test
	void updateChecksExistenceBeforeValidationSoAMissingIdIsNotFoundNot400() {
		// 없는 id에 잘못된 name을 함께 줘도 not-found다(없는 id가 검증 사유로 둔갑하지 않는다).
		assertEquals("not-found", this.service.update(zToken(), 999, row("name", "")).get("reason"));
	}

	@Test
	void updateAllowsRewritingOwnSpoolDirViaStrictSelfExclusion() {
		String z = zToken();
		this.service.create(z, row("name", "a", "kind", "press", "spoolDir", "press-1"));

		// 자기 자신은 중복 검사에서 제외된다(엄격 정수 비교) — 자기 slug 재저장은 duplicate가 아니다.
		assertEquals(1, this.service.update(z, 1, row("spoolDir", "press-1")).get("changes"));
	}

	@Test
	void updateToASlugTakenByAnotherRowIsDuplicate() {
		String z = zToken();
		this.service.create(z, row("name", "a", "kind", "press", "spoolDir", "aaa"));
		this.service.create(z, row("name", "b", "kind", "press", "spoolDir", "bbb"));

		assertEquals("duplicate-spool-dir", this.service.update(z, 1, row("spoolDir", "bbb")).get("reason"));
	}

	@Test
	void updateValidatesEachPresentFieldAndSavesNothingOnViolation() {
		String z = zToken();
		this.service.create(z, row("name", "a", "kind", "press", "spoolDir", "aaa"));

		assertEquals("invalid-kind", this.service.update(z, 1, row("kind", "PRESS")).get("reason"));
		assertEquals("invalid-active", this.service.update(z, 1, row("active", "Q")).get("reason"));
		assertEquals("invalid-spool-dir", this.service.update(z, 1, row("spoolDir", "BAD/x")).get("reason"));
		assertEquals("press", this.targets.findById(1).get("kind"), "위반 시 아무것도 저장하지 않는다");
	}

	@Test
	void updateWithNaNIdIsNotFoundNotAServerError() {
		assertEquals("not-found", this.service.update(zToken(), Double.NaN, row("name", "z")).get("reason"));
	}

	// --- deactivate(soft delete) ---------------------------------------------------------------

	@Test
	void deactivateFlipsActiveToNViaTheSameHelperAndDoesNotDeleteTheRow() {
		this.service.create(zToken(), row("name", "a", "kind", "press", "spoolDir", "aaa"));
		this.clock.advance(120_000);
		String updated = stamp();

		Map<String, Object> result = this.service.deactivate(zToken(), 1);
		assertEquals(List.of("ok", "changes"), List.copyOf(result.keySet()));
		assertEquals(1, result.get("changes"));

		Map<String, Object> stored = this.targets.findById(1);
		assertEquals("N", stored.get("active"), "soft delete — active='N'");
		assertEquals(updated, stored.get("updatedAt"), "deactivate도 update와 같은 헬퍼로 updatedAt을 stamp");
		assertEquals(1, this.targets.query(Map.of()).size(), "행을 지우지 않는다");
	}

	@Test
	void deactivateOfAMissingOrNaNIdIsNotFound() {
		assertEquals("not-found", this.service.deactivate(zToken(), 999).get("reason"));
		assertEquals("not-found", this.service.deactivate(zToken(), Double.NaN).get("reason"));
	}

	// --- query 투영 · pickFilters --------------------------------------------------------------

	@Test
	@SuppressWarnings("unchecked")
	void queryProjectsSafeFieldsAndPassesOnlyScalarFilters() {
		String z = zToken();
		this.service.create(z, row("name", "한글수신처", "kind", "press", "spoolDir", "press-1"));
		this.service.create(z, row("name", "b", "kind", "nonpress", "spoolDir", "np"));

		Map<String, Object> all = this.service.query(z, Map.of());
		List<Map<String, Object>> items = (List<Map<String, Object>>) all.get("items");
		assertEquals(2, items.size());
		assertEquals(SAFE_FIELDS, List.copyOf(items.get(0).keySet()), "정확 7키를 SAFE_FIELDS 순서로");

		// 스칼라 필터는 통과, 배열·객체 필터는 무시(모델 바인딩 오류·필터 주입 차단).
		List<Map<String, Object>> pressOnly = (List<Map<String, Object>>)
				this.service.query(z, Map.of("kind", "press")).get("items");
		assertEquals(1, pressOnly.size());
		assertEquals("한글수신처", pressOnly.get(0).get("name"), "비-ASCII 값도 저장·조회된다");

		List<Map<String, Object>> ignoredArrayFilter = (List<Map<String, Object>>)
				this.service.query(z, Map.of("kind", List.of("press", "nonpress"))).get("items");
		assertEquals(2, ignoredArrayFilter.size(), "배열 필터 값은 무시된다(전건)");
	}

	// --- 헬퍼 ---------------------------------------------------------------------------------

	private static void insertUser(UserRepository users, String userId, String role) {
		Map<String, Object> row = new LinkedHashMap<>();
		row.put("userId", userId);
		row.put("name", userId);
		row.put("password", "$2a$10$hashhashhashhashhashha");
		row.put("role", role);
		row.put("active", "Y");
		users.insert(row);
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}
}
