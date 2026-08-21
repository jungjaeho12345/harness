package harness.news.testsupport;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * 테스트용 임시 데이터 디렉토리 생성기.
 *
 * <p><b>리포 {@code news.db}는 절대 열지 않는다.</b> 전부 {@code @TempDir}/OS 임시 디렉토리에 만든 사본이고,
 * 스키마는 테스트 리소스의 픽스처(`db/user-schema*.sql`)로 세운다 — main 소스에는 스키마 정의 SQL이 없다
 * (decisions (4)(5)).
 *
 * <p>여기서만 DDL을 실행한다. 프로덕션 경로가 DDL을 실행하지 않는다는 사실은
 * {@code NoSchemaSqlInMainSourcesTest}가 기계로 지킨다.
 */
public final class TempNewsDb {

	/**
	 * Node `src/db/schema.js`와 1:1인 <b>정본</b> 픽스처 — User·Article·Contents·ArticleHistory.
	 *
	 * <p>부팅 스키마 검증({@code SchemaGuard})은 {@code RequiredSchema.TABLES}의 전 테이블을 보므로
	 * 이 픽스처가 요구 목록을 따라가지 못하면 <b>이것으로 시드된 모든 @SpringBootTest가 컨텍스트 로딩에서
	 * 죽는다</b>. 요구 목록을 넓히는 step이 이 파일도 같이 넓힌다(phase 69 forward_notes (9)).
	 */
	public static final String CANONICAL_FIXTURE = "db/user-schema.sql";

	/** User 잠금 컬럼 2개가 빠진 드리프트 픽스처(부팅 검증이 거부해야 하는 DB). 기사 3테이블도 없다. */
	public static final String DRIFT_FIXTURE = "db/user-schema-drift.sql";

	/** Contents 2컬럼(secondEmbargoAt·lockerSessionId)만 빠진 드리프트 픽스처 — 컬럼 단위 거부 실증용. */
	public static final String ARTICLE_DRIFT_FIXTURE = "db/article-schema-drift.sql";

	/** 데이터 디렉토리 안의 DB 파일 이름 — 서버가 여는 이름과 같아야 한다. */
	public static final String DB_FILE_NAME = "news.db";

	private static Path sharedDataDir;

	private TempNewsDb() {
	}

	/** 주어진 디렉토리에 정본 픽스처로 {@code news.db}를 만들고 그 디렉토리를 돌려준다. */
	public static Path seed(Path dataDir) {
		return seed(dataDir, CANONICAL_FIXTURE);
	}

	/** 주어진 디렉토리에 지정 픽스처로 {@code news.db}를 만들고 그 디렉토리를 돌려준다. */
	public static Path seed(Path dataDir, String fixtureResource) {
		Path db = dbFile(dataDir);
		for (String statement : statements(fixtureResource)) {
			exec(db, statement);
		}
		return dataDir;
	}

	/** 테이블이 하나도 없는 빈 DB 파일을 만든다(테이블 자체가 없는 상황 재현). */
	public static Path seedEmpty(Path dataDir) {
		Path db = dbFile(dataDir);
		try (Connection ignored = DriverManager.getConnection(jdbcUrl(db))) {
			// 연결만으로 파일이 생성된다 — 스키마는 세우지 않는다.
			return dataDir;
		}
		catch (SQLException ex) {
			throw new IllegalStateException("빈 임시 DB 생성 실패: " + db, ex);
		}
	}

	/**
	 * JVM 수명 동안 재사용하는 시드된 데이터 디렉토리.
	 *
	 * <p>전 기동 컨텍스트 테스트(@SpringBootTest)가 {@code app.data-dir}로 쓴다 — 컨텍스트 로딩 시점에
	 * 이미 존재해야 해서 {@code @TempDir}(테스트 인스턴스 수명)로는 만들 수 없다. 종료 훅으로 지운다.
	 */
	public static synchronized Path sharedDataDir() {
		if (sharedDataDir == null) {
			try {
				Path dir = Files.createTempDirectory("news-spring-test-");
				seed(dir);
				Runtime.getRuntime().addShutdownHook(new Thread(() -> deleteRecursively(dir)));
				sharedDataDir = dir;
			}
			catch (IOException ex) {
				throw new UncheckedIOException(ex);
			}
		}
		return sharedDataDir;
	}

	/**
	 * 호출할 때마다 <b>새로</b> 만드는 시드된 데이터 디렉토리.
	 *
	 * <p>전 기동 와이어 테스트는 실제 계정을 만들고 지우지 않으므로(DB 비파괴 규율: 삭제 SQL 0)
	 * 클래스마다 자기 DB를 가져야 서로의 픽스처·세션에 얽히지 않는다. {@link #sharedDataDir()}는
	 * 반대로 "DB만 있으면 되는" 컨텍스트 테스트가 재사용하는 한 벌이다. 둘 다 종료 훅으로 지운다.
	 *
	 * @param prefix 임시 디렉토리 접두사(어느 테스트가 만들었는지 눈으로 구분하기 위함)
	 */
	public static Path newDataDir(String prefix) {
		try {
			Path dir = Files.createTempDirectory("news-spring-" + prefix + "-");
			seed(dir);
			Runtime.getRuntime().addShutdownHook(new Thread(() -> deleteRecursively(dir)));
			return dir;
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	/** 데이터 디렉토리 안의 DB 파일 경로. */
	public static Path dbFile(Path dataDir) {
		return dataDir.resolve(DB_FILE_NAME);
	}

	/** 임시 DB에 임의 SQL 1건 실행(시드 전용). */
	public static void exec(Path db, String sql) {
		try (Connection connection = DriverManager.getConnection(jdbcUrl(db));
				Statement statement = connection.createStatement()) {
			statement.executeUpdate(sql);
		}
		catch (SQLException ex) {
			throw new IllegalStateException("임시 DB 시드 실패: " + db + " / " + sql, ex);
		}
	}

	/** 픽스처 리소스를 읽어 세미콜론 단위 문장 목록으로 자른다(주석 줄 제거). */
	public static List<String> statements(String fixtureResource) {
		String raw = readResource(fixtureResource);
		StringBuilder sql = new StringBuilder();
		for (String line : raw.split("\\R")) {
			if (line.trim().startsWith("--")) {
				continue;
			}
			sql.append(line).append('\n');
		}
		List<String> statements = new ArrayList<>();
		for (String chunk : sql.toString().split(";")) {
			String trimmed = chunk.trim();
			if (!trimmed.isEmpty()) {
				statements.add(trimmed);
			}
		}
		return statements;
	}

	private static String jdbcUrl(Path db) {
		return "jdbc:sqlite:" + db.toAbsolutePath();
	}

	private static String readResource(String resource) {
		try (var in = TempNewsDb.class.getClassLoader().getResourceAsStream(resource)) {
			if (in == null) {
				throw new IllegalStateException("테스트 픽스처를 찾을 수 없다: " + resource);
			}
			return new String(in.readAllBytes(), StandardCharsets.UTF_8);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	private static void deleteRecursively(Path root) {
		if (!Files.exists(root)) {
			return;
		}
		try (var paths = Files.walk(root)) {
			paths.sorted(Comparator.reverseOrder()).forEach(path -> {
				try {
					Files.deleteIfExists(path);
				}
				catch (IOException ignored) {
					// 임시 디렉토리 정리는 best-effort — 실패해도 테스트 판정에 영향을 주지 않는다.
				}
			});
		}
		catch (IOException ignored) {
			// 위와 같다.
		}
	}
}
