package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
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

	/**
	 * 이력 원장 전용 금지 패턴. 위의 전역 목록은 {@code delete from}·DDL만 막으므로 원장을 <b>고치는</b>
	 * 문장은 여기서 따로 막는다. 두 스캔({@link #mainSourcesNeverRewriteTheHistoryLedger} 원문 ·
	 * {@link #theLedgerScanSeesThroughTheTableNameConstants} 상수 펼침)이 같은 목록을 쓴다 — 한쪽만
	 * 늘어나면 그 순간 다른 쪽이 거짓말을 한다.
	 */
	private static final List<Pattern> LEDGER_MUTATIONS = List.of(
			Pattern.compile("(?i)\\bupdate\\s+ArticleHistory\\b"),
			Pattern.compile("(?i)\\bdelete\\s+.{0,40}ArticleHistory\\b"),
			Pattern.compile("(?i)\\binsert\\s+or\\s+replace\\b"),
			Pattern.compile("(?i)\\breplace\\s+into\\b"));

	/**
	 * 테이블 이름 상수 → 실제 이름. main 소스가 SQL에 테이블 이름을 <b>직접 쓰지 않기 때문에</b>
	 * 필요하다(정적 스캔이 코드 스타일 하나로 우회되는 것을 막는 펼치기 표다).
	 */
	private static final Map<String, String> TABLE_CONSTANTS = Map.of(
			"USER_TABLE", RequiredSchema.USER_TABLE,
			"ARTICLE_TABLE", RequiredSchema.ARTICLE_TABLE,
			"CONTENTS_TABLE", RequiredSchema.CONTENTS_TABLE,
			"HISTORY_TABLE", RequiredSchema.HISTORY_TABLE);

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

	/**
	 * 이력 원장은 <b>append-only</b>다 — 삽입과 조회뿐이고 그 행을 고치거나 지우는 문장이 없다.
	 *
	 * <p>{@code ArticleHistory} 행은 감사 기록만이 아니라 판정 입력이다(사이클 경계·배부 멱등).
	 * 지우면 복구 수단이 없고, 고치면 "언제 무엇이 일어났는가"가 사후에 흔들린다. 위의 전역 스캔은
	 * {@code delete from}·DDL만 막으므로 이 원장 전용 갱신 문장은 여기서 따로 막는다.
	 */
	@Test
	void mainSourcesNeverRewriteTheHistoryLedger() throws IOException {
		List<String> hits = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				String text = Files.readString(file, StandardCharsets.UTF_8);
				for (Pattern pattern : LEDGER_MUTATIONS) {
					if (pattern.matcher(text).find()) {
						hits.add(file + " ~ " + pattern.pattern());
					}
				}
			}
		}

		assertTrue(hits.isEmpty(), "이력 원장(append-only)을 고치거나 지우는 SQL이 main 소스에 있다: " + hits);
	}

	/**
	 * 같은 금지를 <b>테이블 이름을 상수로 감춘 SQL</b>에도 적용한다.
	 *
	 * <p>왜 필요한가(2026-08-24 변이 실측): 이 리포지토리들은 테이블 이름을 문자열로 쓰지 않고
	 * {@code "UPDATE " + RequiredSchema.HISTORY_TABLE}처럼 <b>상수를 이어붙인다</b>. 그래서 원문만 보는
	 * 위 스캔은 그 형태의 원장 변조를 통째로 놓친다 — 실제로 {@code insert}가 이전 행의 본문을 지우도록
	 * 고친 변이에서 위 테스트는 <b>green</b>이었다(행동 테스트 10건이 red였다). 코드 스타일 자체가
	 * 우회 경로이므로, 판정 전에 상수를 펼쳐서 같은 패턴을 다시 적용한다.
	 *
	 * <p>이 스캔은 행동 테스트를 대신하지 않는다. 덮는 벡터가 다르다: 여기는 "그런 SQL이 소스에 있다"를,
	 * {@code ArticleHistoryRepositoryTest}는 "행이 실제로 바뀐다"를 잡는다.
	 */
	@Test
	void theLedgerScanSeesThroughTheTableNameConstants() throws IOException {
		List<String> hits = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				String text = inlineTableConstants(Files.readString(file, StandardCharsets.UTF_8));
				for (Pattern pattern : LEDGER_MUTATIONS) {
					if (pattern.matcher(text).find()) {
						hits.add(file + " ~ " + pattern.pattern());
					}
				}
			}
		}

		assertTrue(hits.isEmpty(),
				"상수로 조립한 원장 변조 SQL이 main 소스에 있다(테이블 이름을 펼친 뒤 판정): " + hits);
	}

	/**
	 * 위 스캐너가 <b>공허하지 않다</b>는 증거 — 실제 변이와 같은 형태를 심어 잡히는지 확인한다.
	 * (이 자기 검사가 없으면 "펼치기"가 망가져도 테스트는 조용히 green이다.)
	 */
	@Test
	void theSubstitutingScannerDetectsAPlantedLedgerMutation() {
		String planted = inlineTableConstants(
				"sql(\"UPDATE \" + RequiredSchema.HISTORY_TABLE + \" SET markupVersion = '' WHERE id < ?\")");

		assertTrue(LEDGER_MUTATIONS.stream().anyMatch((pattern) -> pattern.matcher(planted).find()),
				"상수를 펼친 뒤에도 원장 갱신 SQL을 잡지 못한다 — 스캐너가 공허하다: " + planted);
	}

	/**
	 * 정본 판정과 무관한 갱신(예: {@code Contents} 행 갱신)은 <b>계속 허용</b>임을 못 박는다.
	 * 이 단언이 없으면 위 스캔이 넓어져 정상 코드를 막는 쪽으로 드리프트해도 아무도 모른다.
	 */
	@Test
	void theSubstitutingScannerStillAllowsUpdatesToOtherTables() {
		String allowed = inlineTableConstants(
				"sql(\"UPDATE \" + RequiredSchema.CONTENTS_TABLE + \" SET status = ? WHERE articleId = ?\")");

		assertTrue(LEDGER_MUTATIONS.stream().noneMatch((pattern) -> pattern.matcher(allowed).find()),
				"원장이 아닌 테이블의 갱신까지 막고 있다: " + allowed);
	}

	/**
	 * 소스의 테이블 상수 참조를 실제 이름으로 펼치고 이어붙이기 문법({@code "} · {@code +})을 공백으로
	 * 지운다 — {@code "UPDATE " + RequiredSchema.HISTORY_TABLE}이 {@code UPDATE ArticleHistory}가 된다.
	 */
	private static String inlineTableConstants(String text) {
		// 클래스 한정자를 먼저 떼어 낸다 — 그래야 정규 이름과 static import 형태가 같은 자리로 수렴한다.
		String out = text.replace(RequiredSchema.class.getSimpleName() + ".", "");
		for (Map.Entry<String, String> constant : TABLE_CONSTANTS.entrySet()) {
			out = out.replace(constant.getKey(), constant.getValue());
		}
		return out.replaceAll("[\"+]", " ").replaceAll("[ \\t]+", " ");
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
