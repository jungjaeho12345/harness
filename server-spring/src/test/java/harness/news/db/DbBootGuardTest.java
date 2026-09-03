package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import harness.news.NewsServerApplication;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * 기동 게이트: 쓸 수 없는 DB로는 뜨지 않는다.
 *
 * <p>{@code AppPropertiesGuardTest}(설정 누락)의 한 칸 아래 방어선이다 — 경로는 주어졌지만 그 경로의
 * DB가 없거나 이 서버가 요구하는 컬럼이 빠져 있으면, 첫 요청에서 500으로 터지는 대신 부팅에서 멈춘다.
 * 실패 메시지는 "무엇이 없는지"를 말해야 한다(운영자가 Node 서버로 스키마를 세워야 하기 때문이다).
 */
class DbBootGuardTest {

	@TempDir
	Path tempDir;

	@Test
	void startupFailsWhenDbFileIsMissing() {
		Exception thrown = assertThrows(Exception.class, () -> run(tempDir));

		String chain = messageChain(thrown);
		assertTrue(chain.contains(TempNewsDb.dbFile(tempDir).toAbsolutePath().toString()),
				"실패 메시지에 열려던 DB 경로가 있어야 한다: " + chain);
	}

	@Test
	void startupFailsWhenRequiredColumnsAreMissing() {
		TempNewsDb.seed(tempDir, TempNewsDb.DRIFT_FIXTURE);

		Exception thrown = assertThrows(Exception.class, () -> run(tempDir));

		String chain = messageChain(thrown);
		assertTrue(chain.contains("lockedUntil"), "실패 메시지에 빠진 컬럼이 있어야 한다: " + chain);
	}

	@Test
	void startupSucceedsWithNodeShapedSchema() {
		TempNewsDb.seed(tempDir);

		// 하네스가 Node createSchema로 시드한 DATA_DIR과 같은 모양이다 — 여기서 실패하면 계약 실행도 실패한다.
		run(tempDir);
	}

	/**
	 * <b>변이 M1</b>(phase 75 step5): mysql을 골랐는데 접속 정보가 없으면 <b>뜨지 않는다</b>.
	 *
	 * <p>여기서 조용히 sqlite로 폴백하면 최악의 형태가 된다 — 운영자는 MySQL로 옮겼다고 믿는데 서버는
	 * 옛 파일에 쓰고, 두 저장소의 내용이 갈린 뒤에야 드러난다. 시드된 DB가 있는 디렉토리로 돌리는 이유는
	 * "파일이 없어서" 실패한 것이 아님을 못 박기 위해서다.
	 */
	@Test
	void startupFailsWhenMysqlIsSelectedWithoutCredentials() {
		TempNewsDb.seed(tempDir);

		// 자격 3키를 커맨드라인으로 비운다: 이 테스트가 "셸에 NEWS_DB_* 가 실려 있는가"에 따라 갈리면 안 된다
		// (커맨드라인 인자는 최우선 순위라 application.properties의 ${NEWS_DB_URL:} 전개를 확실히 덮는다).
		Exception thrown = assertThrows(Exception.class, () -> run(tempDir, "--app.db.kind=mysql",
				"--app.db.url=", "--app.db.username=", "--app.db.password="));

		String chain = messageChain(thrown);
		assertTrue(chain.contains("NEWS_DB_URL"), "무엇이 없는지 지목해야 한다: " + chain);
		assertTrue(chain.contains("NEWS_DB_USERNAME"), chain);
		assertTrue(chain.contains("NEWS_DB_PASSWORD"), chain);
	}

	/**
	 * <b>변이 M2</b>(phase 75 step5): {@code kind}와 URL이 <b>모순</b>이면 기동을 거부한다.
	 *
	 * <p>URL을 보고 방언을 추론하지 않기 때문에({@code DbProperties}) 이 조합은 "어느 쪽이 진심인지"를
	 * 서버가 알 수 없는 상태다. 추론하는 서버는 {@code DB_KIND} 누락을 조용히 삼키고, 그 누락이야말로
	 * 이관 중에 가장 흔한 사고다(step7 M1a가 정확히 이 거부에 걸린다).
	 */
	@Test
	void startupFailsWhenTheKindContradictsTheUrl() {
		TempNewsDb.seed(tempDir);

		Exception thrown = assertThrows(Exception.class,
				() -> run(tempDir, "--app.db.kind=sqlite", "--app.db.url=jdbc:mysql://127.0.0.1:3306/news"));

		String chain = messageChain(thrown);
		assertTrue(chain.contains("DB_KIND"), "무엇을 맞춰야 하는지 지목해야 한다: " + chain);
		assertTrue(chain.contains("NEWS_DB_URL"), chain);
	}

	private static void run(Path dataDir, String... extraArgs) {
		SpringApplication application = new SpringApplication(NewsServerApplication.class);
		application.setLogStartupInfo(false);
		List<String> args = new ArrayList<>(List.of(
				"--app.data-dir=" + dataDir.toAbsolutePath(),
				"--spring.main.web-application-type=none"));
		args.addAll(List.of(extraArgs));
		try (ConfigurableApplicationContext context = application.run(args.toArray(String[]::new))) {
			if (context == null) {
				fail("컨텍스트가 null이다");
			}
		}
	}

	private static String messageChain(Throwable throwable) {
		StringBuilder sb = new StringBuilder();
		for (Throwable t = throwable; t != null; t = t.getCause()) {
			sb.append(t.getClass().getSimpleName()).append(": ").append(t.getMessage()).append('\n');
			if (t.getCause() == t) {
				break;
			}
		}
		return sb.toString();
	}
}
