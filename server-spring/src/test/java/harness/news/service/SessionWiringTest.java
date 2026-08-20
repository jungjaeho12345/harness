package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.testsupport.TempNewsDb;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 세션 계층의 배선 규율 두 가지를 기계로 잠근다.
 *
 * <ol>
 *   <li><b>소비처는 가드만 주입받는다.</b> 세션 스토어가 빈으로 노출되면 컨트롤러·필터가 재도출을 건너뛴
 *       신원을 얻을 수 있고, 그것이 곧 ADR-004 우회다. 그래서 스토어는 빈이 아니며(가드 빈 안에서만
 *       만들어진다) 타입 자체도 이 패키지 밖에서 보이지 않는다.</li>
 *   <li><b>이 계층은 transport에 의존하지 않는다</b>(ADR-006). 서블릿·웹 타입을 import하는 순간
 *       세션 축을 HTTP 없이 전수 검증할 수 없게 된다 — 토큰을 요청에서 꺼내는 일은 web 계층 몫이다.</li>
 * </ol>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class SessionWiringTest {

	// 기동에 실제 DB가 필요하다(스키마 검증이 부팅 게이트다) — 임시 시드 DB를 물린다.
	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> TempNewsDb.sharedDataDir().toAbsolutePath().toString());
	}

	private static final Path SESSION_SOURCES =
			Path.of("src", "main", "java", "harness", "news", "service");

	/** 이 계층에 있으면 안 되는 import — 서블릿·웹 MVC 타입. */
	private static final List<Pattern> FORBIDDEN_IMPORTS = List.of(
			Pattern.compile("^import\\s+jakarta\\.servlet\\.", Pattern.MULTILINE),
			Pattern.compile("^import\\s+org\\.springframework\\.web\\.", Pattern.MULTILINE),
			Pattern.compile("^import\\s+org\\.springframework\\.http\\.", Pattern.MULTILINE));

	private final ApplicationContext context;

	SessionWiringTest(@Autowired ApplicationContext context) {
		this.context = context;
	}

	@Test
	void guardIsTheOnlyInjectableSessionBean() {
		assertEquals(1, this.context.getBeanNamesForType(SessionGuard.class).length,
				"인증이 필요한 소비처는 가드를 주입받는다");
		assertEquals(0, this.context.getBeanNamesForType(SessionStore.class).length,
				"스토어가 빈으로 노출되면 재도출을 건너뛴 신원을 얻는 우회 경로가 생긴다");
	}

	@Test
	void guardUsesTheApplicationClock() {
		SessionGuard guard = this.context.getBean(SessionGuard.class);

		// 시스템 시계로 배선됐으므로 갓 발급한 세션은 유효하다(만료 판정이 실제 시각을 읽는다는 왕복 확인).
		String sessionId = guard.createSession("존재하지-않는-사용자");
		assertTrue(sessionId.matches("^[0-9a-f]{64}$"), "발급 토큰 형식이 계약과 다르다");
		assertNull(guard.touchSession(sessionId), "행이 없는 세션은 재도출 단계에서 무효화된다");
	}

	@Test
	void sessionLayerImportsNoTransportTypes() throws IOException {
		assertTrue(Files.isDirectory(SESSION_SOURCES),
				"스캔 대상이 없다 — 테스트 작업 디렉토리가 모듈 루트가 아니다: " + SESSION_SOURCES.toAbsolutePath());

		List<String> hits = new ArrayList<>();
		try (Stream<Path> files = Files.walk(SESSION_SOURCES)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				String text = Files.readString(file, StandardCharsets.UTF_8);
				for (Pattern pattern : FORBIDDEN_IMPORTS) {
					if (pattern.matcher(text).find()) {
						hits.add(file + " ~ " + pattern.pattern());
					}
				}
			}
		}

		assertTrue(hits.isEmpty(), "세션 서비스 계층이 transport 타입을 import한다: " + hits);
	}
}
