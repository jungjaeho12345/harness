package harness.news.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * User 리포지토리 — 리포 루트 `src/models/userModel.js`와 1:1 대응하는 4연산의 동작 계약.
 *
 * <p>가장 중요한 축은 <b>화이트리스트 밖 키를 조용히 무시한다</b>는 것이다. Node 모델이 그렇게 동작하고
 * (거부가 아니라 무시), 그 위에 얹힌 REST 계약이 그 결과를 동결하고 있다 —
 * {@code POST /api/users {nickname:'x'}}가 200, {@code PUT}에 미지의 키만 오면 200 {changes:0}이다.
 * 여기서 예외를 던지면 전역 핸들러가 500으로 바꿔 패리티가 깨진다.
 *
 * <p>임시 파일 DB(@TempDir)만 쓴다 — 리포 {@code news.db}는 열지 않는다.
 */
class UserRepositoryTest {

	@TempDir
	Path tempDir;

	private HikariDataSource dataSource;

	private UserRepository users;

	@BeforeEach
	void setUp() {
		TempNewsDb.seed(tempDir);
		dataSource = NewsDataSource.create(tempDir);
		users = new UserRepository(JdbcClient.create(dataSource));
		users.insert(row(
				"userId", "reporter", "name", "김기자", "password", "HASH-R",
				"role", "R", "department", "사회부", "departmentCode", "SOC"));
	}

	@AfterEach
	void tearDown() {
		if (dataSource != null) {
			dataSource.close();
		}
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}

	// --- findById -----------------------------------------------------------------------------

	@Test
	void insertThenFindByIdRoundTripsEveryColumn() {
		UserRow user = users.findById("reporter");

		assertNotNull(user);
		assertEquals("reporter", user.userId());
		assertEquals("김기자", user.name());
		assertEquals("HASH-R", user.password());
		assertEquals("R", user.role());
		assertEquals("사회부", user.department());
		assertEquals("SOC", user.departmentCode());
		assertEquals("Y", user.active(), "미지정 컬럼은 DB DEFAULT를 따른다");
		assertEquals("0", user.failedLoginCount(), "미지정 컬럼은 DB DEFAULT를 따른다");
		assertNull(user.lockedUntil());
		assertNull(user.lastFailedLoginAt());
	}

	@Test
	void findByIdReturnsNullWhenAbsent() {
		assertNull(users.findById("nobody"));
		assertNull(users.findById(null));
	}

	// --- insert -------------------------------------------------------------------------------

	@Test
	void insertIgnoresColumnsOutsideTheWhitelist() {
		// Node 동형: 화이트리스트 밖 키는 거부가 아니라 무시다(POST /api/users {nickname:'x'}가 200이다).
		String userId = users.insert(row(
				"userId", "u1", "name", "새사용자", "role", "D",
				"nickname", "무시되어야 한다",
				"userId2, name) VALUES ('x','y'); --", "주입 시도"));

		assertEquals("u1", userId);
		UserRow user = users.findById("u1");
		assertEquals("D", user.role());
		assertEquals("새사용자", user.name());
		assertNull(users.findById("x"), "주입 문자열이 SQL로 실행되면 안 된다");
	}

	@Test
	void insertRejectsWhenNoWhitelistedColumnRemains() {
		// Node 동형: 컬럼이 하나도 없으면 예외다(빈 INSERT를 만들지 않는다).
		assertThrows(IllegalArgumentException.class, () -> users.insert(row("nickname", "x")));
		assertThrows(IllegalArgumentException.class, () -> users.insert(row()));
	}

	@Test
	void insertWritesExplicitNullWhenValueIsNull() {
		users.insert(row("userId", "u2", "name", null, "role", "D"));

		UserRow user = users.findById("u2");
		assertNull(user.name(), "명시된 null은 SQL NULL로 들어간다(키 부재와 다르다)");
		assertEquals("D", user.role());
	}

	// --- update -------------------------------------------------------------------------------

	@Test
	void updateAppliesOnlyGivenColumnsAndReturnsChanges() {
		int changes = users.update("reporter", row("name", "새이름", "department", "정치부"));

		assertEquals(1, changes);
		UserRow user = users.findById("reporter");
		assertEquals("새이름", user.name());
		assertEquals("정치부", user.department());
		assertEquals("R", user.role(), "지정하지 않은 컬럼은 그대로다");
		assertEquals("SOC", user.departmentCode(), "지정하지 않은 컬럼은 그대로다");
		assertEquals("HASH-R", user.password(), "지정하지 않은 컬럼은 그대로다");
	}

	@Test
	void updateOfUnknownUserIdReturnsZeroChanges() {
		assertEquals(0, users.update("ghost", row("name", "x")));
		assertEquals(0, users.update(null, row("name", "x")));
	}

