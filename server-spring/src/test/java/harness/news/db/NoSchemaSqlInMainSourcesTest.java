package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
 * 정적 잠금: main 소스 트리에는 스키마를 만들거나 바꾸는 SQL이 한 줄도 없고, 행 {@code DELETE}는
 * <b>설계상 유일한 예외 하나</b>({@code receiver-config-delete})만 있다.
 *
 * <p>이유는 두 가지다. ① 스키마 소유자는 Node 서버(`src/db/schema.js`)이고, 이 서버가 스키마를 만들기
 * 시작하면 "P2까지 스키마는 한 곳에서만 바뀐다"는 전제가 무너진다. ② 최상위 규칙(DB에 있는 내용은 절대
 * 삭제하지 않는다) — 비활성화는 {@code active='N'} 업데이트(soft delete)뿐이다.
 *
 * <p><b>행 삭제의 유일한 예외</b>: 시스템은 수신 설정({@code ReceiverConfig}) 한 테이블에 대해서만
 * 설계상 행 삭제 라우트를 둔다({@code DELETE /api/receiver-config/:id} · SCHEMA.md · index.json
 * decisions (1)). 이 {@code DELETE FROM ReceiverConfig}는 <b>설정 행만</b> 지우고 그 sourceId로 수집된
 * Article/Contents는 건드리지 않는다. 그래서 행 {@code DELETE}는 {@code ReceiverConfigRepository} 파일에서
 * {@code ReceiverConfig} 테이블을 겨냥할 때만 허용하고, 그 밖의 파일·테이블에서는 여전히 금지한다.
 * DDL(CREATE/ALTER/DROP/TRUNCATE)은 예외 없이 전 파일에서 금지다.
 *
 * <p>스캔 대상은 {@code src/main/java} 전체다(이 파일은 테스트 트리라 대상이 아니다 — 테스트만이
 * 임시 DB에 픽스처 스키마를 세운다).
 */
class NoSchemaSqlInMainSourcesTest {

	private static final Path MAIN_SOURCES = Path.of("src", "main", "java");

	/**
	 * DDL·자동 마이그레이션 금지 패턴 — <b>예외 없이 전 파일</b>에서 0건. 행 {@code DELETE}는 여기 없다
	 * (설계상 예외가 있어 별도 규칙으로 다룬다). 주석·문자열을 구분하지 않는다 — 주석에도 쓰지 않는 편이
	 * 안전하고 판정이 단순하다.
	 */
	private static final List<Pattern> FORBIDDEN = List.of(
			Pattern.compile("(?i)\\bcreate\\s+(table|index|view|trigger)\\b"),
			Pattern.compile("(?i)\\balter\\s+table\\b"),
			Pattern.compile("(?i)\\bdrop\\s+(table|index|view|trigger|column|database)\\b"),
			Pattern.compile("(?i)\\btruncate\\s+table\\b"),
			// 자동 마이그레이션 도구는 항상 재생성 경로를 품는다 — 좌표조차 등장하면 안 된다.
			Pattern.compile("(?i)ddl-auto"),
			Pattern.compile("(?i)flyway"),
			Pattern.compile("(?i)liquibase"));

	/** 행 삭제문 매처 — {@code DELETE FROM <table>}에서 테이블 이름을 잡는다. */
	private static final Pattern DELETE_FROM = Pattern.compile("(?i)\\bdelete\\s+from\\s+(\\w+)");

	/** 행 {@code DELETE}가 허용되는 <b>유일한</b> 파일과 테이블(decisions (1)). */
	private static final String ROW_DELETE_ALLOWED_FILE = "ReceiverConfigRepository.java";

	private static final String ROW_DELETE_ALLOWED_TABLE = "ReceiverConfig";

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
				// 행 DELETE: ReceiverConfigRepository에서 ReceiverConfig 테이블을 겨냥할 때만 허용하고
				// 그 밖(다른 파일·다른 테이블)은 금지한다.
				var delete = DELETE_FROM.matcher(text);
				while (delete.find()) {
					boolean allowedFile = file.getFileName().toString().equals(ROW_DELETE_ALLOWED_FILE);
					boolean allowedTable = delete.group(1).equals(ROW_DELETE_ALLOWED_TABLE);
					if (!allowedFile || !allowedTable) {
						hits.add(file + " ~ DELETE FROM " + delete.group(1) + " (설계 예외 밖의 행 삭제)");
					}
				}
			}
		}

		assertTrue(hits.isEmpty(), "main 소스에 금지된 스키마/삭제 SQL이 있다: " + hits);
	}

	@Test
	void theOnlyRowDeleteIsReceiverConfigDelete() throws IOException {
		// 설계상 유일한 행 삭제(receiver-config-delete)가 실제로 존재하고 ReceiverConfig만 겨냥하는지
		// 적극적으로 확인한다 — 예외가 조용히 사라지거나 다른 테이블로 번지지 않게(decisions (1)).
		List<String> deletes = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				String text = Files.readString(file, StandardCharsets.UTF_8);
				var delete = DELETE_FROM.matcher(text);
				while (delete.find()) {
					deletes.add(file.getFileName().toString() + ":" + delete.group(1));
				}
			}
		}

		assertEquals(List.of(ROW_DELETE_ALLOWED_FILE + ":" + ROW_DELETE_ALLOWED_TABLE), deletes,
				"행 DELETE는 ReceiverConfigRepository의 ReceiverConfig 하나뿐이어야 한다");
	}

	/**
	 * 이력 원장은 <b>append-only</b>다 — 삽입과 조회뿐이고 그 행을 고치거나 지우는 문장이 없다.
	 *
	 * <p>{@code ArticleHistory} 행은 감사 기록만이 아니라 판정 입력이다(사이클 경계·배부 멱등).
	 * 지우면 복구 수단이 없고, 고치면 "언제 무엇이 일어났는가"가 사후에 흔들린다. 위의 전역 스캔은
	 * {@code delete from}·DDL만 막으므로 이 원장 전용 갱신 문장은 여기서 따로 막는다.
	 */
	@Test
	void mainSourcesNeverRewriteTheHistoryLedger() throws IOException {
		List<Pattern> ledgerMutations = List.of(
				Pattern.compile("(?i)\\bupdate\\s+ArticleHistory\\b"),
				Pattern.compile("(?i)\\bdelete\\s+.{0,40}ArticleHistory\\b"),
				Pattern.compile("(?i)\\binsert\\s+or\\s+replace\\b"),
				Pattern.compile("(?i)\\breplace\\s+into\\b"));

		List<String> hits = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				String text = Files.readString(file, StandardCharsets.UTF_8);
				for (Pattern pattern : ledgerMutations) {
					if (pattern.matcher(text).find()) {
						hits.add(file + " ~ " + pattern.pattern());
					}
				}
			}
		}

		assertTrue(hits.isEmpty(), "이력 원장(append-only)을 고치거나 지우는 SQL이 main 소스에 있다: " + hits);
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
