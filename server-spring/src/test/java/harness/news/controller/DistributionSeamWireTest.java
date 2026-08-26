package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.config.SpoolProperties;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.DistributionTargetRepository;
import harness.news.service.ArticleEmbargoService;
import harness.news.service.DistributionService;
import harness.news.service.DistributionTickService;
import harness.news.service.GatedSpoolWriter;
import harness.news.service.SessionGuard;
import harness.news.service.SpoolWriter;
import harness.news.service.UserService;
import harness.news.testsupport.TempNewsDb;
import harness.news.testsupport.Wire;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.datasource.AbstractDataSource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 계약도 원장 시드도 도달하지 못하는 두 사유를 <b>seam</b>으로 도달시킨다.
 *
 * <ul>
 *   <li>{@code retry-in-flight}(409) — 같은 {@code (기사, 수신처)}로 두 요청이 <b>실제로 겹쳐야</b> 한다.
 *       {@link GatedSpoolWriter}가 게시 직전에 멈춰 그 창을 연다(지연은 테스트에만 둔다 — main에
 *       {@code Thread.sleep}을 넣으면 ADR-008 정적 게이트가 red다).</li>
 *   <li>{@code tick-failed}(500) — 후보 조회 자체가 실패한 경우다. 커넥션을 주지 않는 데이터소스로 만든
 *       기사 리포지토리를 tick에만 물려 재현한다(다른 라우트는 정상 리포지토리를 그대로 쓴다).</li>
 * </ul>
 *
 * <p>빈 교체는 이 컨텍스트에만 적용된다({@code spring.main.allow-bean-definition-overriding}) —
 * 프로덕션 배선은 {@code DistributionConfig}가 그대로 소유한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "spring.main.allow-bean-definition-overriding=true")
class DistributionSeamWireTest {

	private static final Path DATA_DIR = TempNewsDb.newDataDir("distribution-seam-wire");

	private static final Path SPOOL_ROOT = tempSpoolRoot();

	/** 게시 창을 여는 seam — 컨텍스트가 하나라 테스트 클래스가 소유한다. */
	private static final GatedSpoolWriter GATE = new GatedSpoolWriter();

	private static final String STAMP = "2026-01-01T00:00:00.000Z";

	private static final String PRESS = "press";

	@DynamicPropertySource
	static void environment(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
		registry.add("app.distribution.spool-dir", () -> SPOOL_ROOT.toAbsolutePath().toString());
	}

	@Value("${local.server.port}")
	private int port;

	@Autowired
	private UserService users;

	@Autowired
	private SessionGuard sessions;

	@Autowired
	private ArticleRepository articles;

	@Autowired
	private ArticleHistoryRepository history;

	@Autowired
	private DistributionTargetRepository targets;

	// --- 1. 겹친 재전송은 409 retry-in-flight다 -----------------------------------------------------

	@Test
	void aRetryThatOverlapsAnotherOneForTheSameTargetIs409() throws Exception {
		String articleId = seedArticle("DPS");
		long targetId = seedTarget(unique("t"), PRESS, unique("flight"), "Y");
		long failureId = seedFailure(articleId, PRESS, targetId);
		String token = zToken();
		GATE.arm();

		ExecutorService pool = Executors.newSingleThreadExecutor();
		try {
			Future<Wire.Response> first = pool.submit(() -> retry(token, failureId));
			assertTrue(GATE.awaitEntered(30), "쓰기 창이 열리지 않았다");

			Wire.Response second = retry(token, failureId);
			assertEquals(409, second.status(), "겹친 재전송은 409다: " + second.body());
			assertEquals("{\"ok\":false,\"reason\":\"retry-in-flight\"}", second.body());

			GATE.release();
			Wire.Response completed = first.get(30, TimeUnit.SECONDS);
			assertEquals(200, completed.status(), "멈췄던 재전송이 끝나지 않았다: " + completed.body());
		}
		finally {
			pool.shutdownNow();
		}
	}

	// --- 2. 후보 조회 실패는 500 tick-failed다 ------------------------------------------------------

