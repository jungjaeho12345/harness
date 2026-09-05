package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
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
 * 배부 대상 서비스 — 리포 루트 {@code src/services/distributionTargetService.js}와 동형.
 *
 * <p>잠그는 축: (1) 검증 순서 name→kind→spoolDir→active. (2) duplicate-spool-dir는 비활성 행까지 포함.
 * (3) update present-only + 존재 확인이 검증보다 먼저(없는/비수치 id → not-found). (4) update·deactivate가
 * 같은 applyPatch로 수렴해 둘 다 updatedAt stamp. (5) 4 op Z 게이트. (6) 투영 7키·NULL 키 보존.
 */
class DistributionTargetServiceTest {

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private DistributionTargetRepository targets;

	private SessionGuard guard;

	private MutableClock clock;

	private DistributionTargetService service;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(this.tempDir);
		this.dataSource = NewsDataSource.create(this.tempDir);
		UserRepository users = new UserRepository(JdbcClient.create(this.dataSource));
		ArticleRepository articles = new ArticleRepository(JdbcClient.create(this.dataSource),
				new TransactionTemplate(new JdbcTransactionManager(this.dataSource)),
				Clock.fixed(Instant.parse("2026-08-20T12:34:56.789Z"), ZoneOffset.UTC));
		this.guard = new SessionGuard(new SessionStore(new MutableClock(1_700_000_000_000L)), users);
		Authorization authorization = new Authorization(this.guard, articles);
		this.targets = new DistributionTargetRepository(JdbcClient.create(this.dataSource));
		this.clock = new MutableClock(Instant.parse("2026-08-22T00:00:00.000Z").toEpochMilli());
		this.service = new DistributionTargetService(this.targets, authorization, this.clock);
		insertUser("dt-z", "Z");
		insertUser("dt-r", "R");
		insertUser("dt-d", "D");
	}

	@AfterEach
	void tearDown() {
		if (this.dataSource != null) {
			this.dataSource.close();
		}
	}

	private String zToken() {
		return this.guard.createSession("dt-z");
	}

	// --- create 검증 순서 name → kind → spoolDir → active -----------------------------------------

	@Test
	void createValidatesInTheContractOrder() {
		// 네 필드를 동시에 틀리게 보내고, 앞의 것을 하나씩 고치며 다음 토큰이 순서대로 나오는지 본다.
		assertEquals("invalid-name",
				this.service.create(zToken(), entry("kind", "bogus", "spoolDir", "../bad", "active", "x")).reason(),
				"name이 없으면 name이 가장 먼저다");
		assertEquals("invalid-kind",
				this.service.create(zToken(), entry("name", "ok", "kind", "bogus", "spoolDir", "../bad", "active", "x")).reason());
		assertEquals("invalid-spool-dir",
				this.service.create(zToken(), entry("name", "ok", "kind", "press", "spoolDir", "../bad", "active", "x")).reason());
		assertEquals("invalid-active",
				this.service.create(zToken(), entry("name", "ok", "kind", "press", "spoolDir", "ok-slug", "active", "x")).reason());
	}

	@Test
	void createSucceedsWithDefaultActiveYAndNoRowOnRejection() {
		DistributionTargetService.Result ok = this.service.create(zToken(),
				entry("name", "대상", "kind", "press", "spoolDir", "sp-ok"));
		assertTrue(ok.ok());
		assertTrue(ok.id() > 0);
		assertEquals("Y", this.targets.findById(ok.id()).get().get("active"), "active 미지정이면 Y");

		// 거부는 행을 만들지 않는다.
		assertFalse(this.service.create(zToken(), entry("name", "x", "kind", "press", "spoolDir", "../bad")).ok());
		assertEquals(0, this.targets.query(Map.of("name", "x")).size());
	}

	@Test
	void nonStringNameIsRejectedWithoutCoercion() {
		// String.valueOf(비문자열)이 통과하는 결함 차단.
		assertEquals("invalid-name",
				this.service.create(zToken(), entry("name", 123, "kind", "press", "spoolDir", "sp-n")).reason());
		assertEquals("invalid-name",
				this.service.create(zToken(), entry("name", "   ", "kind", "press", "spoolDir", "sp-n")).reason(),
				"공백만 있는 이름도 거부");
	}

	/**
	 * <b>누락·{@code null} 필드는 사유 토큰이지 예외가 아니다.</b> {@code Set.of(...).contains(null)}은
	 * NPE라 kind를 빼고 보낸 요청이 전역 핸들러를 타고 500 {@code internal-error}가 된다 — Node는
	 * {@code KINDS.has(undefined)}가 거짓이라 400 {@code invalid-kind}다(2026-08-24 리뷰 high-2).
	 *
	 * <p>{@code checkName}은 처음부터 타입 게이트({@code instanceof})를 앞세워 이 벡터가 없었다 —
	 * 집합 검사 둘만 빠져 있었고, 계약·와이어·서비스 케이스가 전부 kind를 실어 보내 0관측이었다.
	 */
	@Test
	void missingOrNullSetFieldsAreReasonTokensNotExceptions() {
		assertEquals("invalid-kind",
				this.service.create(zToken(), entry("name", "ok", "spoolDir", "sp-nk")).reason(),
				"kind 누락은 400 사유 토큰이다(NPE 아님)");
		assertEquals("invalid-kind",
				this.service.create(zToken(), entry("name", "ok", "kind", null, "spoolDir", "sp-nk")).reason());
		assertEquals("invalid-kind",
				this.service.create(zToken(), entry("name", "ok", "kind", 1, "spoolDir", "sp-nk")).reason(),
				"비문자열 kind도 강제변환 없이 거부");
		assertEquals("invalid-active", this.service
				.create(zToken(), entry("name", "ok", "kind", "press", "spoolDir", "sp-na", "active", null)).reason(),
				"active:null은 '미지정'이 아니다 — 키가 있으므로 검증 대상이다");
		assertEquals(0, this.targets.query(Map.of("name", "ok")).size(), "거부된 create는 행을 만들지 않는다");

		int id = this.service.create(zToken(), entry("name", "설정", "kind", "press", "spoolDir", "sp-nn")).id();
		assertEquals("invalid-kind", this.service.update(zToken(), id, entry("kind", null)).reason());
		assertEquals("invalid-active",
				this.service.update(zToken(), id, entry("active", null)).reason());
		Map<String, Object> untouched = this.targets.findById(id).get();
		assertEquals("press", untouched.get("kind"), "거부된 update는 아무것도 바꾸지 않는다");
		assertEquals("Y", untouched.get("active"));
	}

	// --- duplicate-spool-dir (비활성 포함) --------------------------------------------------------

	@Test
	void duplicateSpoolDirIsRejectedIncludingInactiveRows() {
		int first = this.service.create(zToken(), entry("name", "A", "kind", "press", "spoolDir", "sp-dup")).id();
		assertEquals("duplicate-spool-dir",
				this.service.create(zToken(), entry("name", "B", "kind", "press", "spoolDir", "sp-dup")).reason());

		// 첫 대상을 비활성으로 내려도 그 슬러그는 여전히 사용 중이다(비활성 행까지 유일성에 포함).
		this.service.deactivate(zToken(), first);
		assertEquals("N", this.targets.findById(first).get().get("active"));
		assertEquals("duplicate-spool-dir",
				this.service.create(zToken(), entry("name", "C", "kind", "press", "spoolDir", "sp-dup")).reason(),
				"비활성 대상의 스풀 폴더도 duplicate로 걸린다");
	}

	// --- update present-only · 존재 확인이 검증보다 먼저 -------------------------------------------

	@Test
	void updateIsPresentOnlyAndChecksExistenceBeforeValidation() {
		int id = this.service.create(zToken(), entry("name", "원래", "kind", "press", "spoolDir", "sp-up")).id();

		// present-only: name만 보내면 그것만 바뀌고 kind는 불변.
		assertEquals(1, this.service.update(zToken(), id, entry("name", "바뀜")).changes());
		Map<String, Object> after = this.targets.findById(id).get();
		assertEquals("바뀜", after.get("name"));
		assertEquals("press", after.get("kind"), "전달하지 않은 필드는 불변");

		// 전달 필드 하나라도 위반이면 아무것도 저장 안 됨.
		assertEquals("invalid-kind", this.service.update(zToken(), id, entry("kind", "bogus")).reason());
		assertEquals("바뀜", this.targets.findById(id).get().get("name"), "거부된 update는 아무것도 바꾸지 않는다");

		// 존재 확인이 검증보다 먼저 — 없는 id에 잘못된 필드를 보내도 not-found(검증 토큰이 아니다).
		assertEquals("not-found", this.service.update(zToken(), 999999, entry("kind", "bogus")).reason());
		assertEquals("not-found", this.service.update(zToken(), Double.NaN, entry("name", "x")).reason(),
				"비수치 id는 라우트의 Number() 판독에서 NaN이 되어 not-found로 수렴한다(500 아님)");
	}

	// --- update·deactivate 수렴 + updatedAt stamp -------------------------------------------------

	@Test
	void updateAndDeactivateBothStampUpdatedAtViaTheSamePatchPath() {
		int id = this.service.create(zToken(), entry("name", "시각", "kind", "press", "spoolDir", "sp-ts")).id();
		String created = (String) this.targets.findById(id).get().get("updatedAt");

		this.clock.advance(60_000);
		assertEquals(1, this.service.update(zToken(), id, entry("name", "새이름")).changes());
		String afterUpdate = (String) this.targets.findById(id).get().get("updatedAt");
		assertNotEquals(created, afterUpdate, "update가 updatedAt을 stamp한다");

		this.clock.advance(60_000);
		assertEquals(1, this.service.deactivate(zToken(), id).changes());
		Map<String, Object> afterDeactivate = this.targets.findById(id).get();
		assertNotEquals(afterUpdate, afterDeactivate.get("updatedAt"), "deactivate도 같은 applyPatch로 stamp한다");
		assertEquals("N", afterDeactivate.get("active"), "deactivate는 active='N'");
		assertTrue(this.targets.findById(id).isPresent(), "deactivate는 행을 지우지 않는다");
	}

	/**
	 * 시각은 <b>주입된 시계에서만</b> 온다 — 벽시계 직접 호출을 막는 정적 스캔({@code ClockDisciplineTest})의
	 * 행동 짝이다.
	 *
	 * <p>왜 필요한가(2026-08-24 테스터 게이트 변이 실측): {@code create}의 stamp를
	 * {@code Instant.now()}로 바꾼 변이에서 <b>이 서비스의 행동 테스트 10건이 전부 green</b>이었다
	 * (기존 테스트는 "값이 달라졌다"만 볼 뿐 그 값이 어디서 왔는지 묻지 않는다). 정적 스캔 하나가 유일한
	 * 방어선이면 스캔이 못 보는 형태(주입 시계를 무시하고 다른 시각 소스를 쓰는 헬퍼)에서 그대로 뚫린다.
	 *
	 * <p>{@code createdAt}이 갱신 경로에서 <b>불변</b>이라는 사실도 함께 잠근다(감사 기록의 기준선).
	 */
	@Test
	void createStampsBothTimesFromTheInjectedClockAndCreatedAtNeverMoves() {
		int id = this.service.create(zToken(), entry("name", "시계", "kind", "press", "spoolDir", "sp-clk")).id();

		Map<String, Object> created = this.targets.findById(id).get();
		assertEquals("2026-08-22T00:00:00.000Z", created.get("createdAt"),
				"주입 시계 값 그대로다(ISO-8601 UTC 밀리초 3자리 + Z)");
		assertEquals(created.get("createdAt"), created.get("updatedAt"), "생성 시점에는 두 시각이 같다");

		this.clock.advance(90_000);
		assertEquals(1, this.service.deactivate(zToken(), id).changes());

		Map<String, Object> patched = this.targets.findById(id).get();
		assertEquals("2026-08-22T00:00:00.000Z", patched.get("createdAt"), "createdAt은 갱신 경로에서 불변이다");
		assertEquals("2026-08-22T00:01:30.000Z", patched.get("updatedAt"), "updatedAt은 진행한 주입 시계 값이다");
	}

	@Test
	void deactivateAndPutActiveNConvergeToTheSameResult() {
		int viaDeactivate = this.service.create(zToken(), entry("name", "a", "kind", "press", "spoolDir", "sp-a")).id();
		int viaPut = this.service.create(zToken(), entry("name", "b", "kind", "press", "spoolDir", "sp-b")).id();

		assertEquals(1, this.service.deactivate(zToken(), viaDeactivate).changes());
		assertEquals(1, this.service.update(zToken(), viaPut, entry("active", "N")).changes());

		assertEquals("N", this.targets.findById(viaDeactivate).get().get("active"));
		assertEquals("N", this.targets.findById(viaPut).get().get("active"), "PUT {active:N}도 같은 전이다");
	}

	// --- 인가 게이트 -----------------------------------------------------------------------------

	@Test
	void nonAdminSessionsAreForbiddenOnAllFourOpsAndTouchNoRow() {
		int existing = this.service.create(zToken(), entry("name", "g", "kind", "press", "spoolDir", "sp-g")).id();
		for (String userId : List.of("dt-r", "dt-d")) {
			String token = this.guard.createSession(userId);
			assertEquals("forbidden", this.service.query(token, Map.of()).reason(), userId);
			assertEquals("forbidden",
					this.service.create(token, entry("name", "x", "kind", "press", "spoolDir", "sp-x")).reason());
			assertEquals("forbidden",
					this.service.update(token, existing, entry("name", "y")).reason());
			assertEquals("forbidden", this.service.deactivate(token, existing).reason());
		}
		// 거부는 아무것도 바꾸지 않았다.
		Map<String, Object> row = this.targets.findById(existing).get();
		assertEquals("g", row.get("name"));
		assertEquals("Y", row.get("active"));
		assertEquals(0, this.targets.query(Map.of("spoolDir", "sp-x")).size());
	}

	@Test
	void missingOrUnknownTokensAreUnauthenticated() {
		String dead = "0".repeat(64);
		for (String token : new String[] {null, dead}) {
			assertEquals("unauthenticated", this.service.query(token, Map.of()).reason());
			assertEquals("unauthenticated",
					this.service.create(token, entry("name", "x", "kind", "press", "spoolDir", "sp-u")).reason());
			assertEquals("unauthenticated", this.service.update(token, 1, entry("name", "x")).reason());
			assertEquals("unauthenticated", this.service.deactivate(token, 1).reason());
		}
	}

	// --- 투영 7키 · NULL 키 보존 -------------------------------------------------------------------

	@Test
	void projectionIsExactlyTheSevenSafeFieldsWithNullKeysPreserved() {
		// createdAt/updatedAt 없이 리포지토리에 직접 심어 NULL 키 보존을 본다.
		this.targets.insert(entry("name", "raw", "kind", "press", "spoolDir", "sp-raw"));

		Map<String, Object> item = this.service.query(zToken(), Map.of("spoolDir", "sp-raw")).items().get(0);
		assertEquals(
				List.of("id", "name", "kind", "spoolDir", "active", "createdAt", "updatedAt"),
				List.copyOf(item.keySet()), "정확 7키(Node 순서)");
		assertNull(item.get("createdAt"), "심지 않은 컬럼은 null이고 키는 남는다");
		assertNull(item.get("updatedAt"));
	}

	// --- 도우미 ---------------------------------------------------------------------------------

	private static Map<String, Object> entry(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}

	private void insertUser(String userId, String role) {
		Map<String, Object> row = new LinkedHashMap<>();
		row.put("userId", userId);
		row.put("name", userId);
		row.put("password", "$2a$10$hashhashhashhashhashha");
		row.put("role", role);
		row.put("active", "Y");
		new UserRepository(JdbcClient.create(this.dataSource)).insert(row);
	}
}
