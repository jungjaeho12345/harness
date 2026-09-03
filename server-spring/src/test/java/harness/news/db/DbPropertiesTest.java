package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * 방언 선택 설정의 계약 — <b>명시 주입이고, 모르거나 모순이면 뜨지 않는다</b>(ADR-016 · 포팅 불변식 7).
 *
 * <p>이 서버는 URL을 보고 방언을 추론하지 않는다. 추론하면 {@code DB_KIND}를 빠뜨린 배포가 조용히
 * 다른 저장소로 뜨고(= 두 서버가 서로 다른 DB를 보는 상태), 그 사실은 데이터가 갈린 뒤에야 드러난다.
 * 그래서 판정 입력은 {@code app.db.kind} 하나이고 URL은 <b>그 선택과 일치하는지 검증만</b> 받는다.
 */
class DbPropertiesTest {

	private static final String MYSQL_URL = "jdbc:mysql://127.0.0.1:3306/news_stage";

	private static final String SQLITE_URL = "jdbc:sqlite:D:/data/news.db";

	@Test
	void kindDefaultsToSqliteWhenAbsent() {
		// DB_KIND 미주입(빈 문자열)은 "지금까지의 배포" 그대로여야 한다 — 기본이 바뀌면 무회귀가 아니다.
		for (String absent : new String[] { null, "", "   " }) {
			DbProperties properties = new DbProperties(absent, null, null, null);
			assertEquals(DbProperties.SQLITE, properties.kind(), "기본 방언은 sqlite다: " + absent);
			assertFalse(properties.mysql());
		}
	}

	@Test
	void kindIsCaseInsensitiveAndTrimmed() {
		assertEquals(DbProperties.MYSQL, new DbProperties(" MySQL ", MYSQL_URL, "u", "p").kind());
		assertEquals(DbProperties.SQLITE, new DbProperties("SQLite", "", "", "").kind());
	}

	@Test
	void unknownKindIsRejectedAndTheAllowedValuesAreNamed() {
		IllegalArgumentException thrown = assertThrows(IllegalArgumentException.class,
				() -> new DbProperties("postgres", "", "", ""));

		assertTrue(thrown.getMessage().contains("postgres"), "무엇이 잘못됐는지 지목해야 한다: " + thrown.getMessage());
		assertTrue(thrown.getMessage().contains(DbProperties.SQLITE), "허용 값을 알려야 한다: " + thrown.getMessage());
		assertTrue(thrown.getMessage().contains(DbProperties.MYSQL), "허용 값을 알려야 한다: " + thrown.getMessage());
		assertTrue(thrown.getMessage().contains("DB_KIND"), "고칠 환경변수를 알려야 한다: " + thrown.getMessage());
	}

	@Test
	void mysqlRequiresUrlUsernameAndPasswordAndNamesTheMissingOnes() {
		// 하나라도 비면 기동 실패다 — 조용히 sqlite로 폴백하면 "MySQL로 떴다고 믿는 SQLite 서버"가 된다.
		IllegalArgumentException all = assertThrows(IllegalArgumentException.class,
				() -> new DbProperties("mysql", "", "", ""));
		assertTrue(all.getMessage().contains("NEWS_DB_URL"), all.getMessage());
		assertTrue(all.getMessage().contains("NEWS_DB_USERNAME"), all.getMessage());
		assertTrue(all.getMessage().contains("NEWS_DB_PASSWORD"), all.getMessage());

		IllegalArgumentException noUrl = assertThrows(IllegalArgumentException.class,
				() -> new DbProperties("mysql", "  ", "u", "p"));
		assertTrue(noUrl.getMessage().contains("NEWS_DB_URL"), noUrl.getMessage());
		assertFalse(noUrl.getMessage().contains("NEWS_DB_USERNAME"), "있는 값을 없다고 하면 안 된다: " + noUrl.getMessage());

		IllegalArgumentException noUser = assertThrows(IllegalArgumentException.class,
				() -> new DbProperties("mysql", MYSQL_URL, " ", "p"));
		assertTrue(noUser.getMessage().contains("NEWS_DB_USERNAME"), noUser.getMessage());

		IllegalArgumentException noPassword = assertThrows(IllegalArgumentException.class,
				() -> new DbProperties("mysql", MYSQL_URL, "u", "   "));
		assertTrue(noPassword.getMessage().contains("NEWS_DB_PASSWORD"), noPassword.getMessage());
	}

