package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * 정적 잠금: main 소스 트리에는 스키마를 만들거나 바꾸거나 행을 지우는 SQL이 한 줄도 없다.
 *
 * <p>이유는 두 가지다. ① 스키마 소유자는 Node 서버(`src/db/schema.js`)이고, 이 서버가 스키마를 만들기
 * 시작하면 "P2까지 스키마는 한 곳에서만 바뀐다"는 전제가 무너진다. ② 최상위 규칙(DB에 있는 내용은 절대
 * 삭제하지 않는다) — 비활성화는 {@code active='N'} 업데이트(soft delete)뿐이다. 리뷰는 놓칠 수 있으니
 * 기계가 지킨다.
 *
 * <p>스캔 대상은 {@code src/main/java} 전체다(이 파일은 테스트 트리라 대상이 아니다 — 테스트만이
 * 임시 DB에 픽스처 스키마를 세운다).
 */
class NoSchemaSqlInMainSourcesTest {

	private static final Path MAIN_SOURCES = Path.of("src", "main", "java");

	/** 금지 패턴. 주석·문자열을 구분하지 않는다 — 주석에도 쓰지 않는 편이 안전하고 판정이 단순하다. */
	private static final List<Pattern> FORBIDDEN = List.of(
			Pattern.compile("(?i)\\bcreate\\s+(table|index|view|trigger)\\b"),
			Pattern.compile("(?i)\\balter\\s+table\\b"),
			Pattern.compile("(?i)\\bdrop\\s+(table|index|view|trigger|column|database)\\b"),
			Pattern.compile("(?i)\\bdelete\\s+from\\b"),
			Pattern.compile("(?i)\\btruncate\\s+table\\b"),
			// 자동 마이그레이션 도구는 항상 재생성 경로를 품는다 — 좌표조차 등장하면 안 된다.
			Pattern.compile("(?i)ddl-auto"),
			Pattern.compile("(?i)flyway"),
			Pattern.compile("(?i)liquibase"));

	@Test
	void mainSourcesContainNoSchemaMutatingSql() throws IOException {
		assertTrue(Files.isDirectory(MAIN_SOURCES),
				"스캔 대상이 없다 — 테스트 작업 디렉토리가 모듈 루트가 아니다: " + MAIN_SOURCES.toAbsolutePath());

		List<String> hits = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				String text = Files.readString(file, StandardCharsets.UTF_8);
				for (Pattern pattern : FORBIDDEN) {
					if (pattern.matcher(text).find()) {
						hits.add(file + " ~ " + pattern.pattern());
					}
				}
			}
		}

		assertTrue(hits.isEmpty(), "main 소스에 금지된 스키마/삭제 SQL이 있다: " + hits);
	}

	@Test
	void mainResourcesDeclareNoAutomaticMigration() throws IOException {
		Path resources = Path.of("src", "main", "resources");
		assertTrue(Files.isDirectory(resources), "스캔 대상이 없다: " + resources.toAbsolutePath());

		List<String> hits = new ArrayList<>();
		try (Stream<Path> files = Files.walk(resources)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				String text = Files.readString(file, StandardCharsets.UTF_8);
				for (Pattern pattern : FORBIDDEN) {
					if (pattern.matcher(text).find()) {
						hits.add(file + " ~ " + pattern.pattern());
					}
				}
			}
		}

		assertTrue(hits.isEmpty(), "설정 리소스에 금지된 스키마 자동화가 있다: " + hits);
		assertTrue(Files.notExists(resources.resolve("schema.sql")), "schema.sql을 두지 않는다");
		assertTrue(Files.notExists(resources.resolve("data.sql")), "data.sql을 두지 않는다");
	}
}
