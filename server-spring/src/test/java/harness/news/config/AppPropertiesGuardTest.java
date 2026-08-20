package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import harness.news.NewsServerApplication;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * 설정 가드: app.data-dir 없이는 기동하지 않는다.
 *
 * <p>근거(DB 비파괴 1차 방어선) — 데이터 디렉토리를 cwd나 리포 경로로 추정하면 설정 누락이 조용히 리포
 * news.db를 여는 경로가 된다. "모르면 뜨지 않는다"가 규칙이고, 실패 메시지는 무슨 키가 없고 어떤
 * 환경변수로 주는지를 말해야 한다.
 */
class AppPropertiesGuardTest {

	@Test
	void startupFailsWhenDataDirMissing() {
		SpringApplication application = new SpringApplication(NewsServerApplication.class);
		application.setLogStartupInfo(false);

		Exception thrown = assertThrows(Exception.class, () -> {
			// 커맨드라인 인자는 최우선 순위다 — application.properties의 ${DATA_DIR:} 기본값을 확실히 덮어쓴다.
			try (ConfigurableApplicationContext context = application.run(
					"--app.data-dir=",
					"--spring.main.web-application-type=none")) {
				fail("app.data-dir 없이 기동에 성공했다 — 설정 가드가 없다");
			}
		});

		String chain = messageChain(thrown);
		assertTrue(chain.contains("app.data-dir"), "실패 메시지에 설정 키 이름이 있어야 한다: " + chain);
		assertTrue(chain.contains("DATA_DIR"), "실패 메시지에 주입용 환경변수 이름이 있어야 한다: " + chain);
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