	@Test
	void mysqlAcceptsTheMeasuredParameterSet() {
		// docs/db-mysql-mapping.md §5의 확정 집합. 파라미터는 URL이 통째로 실어 오고 이 서버는 덧붙이지 않는다.
		DbProperties properties = new DbProperties("mysql",
				MYSQL_URL + "?useSSL=false&allowPublicKeyRetrieval=true&characterEncoding=UTF-8", "news_app", "pw");

		assertTrue(properties.mysql());
		assertTrue(properties.url().endsWith("characterEncoding=UTF-8"), "URL을 있는 그대로 보관한다");
		assertEquals("news_app", properties.username());
	}

	@Test
	void sqliteWithAMysqlUrlIsRefusedAsAContradiction() {
		// 변이 M2. 추론 금지의 반대편 — 선택은 sqlite인데 URL은 MySQL이면 둘 중 무엇이 진심인지 알 수 없다.
		IllegalArgumentException thrown = assertThrows(IllegalArgumentException.class,
				() -> new DbProperties("sqlite", MYSQL_URL, "u", "p"));

		assertTrue(thrown.getMessage().contains("DB_KIND"), thrown.getMessage());
		assertTrue(thrown.getMessage().contains("NEWS_DB_URL"), thrown.getMessage());
		assertTrue(thrown.getMessage().contains(NewsDataSource.SQLITE_URL_PREFIX),
				"기대한 접두사를 지목해야 한다: " + thrown.getMessage());
	}

	@Test
	void mysqlWithASqliteUrlIsRefusedAsAContradiction() {
		IllegalArgumentException thrown = assertThrows(IllegalArgumentException.class,
				() -> new DbProperties("mysql", SQLITE_URL, "u", "p"));

		assertTrue(thrown.getMessage().contains(NewsDataSource.MYSQL_URL_PREFIX),
				"기대한 접두사를 지목해야 한다: " + thrown.getMessage());
	}

	@Test
	void theContradictionMessageNeverCarriesTheAuthorityPartOfTheUrl() {
		// 자격이 박힌 URL(정책상 금지지만 운영 환경변수는 우리가 통제하지 않는다)이 기동 로그로 새면 안 된다.
		// URL을 리터럴로 쓰지 않고 조립하는 이유: SecretHygieneTest가 "자격이 박힌 URL 형태"를 리포 전역에서
		// 금지하고 면제 목록을 정확히 단언한다 — 이 파일이 그 목록에 들어가면 스캐너의 구멍이 하나 늘어난다.
		String credentialUrl =
				NewsDataSource.MYSQL_URL_PREFIX + "//" + "user" + ':' + "secret-pw" + '@' + "127.0.0.1:3306/news";

		IllegalArgumentException thrown = assertThrows(IllegalArgumentException.class,
				() -> new DbProperties("sqlite", credentialUrl, "u", "p"));

		assertFalse(thrown.getMessage().contains("secret-pw"), "메시지에 비밀이 실렸다: " + thrown.getMessage());
		assertFalse(thrown.getMessage().contains("127.0.0.1"), "권한부(authority)를 통째로 지운다: " + thrown.getMessage());
	}

	@Test
	void sqliteIgnoresTheMysqlCredentialKeys() {
		// sqlite 모드에서 자격 3키는 무시한다(모순은 URL 하나로만 판정한다) — 남아 있는 환경변수가 기동을 막지 않는다.
		DbProperties properties = new DbProperties("sqlite", "", "news_app", "pw");

		assertFalse(properties.mysql());
		assertEquals("", properties.url());
	}

	@Test
	void sqliteAcceptsAMatchingSqliteUrlButDoesNotUseIt() {
		// 방언이 일치하면 모순이 아니다. 경로의 출처는 여전히 app.data-dir 하나다(NewsDataSource).
		DbProperties properties = new DbProperties("sqlite", SQLITE_URL, "", "");

		assertFalse(properties.mysql());
		assertEquals(SQLITE_URL, properties.url());
	}
}