	@Test
	void updateIgnoresColumnsOutsideTheWhitelistAndRunsNoSqlWhenNoneRemain() {
		// Node 동형: PUT /api/users/:id {userId:'x'} 는 200 {changes:0}이다(에러가 아니다).
		assertEquals(0, users.update("reporter", row("userId", "다른아이디")),
				"userId는 SET 대상이 아니다");
		assertEquals(0, users.update("reporter", row("nickname", "x")));
		assertEquals(0, users.update("reporter", row("name = 'pwned' , role", "주입 시도")));
		assertEquals(0, users.update("reporter", row()));

		UserRow user = users.findById("reporter");
		assertEquals("reporter", user.userId(), "PK는 바뀌지 않는다");
		assertEquals("김기자", user.name(), "무시된 키는 어떤 컬럼도 건드리지 않는다");
		assertEquals("R", user.role());
	}

	@Test
	void updateMixesWhitelistedKeysAndIgnoresTheRest() {
		int changes = users.update("reporter", row("nickname", "무시", "role", "D", "userId", "무시"));

		assertEquals(1, changes);
		UserRow user = users.findById("reporter");
		assertEquals("D", user.role());
		assertEquals("reporter", user.userId());
	}

	@Test
	void deactivationKeepsTheRow() {
		// 삭제 연산은 존재하지 않는다 — 비활성화는 active='N' 업데이트다(DB 비파괴).
		assertEquals(1, users.update("reporter", row("active", "N")));

		UserRow user = users.findById("reporter");
		assertNotNull(user, "행은 남는다");
		assertEquals("N", user.active());
	}

	// --- 잠금 컬럼 표현(decisions (11)) ---------------------------------------------------------

	@Test
	void lockColumnsRoundTripStringIntegersEpochMillisAndNullReset() {
		// failedLoginCount는 문자열 정수, lockedUntil/lastFailedLoginAt은 epoch ms 문자열이다
		// (src/db/schema.js 주석의 'ISO-8601'은 드리프트이며 src/services/userService.js가 정본이다).
		users.update("reporter", row(
				"failedLoginCount", "5",
				"lockedUntil", "1787126400000",
				"lastFailedLoginAt", "1787125500000"));

		UserRow locked = users.findById("reporter");
		assertEquals("5", locked.failedLoginCount());
		assertEquals("1787126400000", locked.lockedUntil());
		assertEquals("1787125500000", locked.lastFailedLoginAt());

		// 성공 시 리셋 — 카운트는 '0', 나머지는 SQL NULL(행 삭제 없음).
		users.update("reporter", row(
				"failedLoginCount", "0", "lockedUntil", null, "lastFailedLoginAt", null));

		UserRow reset = users.findById("reporter");
		assertEquals("0", reset.failedLoginCount());
		assertNull(reset.lockedUntil());
		assertNull(reset.lastFailedLoginAt());
	}

	// --- query --------------------------------------------------------------------------------

	@Test
	void queryFiltersByWhitelistedColumnsWithAnd() {
		users.insert(row("userId", "editor", "name", "이데스크", "role", "D", "department", "사회부"));

		List<UserRow> socialReporters = users.query(row("role", "R", "department", "사회부"));
		assertEquals(1, socialReporters.size());
		assertEquals("reporter", socialReporters.get(0).userId());

		assertEquals(2, users.query(row()).size(), "필터가 없으면 전건이다");
		assertEquals(0, users.query(row("role", "Z")).size());
	}

	@Test
	void queryIgnoresUnknownKeysAndNullValues() {
		users.insert(row("userId", "editor", "name", "이데스크", "role", "D"));

		// 미지의 키는 무시(거부가 아니다) — 필터가 아예 적용되지 않은 것과 같은 결과여야 한다.
		assertEquals(2, users.query(row("nickname", "x")).size());
		assertEquals(2, users.query(row("role = 'R' OR '1'='1", "주입 시도")).size());
		// null 값은 "필터 없음"이다(Node는 undefined와 null을 똑같이 건너뛴다).
		assertEquals(2, users.query(row("role", null)).size());

		List<UserRow> reporters = users.query(row("role", "R", "nickname", "x"));
		assertEquals(1, reporters.size());
		assertEquals("reporter", reporters.get(0).userId());
	}

	@Test
	void queryReturnsRawRowsIncludingPasswordForDomainLogic() {
		// 투영(비밀번호·잠금 필드 제거)은 서비스 계층 책임이다 — 리포지토리는 raw를 준다.
		UserRow user = users.query(row("userId", "reporter")).get(0);
		assertEquals("HASH-R", user.password());
		assertTrue(user.toString().contains("reporter"));
	}
}
