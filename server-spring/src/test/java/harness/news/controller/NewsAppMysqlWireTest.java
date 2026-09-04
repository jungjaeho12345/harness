package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.db.DbProperties;
import harness.news.service.UserService;
import harness.news.testsupport.NewsAppMysql;
import harness.news.testsupport.Wire;
import harness.news.testsupport.WireStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>MySQL 위에서 서버가 실제로 돈다</b>는 유일한 전 경로 실증(phase 75 step6 A).
 *
 * <h2>왜 {@code news_app} 자격이어야 하는가</h2>
 * 이 리포의 다른 MySQL 테스트는 전부 {@code news_ct}({@code ALL PRIVILEGES})로 돈다. 그런데 <b>운영은
 * {@code news_app}으로 뜬다</b> — {@code SELECT/INSERT/UPDATE} + {@code ReceiverConfig} 테이블 단위
 * {@code DELETE} 하나뿐이다. 그 조합이 어느 게이트에서도 시험되지 않으면 "권한 부족이 500으로 새는" 상태를
 * 아무도 못 본다. 그래서 이 클래스만은 서버 런타임 자격으로 붙는다.
 *
 * <h2>왜 {@code news_stage}여야 하는가</h2>
 * {@code news_app}은 {@code harness_ct_*}에 <b>권한이 0</b>이다 — 임시 DB로 돌리면 전 쿼리가 거부되어
 * 스모크 자체가 성립하지 않는다. 스키마·데이터는 {@code news_migrator}가 step3에서 세운 그대로이고
 * 여기서는 <b>접속 자격만</b> 바꾼다.
 *
 * <h2>이 경로는 행을 추가한다(지우지 않는다)</h2>
 * 실행마다 계정 2·기사 1(Article+Contents+ArticleHistory)·사진 1·수집 설정 1이 {@code news_stage}에
 * 쌓인다. step3·step4의 <b>최종 대조 측정은 이미 끝났으므로</b>(각 step summary의 실기 리허설) 이 스모크는
 * 그 뒤에 도는 것이 맞고, 그 대조를 다시 돌리려면 {@code news_stage}를 비우고 재적재해야 한다
 * (이 자격에는 그럴 권한이 없다 — 사람의 일이다. docs/ops-mysql.md).
 *
 * <p>계정 이름·비밀번호는 실행마다 새로 만든다(고정 계정을 스테이징에 심어 두지 않는다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class NewsAppMysqlWireTest {

	private static final Path DATA_DIR = uploadsRoot();

	private static final Pattern SESSION_ID = Pattern.compile("\"sessionId\":\"([0-9a-f]{64})\"");

	private static final Pattern CREATED = Pattern.compile("\"articleId\":\"(AKR\\d{17})\"");

	private static final Pattern PHOTO_ID = Pattern.compile("\"id\":(\\d+)");

	private static final String JSON_CONTENT_TYPE = "Content-Type: application/json; charset=utf-8";

	/** 실행마다 새 값 — 스테이징에 고정 계정을 남기지 않는다. */
	private static final String RUN = Long.toHexString(System.nanoTime());

	private static final String PASSWORD = "news-app-smoke-" + RUN;

	@DynamicPropertySource
	static void mysqlTarget(DynamicPropertyRegistry registry) {
		DbProperties db = NewsAppMysql.forDatabase(NewsAppMysql.STAGING_DATABASE);
		registry.add("app.data-dir", () -> DATA_DIR.toAbsolutePath().toString());
		registry.add("app.db.kind", db::kind);
		registry.add("app.db.url", db::url);
		registry.add("app.db.username", db::username);
		registry.add("app.db.password", db::password);
	}

	@Value("${local.server.port}")
	private int port;

	/** 픽스처 계정 생성 전용 — 관측 대상은 HTTP 경로다. */
	@Autowired
	private UserService users;

	/**
	 * 로그인 → 목록 → 생성 → 잠금 → 상태 전이 → 사진 등록·검색 → 수집설정 생성·삭제 → 로그 다이제스트.
	 *
	 * <p>한 테스트로 묶은 이유는 이 경로가 <b>한 번의 실기 리허설</b>이기 때문이다 — 쪼개면 스테이징에
	 * 쌓이는 행만 늘고 관측은 같다.
	 */
	@Test
	void theWholeRouteChainRunsOnMysqlWithTheServerRuntimeCredential() throws SQLException {
		String reporterId = "smoke-d-" + RUN;
		String adminId = "smoke-z-" + RUN;
		createUser(reporterId, "D", "스모크데스크");
		createUser(adminId, "Z", "스모크관리자");

		// 1) 로그인 — User SELECT + 실패 카운터/최종 로그인 UPDATE
		String desk = login(reporterId);
		String admin = login(adminId);

		// 2) 목록 — Contents SELECT (ORDER BY createdAt DESC · 이관된 77행 위에서 돈다)
		Wire.Response list = Wire.send(this.port, "GET", "/api/articles",
				Map.of("x-session-id", desk), null);
		assertEquals(200, list.status(), "목록: " + list.body());
		assertEquals(JSON_CONTENT_TYPE, list.line("content-type"));

		// 3) 생성 — Article + Contents INSERT(한 트랜잭션) + ArticleHistory INSERT
		Wire.Response created = Wire.json(this.port, "POST", "/api/articles",
				Map.of("x-session-id", desk),
				"{\"title\":\"MySQL 스모크 " + RUN + "\",\"markupVersion\":\"<p>본문 가나다</p>\"}");
		assertEquals(200, created.status(), "생성: " + created.body());
		String articleId = group(CREATED, created.body(), "생성 응답에 articleId가 없다");

		// 4) 단건 조회 — 두 테이블 SELECT
		Wire.Response read = Wire.send(this.port, "GET", "/api/articles/" + articleId,
				Map.of("x-session-id", desk), null);
		assertEquals(200, read.status(), "조회: " + read.body());
		assertTrue(read.body().contains("가나다"), "한글 본문이 왕복에서 깨지지 않았다");

		// 5) 잠금 — Contents UPDATE(5컬럼)
		Wire.Response locked = Wire.json(this.port, "POST", "/api/articles/" + articleId + "/lock",
				Map.of("x-session-id", desk, "x-edit-client", "smoke-tab"), "{}");
		assertEquals(200, locked.status(), "잠금: " + locked.body());

		// 6) 상태 전이 — Contents UPDATE + ArticleHistory INSERT
		Wire.Response held = Wire.json(this.port, "POST", "/api/articles/" + articleId + "/action",
				Map.of("x-session-id", desk, "x-edit-client", "smoke-tab"), "{\"action\":\"hold\"}");
		assertEquals(200, held.status(), "상태 전이: " + held.body());

		// 7) 이력 조회 — length() 술어 + id DESC
		Wire.Response history = Wire.send(this.port, "GET", "/api/articles/" + articleId + "/history",
				Map.of("x-session-id", desk), null);
		assertEquals(200, history.status(), "이력: " + history.body());

		// 8) 사진 등록·검색 — Photo INSERT + caption LIKE + id DESC
		String caption = "스모크 사진 " + RUN;
		Wire.Response photo = Wire.json(this.port, "POST", "/api/photos", Map.of("x-session-id", desk),
				"{\"src\":\"https://example.test/smoke.png\",\"caption\":\"" + caption + "\"}");
		assertEquals(200, photo.status(), "사진 등록: " + photo.body());
		String photoId = group(PHOTO_ID, photo.body(), "사진 등록 응답에 id가 없다");
		Wire.Response found = Wire.send(this.port, "GET", "/api/photos/search?q=" + RUN,
				Map.of("x-session-id", desk), null);
		assertEquals(200, found.status(), "사진 검색: " + found.body());
		assertTrue(found.body().contains("\"id\":" + photoId), "방금 등록한 사진이 검색된다: " + found.body());

		// 9) 수집 설정 생성 — ReceiverConfig INSERT(Z 전용)
		Wire.Response config = Wire.json(this.port, "POST", "/api/receiver-config",
				Map.of("x-session-id", admin),
				"{\"sourceId\":\"smoke-" + RUN + "\",\"type\":\"FTP\",\"name\":\"스모크 수신\"}");
		assertEquals(200, config.status(), "수집 설정 생성: " + config.body());
		String configId = group(PHOTO_ID, config.body(), "수집 설정 응답에 id가 없다");

		// 10) 수집 설정 삭제 — 이 서버 유일의 행 삭제. grant 상태에 따라 갈린다.
		Wire.Response removed = Wire.send(this.port, "DELETE", "/api/receiver-config/" + configId,
				Map.of("x-session-id", admin), null);
		assertDeleteOutcome(removed);

		// 11) 로그 다이제스트 — DB를 만지지 않는 경로(대비군)
		Wire.Response digest = Wire.send(this.port, "GET", "/api/logs/digest",
				Map.of("x-session-id", admin), null);
		assertEquals(200, digest.status(), "로그 다이제스트: " + digest.body());
	}

	/**
	 * 열린 SSE 스트림이 <b>무관한 요청을 막지 않는다</b> — 풀 상한 1에서 락 순서가 뒤집히면 여기서 멈춘다
	 * ({@code LogsStreamWireTest} 항목 22가 SQLite에서 세운 방어선의 MySQL 판본 · step6 B-6).
	 */
	@Test
	void anOpenStreamDoesNotBlockUnrelatedRequestsOnMysql() {
		String watcherId = "smoke-w-" + RUN;
		createUser(watcherId, "Z", "스모크구독자");
		String session = login(watcherId);

		try (WireStream stream = WireStream.open(this.port, "/api/stream",
				Map.of("x-session-id", session))) {
			assertEquals(200, stream.status(), "스트림이 열려야 한다");
			stream.awaitFrame((frame) -> "ready".equals(frame.event()), Duration.ofSeconds(5));

			long startedAt = System.nanoTime();
			Wire.Response health = Wire.send(this.port, "GET", "/api/health");
			long elapsedMs = (System.nanoTime() - startedAt) / 1_000_000L;

			assertEquals(200, health.status(), "무관한 요청이 막혔다: " + health.body());
			assertTrue(elapsedMs < 5_000L, "무관한 요청이 " + elapsedMs + "ms 걸렸다 — 커넥션 경합이 의심된다");
		}
	}

	/**
	 * 삭제 응답의 판정 — <b>기대값을 코드에 박지 않고 grant 표에 묻는다</b>.
	 *
	 * <p>{@code GRANT DELETE ON news_stage.ReceiverConfig}는 root가 손으로 붙이는 것이라 리포가 통제하지
	 * 못한다(docs/ops-mysql.md §7). 붙어 있으면 계약이 동결한 {@code 200 {ok:true,changes:1}}이어야 하고,
	 * 아직이면 <b>권한 오류가 어떤 응답으로 나오는지</b>가 관측 대상이다 — 그 응답이 200이면(조용한 성공)
	 * 최악이므로 그 경우를 못 박아 막는다.
	 */
	private void assertDeleteOutcome(Wire.Response removed) throws SQLException {
		boolean granted = NewsAppMysql.tablesWithDeleteGrant(NewsAppMysql.STAGING_DATABASE)
				.contains("receiverconfig");
		if (granted) {
			assertEquals(200, removed.status(), "삭제: " + removed.body());
			assertEquals("{\"ok\":true,\"changes\":1}", removed.body(), "계약이 동결한 응답 원문이다");
			return;
		}
		assertFalse(removed.body().contains("\"changes\":1"),
				"권한이 없는데 삭제가 성공했다고 응답했다: " + removed.body());
		assertEquals(500, removed.status(),
				"권한 오류는 500 internal-error 로 나온다(측정 기록 — step summary): " + removed.body());
		assertTrue(removed.body().toLowerCase(Locale.ROOT).contains("internal-error"), removed.body());
	}

	private void createUser(String userId, String role, String name) {
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("userId", userId);
		dto.put("name", name);
		dto.put("role", role);
		dto.put("department", "편집국");
		dto.put("departmentCode", "EDT");
		dto.put("password", PASSWORD);
		this.users.create(dto);
	}

	private String login(String userId) {
		Wire.Response response = Wire.json(this.port, "POST", "/api/login", Map.of(),
				"{\"userId\":\"" + userId + "\",\"password\":\"" + PASSWORD + "\"}");
		return group(SESSION_ID, response.body(), "로그인 실패 status=" + response.status());
	}

	private static String group(Pattern pattern, String body, String message) {
		Matcher matcher = pattern.matcher(body);
		assertTrue(matcher.find(), message);
		return matcher.group(1);
	}

	/** 업로드 루트는 mysql 모드에서도 필요하다 — {@code app.data-dir}가 그 값을 낸다. */
	private static Path uploadsRoot() {
		try {
			Path dir = Files.createTempDirectory("news-app-mysql-smoke-");
			Runtime.getRuntime().addShutdownHook(new Thread(() -> {
				try {
					Files.deleteIfExists(dir);
				}
				catch (IOException ignored) {
					// 정리는 best-effort.
				}
			}));
			return dir;
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}
}