	@Test
	void aTickWhoseCandidateScanFailsIs500TickFailed() {
		Wire.Response response = Wire.send(this.port, "POST", "/api/distribution/tick",
				Map.of("x-session-id", zToken()), null);

		assertEquals(500, response.status(), "후보 조회 실패는 서버측 장애다: " + response.body());
		assertEquals("{\"ok\":false,\"reason\":\"tick-failed\"}", response.body());
	}

	// --- seam 배선 ----------------------------------------------------------------------------------

	@TestConfiguration(proxyBeanMethods = false)
	static class Seams {

		/** 게시 직전에 멈출 수 있는 스풀 라이터로 갈아끼운다(무장 전에는 그대로 통과한다). */
		@Bean
		SpoolWriter spoolWriter(SpoolProperties properties, Clock clock) {
			return GatedSpoolWriter.writerFor(properties.rootPath().orElseThrow(), clock, GATE);
		}

		/** 후보 조회가 실패하는 tick — 커넥션을 주지 않는 데이터소스로 만든 기사 리포지토리를 쓴다. */
		@Bean
		DistributionTickService distributionTickService(ArticleHistoryRepository history,
				ObjectProvider<DistributionService> distribution, ObjectProvider<ArticleEmbargoService> embargo,
				Clock clock, TransactionTemplate transactions) {
			ArticleRepository unreadable = new ArticleRepository(JdbcClient.create(new DeadDataSource()),
					transactions, clock);
			return new DistributionTickService(unreadable, history, distribution.getIfAvailable(),
					embargo.getIfAvailable(), clock, null);
		}

	}

	/** 커넥션을 절대 주지 않는 데이터소스 — 조회가 예외로 끝나는 상황을 결정적으로 만든다. */
	private static final class DeadDataSource extends AbstractDataSource {

		@Override
		public Connection getConnection() throws SQLException {
			throw new SQLException("planted scan failure");
		}

		@Override
		public Connection getConnection(String username, String password) throws SQLException {
			throw new SQLException("planted scan failure");
		}

	}

	// --- 픽스처 -------------------------------------------------------------------------------------

	private static Map<String, Object> row(Object... pairs) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < pairs.length; i += 2) {
			map.put((String) pairs[i], pairs[i + 1]);
		}
		return map;
	}

	private String seedArticle(String status) {
		String articleId = "AKR2026" + Long.toHexString(System.nanoTime());
		this.articles.insert(row("articleId", articleId, "title", "제목", "markupVersion", "<p>본문(끝)</p>"),
				row("articleId", articleId, "title", "제목", "status", status, "createdAt", STAMP));
		return articleId;
	}

	private long seedTarget(String name, String kind, String spoolDir, String active) {
		return this.targets.insert(row("name", name, "kind", kind, "spoolDir", spoolDir, "active", active,
				"createdAt", STAMP, "updatedAt", STAMP));
	}

	private long seedFailure(String articleId, String kind, long targetId) {
		return this.history.insert(row("articleId", articleId, "eventType", "distribute-failed",
				"action", kind, "targetId", Long.valueOf(targetId), "reason", "spool-write-failed",
				"actorUserId", "ds-z", "createdAt", STAMP));
	}

	private Wire.Response retry(String token, long historyId) {
		return Wire.json(this.port, "POST", "/api/distribution/retry", Map.of("x-session-id", token),
				"{\"historyId\":" + historyId + "}");
	}

	private String zToken() {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", "ds-z");
		dto.put("name", "ds-z");
		dto.put("role", "Z");
		dto.put("password", "ds-wire-pw");
		try {
			this.users.create(dto);
		}
		catch (RuntimeException ignored) {
			// 이미 있다 — 픽스처는 멱등이다.
		}
		return this.sessions.createSession("ds-z");
	}

	private static String unique(String prefix) {
		return prefix + Long.toHexString(System.nanoTime());
	}

	private static Path tempSpoolRoot() {
		try {
			Path dir = Files.createTempDirectory("news-spring-distribution-seam-");
			dir.toFile().deleteOnExit();
			return dir;
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

}
