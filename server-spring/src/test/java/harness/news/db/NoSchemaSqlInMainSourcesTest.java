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

	/**
	 * 금지 패턴(스키마 생성/변경/삭제·자동 마이그레이션). 주석·문자열을 구분하지 않는다 — 주석에도 쓰지
	 * 않는 편이 안전하고 판정이 단순하다.
	 *
	 * <p>이 상수는 <b>리소스 스캔</b>({@link #mainResourcesDeclareNoAutomaticMigration})과
	 * java-main 스캔이 공유한다. 그래서 여기 있는 {@code delete from}은 <b>모든 테이블</b>을 막는
	 * 전면 금지로 남긴다 — java-main 쪽의 ReceiverConfig 예외는 이 공유 상수를 완화하는 것이 아니라
	 * {@link #mainSourcesContainNoSchemaMutatingSql}의 <b>메서드-로컬 패턴</b>으로만 좁힌다(공유 상수를
	 * 완화하면 리소스에도 {@code DELETE FROM ReceiverConfig}가 허용되는 과다완화가 된다 — phase 70 검토 권고).
	 */
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

	/**
	 * java-main 스캔의 DDL 금지 패턴 — {@link #FORBIDDEN}에서 {@code delete from}만 뺀 나머지다.
	 * 삭제는 아래 {@link #DELETE_FROM_OTHER_TABLE}가 ReceiverConfig 하나만 예외로 두고 좁혀서 본다.
	 */
	private static final List<Pattern> MAIN_JAVA_DDL_FORBIDDEN = FORBIDDEN.stream()
			.filter((pattern) -> !pattern.pattern().contains("delete"))
			.toList();

	/**
	 * <b>ReceiverConfig가 아닌</b> 테이블의 {@code DELETE FROM}만 잡는다(negative lookahead).
	 *
	 * <p>{@code DELETE FROM ReceiverConfig}는 이 서버 유일의 행 삭제 예외 경계다(SCHEMA.md 76행·계약
	 * 파일 7~9행: 설정 행만 지우고 수집된 Article/Contents는 불변 = DB 비파괴 원칙의 명시적 예외). 그
	 * 하나만 허용하고 나머지 6테이블(User·Article·Contents·ArticleHistory·DistributionTarget·Photo)의
	 * 행 삭제는 여전히 red다 — {@code (?!receiverconfig\b)}가 그 부재를 적극 단언한다(예: {@code DELETE
	 * FROM Contents}·{@code DELETE FROM DistributionTarget}는 잔여 매치로 잡힌다).
	 */
	private static final Pattern DELETE_FROM_OTHER_TABLE =
			Pattern.compile("(?i)\\bdelete\\s+from\\s+(?!receiverconfig\\b)");

	@Test
	void mainSourcesContainNoSchemaMutatingSql() throws IOException {
		assertTrue(Files.isDirectory(MAIN_SOURCES),
				"스캔 대상이 없다 — 테스트 작업 디렉토리가 모듈 루트가 아니다: " + MAIN_SOURCES.toAbsolutePath());

		List<String> hits = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				String text = Files.readString(file, StandardCharsets.UTF_8);
				for (Pattern pattern : MAIN_JAVA_DDL_FORBIDDEN) {
					if (pattern.matcher(text).find()) {
						hits.add(file + " ~ " + pattern.pattern());
					}
				}
				// 삭제는 ReceiverConfig 하나만 예외 — 그 외 테이블의 DELETE FROM은 여전히 금지다.
				if (DELETE_FROM_OTHER_TABLE.matcher(text).find()) {
					hits.add(file + " ~ " + DELETE_FROM_OTHER_TABLE.pattern());
				}
			}
		}

		assertTrue(hits.isEmpty(),
				"main 소스에 금지된 스키마/삭제 SQL이 있다(허용은 DELETE FROM ReceiverConfig 하나뿐): " + hits);
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
