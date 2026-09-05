package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 접속 자격은 <b>환경변수에서만</b> 온다 — 리터럴도 기본값도 argv 도 없다(decisions (7)).
 *
 * <p>조회 함수를 주입받도록 만든 덕분에 이 테스트는 실제 환경변수 없이 돈다. 반대로 MySQL 을 실제로
 * 만지는 테스트들은 <b>설정이 없으면 skip 이 아니라 fail</b> 한다(decisions (14)) — 조용한 skip 은 이
 * phase 의 게이트를 전부 공허하게 만든다.
 */
class TargetCredentialsTest {

	private static final Map<String, String> ENV = Map.of(
			"NEWS_MIGRATOR_URL", "jdbc:mysql://127.0.0.1:3306/news_stage?useSSL=false",
			"NEWS_MIGRATOR_USERNAME", "news_migrator",
			"NEWS_MIGRATOR_PASSWORD", "s3cret-from-env-only");

	@Test
	void theKeySetNameDerivesTheThreeKeys() {
		assertEquals(List.of("NEWS_MIGRATOR_URL", "NEWS_MIGRATOR_USERNAME", "NEWS_MIGRATOR_PASSWORD"),
				TargetCredentials.keysOf("NEWS_MIGRATOR"), "키 이름 규약이 런북(docs/ops-mysql.md §3)과 다르다");
		assertEquals(List.of("NEWS_CT_MYSQL_URL", "NEWS_CT_MYSQL_USERNAME", "NEWS_CT_MYSQL_PASSWORD"),
				TargetCredentials.keysOf("NEWS_CT_MYSQL"), "계약 하네스 키 집합");
	}

	@Test
	void aMissingKeyIsNamedNotGuessed() {
		IllegalStateException failure = assertThrows(IllegalStateException.class,
				() -> TargetCredentials.of("NEWS_MIGRATOR", Map.of("NEWS_MIGRATOR_URL", "jdbc:mysql://x")::get));

		assertTrue(failure.getMessage().contains("NEWS_MIGRATOR_USERNAME")
				&& failure.getMessage().contains("NEWS_MIGRATOR_PASSWORD"),
				"무엇이 없는지 지목하지 않는다: " + failure.getMessage());
		assertTrue(failure.getMessage().contains("ops-mysql.md"), "어디를 보라고 알려주지 않는다");
	}

	@Test
	void aBlankValueCountsAsMissing() {
		assertThrows(IllegalStateException.class, () -> TargetCredentials.of("NEWS_MIGRATOR",
				Map.of("NEWS_MIGRATOR_URL", "jdbc:mysql://x", "NEWS_MIGRATOR_USERNAME", "u",
						"NEWS_MIGRATOR_PASSWORD", "  ")::get),
				"빈 문자열 비밀번호로 접속을 시도한다");
	}

	@Test
	void theKeySetNameMustBeAKeySetNameNotAUrlOrAValue() {
		for (String bad : List.of("jdbc:mysql://127.0.0.1:3306/news", "news_migrator", "NEWS MIGRATOR", "", "1NEWS")) {
			assertThrows(IllegalArgumentException.class, () -> TargetCredentials.of(bad, ENV::get),
					"키 집합 이름 규약을 강제하지 않는다: " + bad);
		}
	}

	/** 비밀은 로그·리포트·예외 메시지 어디에도 실리지 않는다 — {@code toString} 이 첫 유출 경로다. */
	@Test
	void theSecretNeverAppearsInToStringOrInAnyDiagnosticText() {
		TargetCredentials credentials = TargetCredentials.of("NEWS_MIGRATOR", ENV::get);

		assertEquals("s3cret-from-env-only", credentials.password(), "값을 못 읽는다");
		assertFalse(credentials.toString().contains("s3cret-from-env-only"),
				"toString 이 비밀번호를 그대로 싣는다: " + credentials.toString());
		assertTrue(credentials.toString().contains("NEWS_MIGRATOR"), "무엇으로 접속하는지도 알 수 없다");
		assertFalse(credentials.describe().contains("s3cret-from-env-only"), "진단 문자열이 비밀번호를 싣는다");
	}

	/** 임시 DB 를 가리키도록 URL 의 경로만 바꾼다(질의 문자열은 보존) — 자격은 그대로 흐른다. */
	@Test
	void theUrlCanBeRepointedAtADatabaseWithoutTouchingTheQueryString() {
		TargetCredentials root = TargetCredentials.of("NEWS_CT_MYSQL",
				Map.of("NEWS_CT_MYSQL_URL", "jdbc:mysql://127.0.0.1:3306/?useSSL=false&characterEncoding=UTF-8",
						"NEWS_CT_MYSQL_USERNAME", "news_ct", "NEWS_CT_MYSQL_PASSWORD", "x")::get);

		assertEquals("jdbc:mysql://127.0.0.1:3306/harness_ct_0123456789abcdef?useSSL=false&characterEncoding=UTF-8",
				root.forDatabase("harness_ct_0123456789abcdef").url(), "임시 DB 를 가리키는 URL 조립이 틀렸다");
		assertEquals("news_ct", root.forDatabase("harness_ct_0123456789abcdef").username(), "자격이 바뀌었다");
	}

	@Test
	void aUrlWithoutASchemeIsRejectedRatherThanSilentlyRewritten() {
		TargetCredentials broken = TargetCredentials.of("NEWS_CT_MYSQL",
				Map.of("NEWS_CT_MYSQL_URL", "127.0.0.1:3306", "NEWS_CT_MYSQL_USERNAME", "u",
						"NEWS_CT_MYSQL_PASSWORD", "x")::get);

		assertThrows(IllegalArgumentException.class, () -> broken.forDatabase("harness_ct_0123456789abcdef"),
				"형태를 모르는 URL 을 조용히 고쳐 엉뚱한 DB 를 가리킨다");
	}

}
