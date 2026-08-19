package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import harness.news.NewsServerApplication;
import harness.news.testsupport.TempNewsDb;
import java.nio.file.Path;
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

	private static void run(Path dataDir) {
		SpringApplication application = new SpringApplication(NewsServerApplication.class);
		application.setLogStartupInfo(false);
		try (ConfigurableApplicationContext context = application.run(
				"--app.data-dir=" + dataDir.toAbsolutePath(),
				"--spring.main.web-application-type=none")) {
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
