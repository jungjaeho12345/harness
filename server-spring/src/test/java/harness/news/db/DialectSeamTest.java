package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * 정적 잠금: <b>방언 철자는 한 파일에만 있다</b>(ADR-016 · phase 75 step5).
 *
 * <h2>왜 필요한가</h2>
 * 이 phase는 저장소를 SQLite에서 MySQL로 옮긴다. 그 작업이 실제로 끝났는지는 "MySQL로 떴다"가 아니라
 * <b>SQLite 전용 표면이 코드에 몇 군데 남아 있는가</b>로 판정된다 — 남아 있으면 그 자리는 MySQL에서
 * 조용히 다르게 동작하거나 문법 오류로 죽는다({@code pragma_table_info}·{@code last_insert_rowid}가
 * 정확히 그런 자리였다). 방언 지점이 <b>한 파일</b>이면 다음 방언을 붙이는 비용도 그 파일 하나다.
 *
 * <h2>개수가 아니라 파일 집합을 단언한다</h2>
 * "예외 N개"로 단언하면 예외 파일이 <b>교체돼도</b> green이다(phase 74 forward_notes (4)의 교훈).
 * 그래서 {@link #ALLOWED}는 집합이고 판정은 {@code assertEquals(집합, 집합)}이다 — 예외를 하나
 * 더하면 그 순간 red이고, 예외로 지정된 파일에서 철자가 <b>사라져도</b> red다(썩은 예외 금지).
 */
class DialectSeamTest {

	private static final Path MAIN_SOURCES = Path.of("src", "main", "java");

	/**
	 * 방언 철자 — SQLite 전용 4종과 MySQL 전용 2종. 대소문자를 구분하지 않는다({@code pragma}를 소문자로
	 * 적어도 SQLite에서 그대로 동작하므로 대문자만 막으면 우회가 된다).
	 *
	 * <p>{@code sqlite}·{@code mysql} 단어 자체는 넣지 않는다 — 그 낱말은 <b>설명</b>에 필요하고(주석이
	 * 방언 차이를 기록하는 것이 이 리포의 규율이다) 금지하면 문서화를 막는 방향으로 드리프트한다.
	 * 여기서 막는 것은 <b>실행되는 철자</b>다: 드라이버 좌표·URL 스킴·전용 함수 이름.
	 */
	private static final List<Pattern> DIALECT_SPELLINGS = List.of(
			Pattern.compile("(?i)jdbc:sqlite"),
			Pattern.compile("(?i)org\\.sqlite"),
			Pattern.compile("(?i)pragma"),
			Pattern.compile("(?i)last_insert_rowid"),
			Pattern.compile("(?i)jdbc:mysql"),
			Pattern.compile("(?i)com\\.mysql"));

	/**
	 * 철자가 허용되는 <b>유일한</b> 파일. 설정 클래스({@link DbProperties})는 방언 <b>이름</b>
	 * ({@code sqlite}/{@code mysql})만 알고 URL 접두사·드라이버 좌표는 여기 상수를 참조하므로 이 집합에
	 * 들어오지 않는다 — 그것이 "방언 지점 1파일"의 실제 형태다.
	 */
	private static final Set<String> ALLOWED = Set.of("harness/news/db/NewsDataSource.java");

	@Test
	void everyDialectSpellingLivesInExactlyOneFile() throws IOException {
		assertTrue(Files.isDirectory(MAIN_SOURCES),
				"스캔 대상이 없다 — 작업 디렉토리가 모듈 루트가 아니다: " + MAIN_SOURCES.toAbsolutePath());

		assertEquals(new TreeSet<>(ALLOWED), new TreeSet<>(filesCarryingADialectSpelling()),
				"방언 철자가 허용된 파일 집합과 정확히 일치하지 않는다 — 새 방언 지점이 생겼거나(추가) "
						+ "허용 파일에서 철자가 사라졌다(썩은 예외)");
	}

	/**
	 * 스캐너가 <b>공허하지 않다</b>는 증거 — 6종 철자를 하나씩 심어 전부 잡히는지 본다. 이 자기 검사가
	 * 없으면 정규식이 망가져 아무것도 잡지 못해도 위 테스트는 조용히 green이다(허용 집합과 빈 집합이
	 * 어긋나므로 red가 나긴 하지만, 그때 원인이 "스캐너 고장"인지 "코드 정리"인지 구분되지 않는다).
	 */
	@Test
	void theScannerDetectsEveryPlantedSpelling() {
		for (String planted : List.of(
				"config.setJdbcUrl(\"jdbc:sqlite:\" + db);",
				"config.setDriverClassName(\"org.sqlite.JDBC\");",
				"statement.executeQuery(\"PRAGMA busy_timeout\");",
				"jdbcClient.sql(\"SELECT name FROM pragma_table_info(?)\");",
				"jdbcClient.sql(\"SELECT last_insert_rowid()\");",
				"config.setJdbcUrl(\"jdbc:mysql://127.0.0.1:3306/news\");",
				"config.setDriverClassName(\"com.mysql.cj.jdbc.Driver\");")) {
			assertTrue(DIALECT_SPELLINGS.stream().anyMatch((pattern) -> pattern.matcher(planted).find()),
					"방언 철자를 놓친다 — 스캐너가 공허하다: " + planted);
		}
	}

	/**
	 * 방언을 <b>설명하는 산문</b>은 계속 허용임을 못 박는다. 이 단언이 없으면 스캔이 넓어져 주석에서
	 * 방언 차이를 기록하는 것까지 막는 쪽으로 드리프트한다(그 기록이 이 phase의 산출물이다).
	 */
	@Test
	void theScannerStillAllowsProseAboutTheDialects() {
		for (String prose : List.of(
				"SQLite는 단일 파일이라 동시 쓰기가 SQLITE_BUSY를 낸다.",
				"MySQL 8.0은 id를 재사용하지 않는다(divergence로 기록).",
				"저장 표현은 두 방언에서 같다.")) {
			assertTrue(DIALECT_SPELLINGS.stream().noneMatch((pattern) -> pattern.matcher(prose).find()),
					"방언을 설명하는 문장까지 막고 있다: " + prose);
		}
	}

	/** main 소스에서 방언 철자를 담은 파일들(모듈 상대 경로 · {@code /} 구분자). */
	private static Set<String> filesCarryingADialectSpelling() throws IOException {
		Set<String> hits = new LinkedHashSet<>();
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				String text = Files.readString(file, StandardCharsets.UTF_8);
				for (Pattern pattern : DIALECT_SPELLINGS) {
					if (pattern.matcher(text).find()) {
						hits.add(relative(file));
					}
				}
			}
		}
		return hits;
	}

	/** {@code src/main/java} 이하의 상대 경로 — OS 구분자 차이가 단언에 새지 않게 한다. */
	private static String relative(Path file) {
		return MAIN_SOURCES.relativize(file).toString().replace('\\', '/');
	}
}
