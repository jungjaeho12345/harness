package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.ContentsRow;
import harness.news.service.SpoolWriter.SpoolFs;
import harness.news.service.SpoolWriter.WriteResult;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * 배부 스풀 writer — 리포 루트 {@code src/services/spoolWriter.js}와 1:1인 <b>파일 어댑터</b>의 동작 계약.
 * 이 서버에서 파일을 쓰는 자리는 여기 하나뿐이다(ADR-008 (1) · {@code Adr008DisciplineTest} 4군 예외).
 *
 * <p>기대값의 출처는 계획서가 아니라 <b>Node 정본 실측</b>이다(2026-08-25 — 원본 모듈에 가짜 fs를 주입해
 * 키 순서·파일명·mkdir 호출 유무·같은 시각 재기록·payload 바이트를 관측했다).
 *
 * <p><b>여기서 잠그는 것 5가지.</b>
 * <ol>
 *   <li><b>필드 allowlist 20키</b>다(블랙리스트가 아니다). {@code internalComment}와 잠금 5컬럼이 외부
 *       수신처로 나가면 내부 코멘트와 <b>유효 세션 토큰</b>이 함께 나간다.</li>
 *   <li><b>pick 의미론</b> — 값이 null이면 <b>키 자체가 빠진다</b>(API 투영의 'NULL 키 보존'과 정반대).</li>
 *   <li><b>경로 합성 방어</b> — 저장된 {@code spoolDir}라도 {@link SpoolDir#sanitizeSpoolDir}로 재검증한다.
 *       거부는 <b>파일시스템 무접촉</b>이어야 한다(디렉토리조차 만들지 않는다).</li>
 *   <li><b>원자 게시</b> — 같은 디렉토리의 {@code .<name>.tmp}에 쓰고 원자 이동한다. 결과 파일만 보면
 *       최종 경로 직접 쓰기와 구별되지 않으므로 <b>호출 순서</b>를 seam으로 관찰한다.</li>
 *   <li><b>throw 0</b> — 모든 실패는 고정 토큰이고, 실패 결과에는 경로가 실리지 않는다.</li>
 * </ol>
 */
class SpoolWriterTest {

	private static final Instant FIXED = Instant.parse("2026-07-28T01:02:03.456Z");

	/** 고정 시계가 만드는 파일명 스탬프 — {@code -}·{@code :}·{@code .}를 제거한 compact 표기다. */
	private static final String STAMP = "20260728T010203456Z";

	private static final String ARTICLE_ID = "AKR20260728001";

	private static final String SPOOL_DIR = "recv1";

	private static Clock fixedClock() {
		return Clock.fixed(FIXED, ZoneOffset.UTC);
	}

	private static ContentsRow contents(Map<String, Object> columns) {
		return ContentsRow.of(columns);
	}

	/** 값이 null인 컬럼을 담아야 하므로 {@code Map.of}를 쓸 수 없다. */
	private static Map<String, Object> row(Object... pairs) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < pairs.length; i += 2) {
			map.put((String) pairs[i], pairs[i + 1]);
		}
		return map;
	}

	private static List<String> keysOf(String json) {
		List<String> keys = new ArrayList<>();
		int at = 0;
		boolean expectKey = true;
		while (at < json.length()) {
			char c = json.charAt(at);
			if (c == '"') {
				int end = at + 1;
				StringBuilder token = new StringBuilder();
				while (json.charAt(end) != '"') {
					if (json.charAt(end) == '\\') {
						end++;
					}
					token.append(json.charAt(end));
					end++;
				}
				if (expectKey) {
					keys.add(token.toString());
					expectKey = false;
				}
				at = end + 1;
				continue;
			}
			if (c == ',') {
				expectKey = true;
			}
			at++;
		}
		return keys;
	}

	private static List<Path> filesUnder(Path root) {
		try (Stream<Path> walk = Files.walk(root)) {
			return walk.filter(Files::isRegularFile).sorted(Comparator.comparing(Path::toString)).toList();
		}
		catch (IOException ex) {
			throw new IllegalStateException(ex);
		}
	}

	private static List<Path> entriesUnder(Path root) {
		try (Stream<Path> walk = Files.walk(root)) {
			return walk.filter((path) -> !path.equals(root)).sorted(Comparator.comparing(Path::toString)).toList();
		}
		catch (IOException ex) {
			throw new IllegalStateException(ex);
		}
	}

	/** 호출을 기록하는 가짜 파일 연산 — 원자 게시의 <b>순서</b>를 관찰하는 유일한 수단이다. */
	private static final class RecordingFs implements SpoolFs {

		private final List<String> calls = new ArrayList<>();

		private final String failOn;

		RecordingFs() {
			this(null);
		}

		RecordingFs(String failOn) {
			this.failOn = failOn;
		}

		@Override
		public void createDirectories(Path dir) throws IOException {
			record("createDirectories", dir);
		}

		@Override
		public void write(Path file, byte[] bytes) throws IOException {
			record("write", file);
		}

		@Override
		public void moveAtomically(Path source, Path target) throws IOException {
			this.calls.add("moveAtomically " + source + " -> " + target);
			if ("moveAtomically".equals(this.failOn)) {
				throw new IOException("planted failure");
			}
		}

		private void record(String name, Path path) throws IOException {
			this.calls.add(name + " " + path);
			if (name.equals(this.failOn)) {
				throw new IOException("planted failure");
			}
		}

	}

	// --- 성공 경로 -------------------------------------------------------------------------------

	/** 1번 — 게시된 파일은 최종 경로에 있고 {@code .tmp}는 남지 않는다. */
	@Test
	void aSuccessfulWritePublishesTheFileAtTheStampedPath(@TempDir Path root) {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		WriteResult result = writer.write(SPOOL_DIR, ARTICLE_ID, Map.of(), contents(row()));

		Path expected = root.resolve(SPOOL_DIR).resolve(ARTICLE_ID + "_" + STAMP + ".json");
		assertTrue(result.ok(), "성공이어야 한다: " + result);
		assertNull(result.reason(), "성공 결과에 사유가 있으면 안 된다");
		assertEquals(expected.toString(), result.file());
		assertEquals(List.of(expected), filesUnder(root), "최종 파일 1개 — .tmp가 남으면 외부 전송기가 집어간다");
	}

	/**
	 * 2번 — payload는 <b>allowlist 20키</b>이고 조립 순서까지 산출물이다(외부 전송기가 읽는 파일이다).
	 *
	 * <p>Node 실측: Contents 18키 순서 → {@code markupVersion} → {@code articleId} 덮어쓰기(첫 등장 자리
	 * 유지) → {@code title} 폴백 → {@code distributedAt}.
	 */
	@Test
	void thePayloadIsTheAllowlistInTheAssemblyOrder(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		WriteResult result = writer.write(SPOOL_DIR, ARTICLE_ID, fullArticle(), contents(fullContents()));

		String json = Files.readString(Path.of(result.file()), StandardCharsets.UTF_8);
		assertEquals(List.of("articleId", "title", "author", "department", "departmentCode", "category", "region",
				"attribute", "keyword", "externalComment", "attachmentFile", "createdAt", "embargoAt", "status",
				"markupVersion", "distributedAt"), keysOf(json),
				"Node 실측 키 순서와 달라졌다(NULL 컬럼 coAuthor·referenceFile·sentAt·secondEmbargoAt는 빠진다)");
	}

	/**
	 * 2번 — <b>제외가 의도</b>다. 내부 코멘트와 편집 잠금 5컬럼(세션 토큰 포함)이 외부 수신처로 나가면
	 * 파일 한 장으로 남의 세션을 탈취할 수 있다.
	 */
	@Test
	void internalCommentAndLockColumnsNeverLeaveTheServer(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		WriteResult result = writer.write(SPOOL_DIR, ARTICLE_ID, fullArticle(), contents(fullContents()));

		String json = Files.readString(Path.of(result.file()), StandardCharsets.UTF_8);
		for (String forbidden : List.of("internalComment", "lockYN", "lockerUserId", "lockerSessionId",
				"lockerClientId", "lockedAt", "content", "modifier", "sender", "editedAt")) {
			assertFalse(keysOf(json).contains(forbidden), "allowlist 밖 컬럼이 스풀 파일에 실렸다: " + forbidden);
		}
		assertFalse(json.contains("SECRET-SESSION"), "세션 토큰 값이 스풀 파일에 실렸다");
		assertFalse(json.contains("내부코멘트"), "내부 코멘트 값이 스풀 파일에 실렸다");
	}

	/** 3번 — pick 의미론: 값이 null이면 <b>키 자체가 빠진다</b>(API 투영의 NULL 키 보존과 정반대다). */
	@Test
	void aNullColumnDropsItsKeyEntirely(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		WriteResult result = writer.write(SPOOL_DIR, ARTICLE_ID, Map.of("markupVersion", "MV"),
				contents(row("articleId", ARTICLE_ID, "title", "제목", "sentAt", null, "department", "", "status",
						"DPS")));

		String json = Files.readString(Path.of(result.file()), StandardCharsets.UTF_8);
		assertEquals(List.of("articleId", "title", "department", "status", "markupVersion", "distributedAt"),
				keysOf(json), "NULL 컬럼(sentAt)은 키가 빠지고 빈 문자열(department)은 값으로 남는다");
	}

	/** 4번 — {@code distributedAt}은 주입 시계 값이다(저장돼 있던 컬럼을 그대로 싣지 않는다). */
	@Test
	void distributedAtComesFromTheInjectedClockAndNotFromTheStoredColumn(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		WriteResult result = writer.write(SPOOL_DIR, ARTICLE_ID, Map.of(),
				contents(row("articleId", ARTICLE_ID, "distributedAt", "2000-01-01T00:00:00.000Z")));

		String json = Files.readString(Path.of(result.file()), StandardCharsets.UTF_8);
		assertTrue(json.contains("\"distributedAt\":\"2026-07-28T01:02:03.456Z\""), json);
		assertFalse(json.contains("2000-01-01"), "저장된 distributedAt이 그대로 실렸다");
	}

	/** 5번 — Contents의 {@code title}이 NULL이면 Article의 제목으로 폴백하고, 그 키는 <b>맨 뒤</b>에 붙는다. */
	@Test
	void theTitleFallsBackToTheArticleRow(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		WriteResult result = writer.write(SPOOL_DIR, "A1", row("markupVersion", "MV", "title", "아티클제목"),
				contents(row("articleId", "A1", "title", null, "status", "DPS")));

		String json = Files.readString(Path.of(result.file()), StandardCharsets.UTF_8);
		assertEquals(List.of("articleId", "status", "markupVersion", "title", "distributedAt"), keysOf(json));
		assertTrue(json.contains("\"title\":\"아티클제목\""), json);
	}

	/**
	 * 5번 보강 — Node는 폴백 조건을 {@code article.title !== undefined}로 본다. Article 행은 컬럼이 NULL이어도
	 * <b>키가 있으므로</b> {@code "title":null}이 실린다({@code Map.get}만으로 판정하면 이 키가 사라진다).
	 */
	@Test
	void aNullArticleTitleIsStillCarriedAsAnExplicitNull(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		WriteResult result = writer.write(SPOOL_DIR, "A1", row("markupVersion", "MV", "title", null),
				contents(row("title", null)));

		String json = Files.readString(Path.of(result.file()), StandardCharsets.UTF_8);
		assertEquals("{\"markupVersion\":\"MV\",\"articleId\":\"A1\",\"title\":null,"
				+ "\"distributedAt\":\"2026-07-28T01:02:03.456Z\"}", json, "Node 실측과 갈렸다");
	}

	/** 5번 보강 — Contents의 제목이 <b>빈 문자열</b>이면 그것이 값이다(폴백하지 않는다 — Node 실측). */
	@Test
	void anEmptyContentsTitleIsNotReplacedByTheArticleTitle(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		WriteResult result = writer.write(SPOOL_DIR, "A1", row("markupVersion", "MV", "title", "아티클제목"),
				contents(row("articleId", "A1", "title", "", "status", "DPS")));

		String json = Files.readString(Path.of(result.file()), StandardCharsets.UTF_8);
		assertTrue(json.contains("\"title\":\"\""), json);
		assertFalse(json.contains("아티클제목"), "빈 제목이 Article 제목으로 덮였다");
	}

	/** {@code articleId}는 저장 컬럼이 아니라 <b>인자</b>가 정본이고, 첫 등장 자리를 유지한다. */
	@Test
	void theArticleIdArgumentOverwritesTheStoredColumnInPlace(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		WriteResult result = writer.write(SPOOL_DIR, "A1", Map.of(),
				contents(row("articleId", "STALE", "status", "DPS")));

		String json = Files.readString(Path.of(result.file()), StandardCharsets.UTF_8);
		assertEquals("{\"articleId\":\"A1\",\"status\":\"DPS\",\"distributedAt\":\"2026-07-28T01:02:03.456Z\"}", json);
	}

	// --- 거부 경로(파일시스템 무접촉) -----------------------------------------------------------

	/** 6번 — 저장된 값이라도 재검증한다. 거부는 <b>디렉토리조차 만들지 않는다</b>. */
	@Test
	void anInvalidSpoolDirIsRejectedWithoutTouchingTheFilesystem(@TempDir Path root) {
		List<String> rejected = Arrays.asList("Recv1", "../x", "a/b", "a\\b", "con", "nul", " recv1", "recv1 ", "",
				null, "a".repeat(65), "-recv1", "recv/../..");

		for (String bad : rejected) {
			RecordingFs fs = new RecordingFs();
			SpoolWriter writer = new SpoolWriter(root, fixedClock(), fs);

			WriteResult result = writer.write(bad, ARTICLE_ID, Map.of(), contents(row()));

			assertFalse(result.ok(), "거부돼야 한다: " + bad);
			assertEquals("invalid-spool-dir", result.reason(), "spoolDir=" + bad);
			assertNull(result.file(), "거부 결과에 경로가 실리면 안 된다");
			assertEquals(List.of(), fs.calls, "거부인데 파일 연산을 했다: " + bad);
		}
		assertEquals(List.of(), entriesUnder(root), "거부 경로가 루트 아래에 무언가를 만들었다");
	}

	/**
	 * 6번(실물 FS) — 경로 조작의 실체를 <b>파일시스템 관측</b>으로 잠근다. 재검증을 빼면 이 입력이
	 * {@code root.resolve("../outside")}로 접혀 <b>스풀 루트 밖</b>에 파일이 생긴다(가짜 fs로는 그 사실이
	 * 보이지 않는다 — 그래서 여기만 실제 디렉토리를 쓴다).
	 */
	@Test
	void aTraversingSpoolDirCannotCreateAnythingOutsideTheRoot(@TempDir Path sandbox) throws IOException {
		Path root = Files.createDirectory(sandbox.resolve("root"));
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		for (String traversal : List.of("../outside", "..", "../../outside", "sub/../../outside")) {
			WriteResult result = writer.write(traversal, ARTICLE_ID, Map.of(), contents(row()));

			assertFalse(result.ok(), traversal);
			assertEquals("invalid-spool-dir", result.reason(), traversal);
		}
		assertEquals(List.of(root), entriesUnder(sandbox), "스풀 루트 밖에 무언가가 생겼다 — 경로 조작이 통과했다");
	}

	/** 6번 — 슬러그 규칙은 {@link SpoolDir} 한 벌뿐이다(복제하면 한쪽이 경로 조작을 통과시킨다). */
	@Test
	void theSpoolDirRuleIsTheSharedSanitizer(@TempDir Path root) {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		for (String value : List.of("recv1", "a", "a-b_c", "0", "a".repeat(64))) {
			assertEquals(value, SpoolDir.sanitizeSpoolDir(value), "전제 확인");
			assertTrue(writer.write(value, "A1", Map.of(), contents(row())).ok(), value);
		}
	}

	/** 7번 — {@code articleId}는 파일명에 합성되므로 화이트리스트 밖은 즉시 거부다. */
	@Test
	void anInvalidArticleIdIsRejectedWithoutTouchingTheFilesystem(@TempDir Path root) {
		List<String> rejected = Arrays.asList("A 1", "../x", "a/b", "a\\b", "a.b", "a".repeat(65), "", null, "A\tB",
				"한글", "a:b");

		for (String bad : rejected) {
			RecordingFs fs = new RecordingFs();
			SpoolWriter writer = new SpoolWriter(root, fixedClock(), fs);

			WriteResult result = writer.write(SPOOL_DIR, bad, Map.of(), contents(row()));

			assertFalse(result.ok(), "거부돼야 한다: " + bad);
			assertEquals("invalid-article-id", result.reason(), "articleId=" + bad);
			assertNull(result.file());
			assertEquals(List.of(), fs.calls, "거부인데 파일 연산을 했다: " + bad);
		}
		assertEquals(List.of(), entriesUnder(root), "거부 경로가 루트 아래에 무언가를 만들었다");
		assertTrue(new SpoolWriter(root, fixedClock()).write(SPOOL_DIR, "a".repeat(64), Map.of(), contents(row())).ok(),
				"64자는 경계 안이다");
	}

	/** 8번 — 스풀 루트 미설정은 배부 전면 비활성이다(기본값을 추정해 어딘가에 쓰지 않는다). */
	@Test
	void aMissingSpoolRootDisablesWritingEntirely(@TempDir Path root) {
		RecordingFs fs = new RecordingFs();
		SpoolWriter writer = new SpoolWriter(null, fixedClock(), fs);

		WriteResult result = writer.write(SPOOL_DIR, ARTICLE_ID, Map.of(), contents(row()));

		assertFalse(result.ok());
		assertEquals("spool-disabled", result.reason());
		assertNull(result.file());
		assertEquals(List.of(), fs.calls, "루트가 없는데 파일 연산을 시도했다");
		assertEquals(List.of(), entriesUnder(root));
	}

	// --- 실패 보고(throw 0) ----------------------------------------------------------------------

	/** 9번 — 쓰기 실패는 고정 토큰이고 <b>예외가 밖으로 나가지 않는다</b>(한 수신처 실패가 송고를 막으면 안 된다). */
	@Test
	void everyFilesystemFailureIsReportedAsSpoolWriteFailed(@TempDir Path root) {
		for (String failOn : List.of("createDirectories", "write", "moveAtomically")) {
			RecordingFs fs = new RecordingFs(failOn);
			SpoolWriter writer = new SpoolWriter(root, fixedClock(), fs);

			WriteResult result = assertDoesNotThrow(
					() -> writer.write(SPOOL_DIR, ARTICLE_ID, Map.of(), contents(row())), failOn + " 실패가 던져졌다");

			assertFalse(result.ok(), failOn);
			assertEquals("spool-write-failed", result.reason(), failOn);
			assertNull(result.file(), "실패 결과에 경로가 실리면 안 된다");
		}
	}

	/** 9번(실물 FS) — 대상 디렉토리 자리에 같은 이름의 <b>파일</b>이 있으면 게시는 실패로 보고된다. */
	@Test
	void aBlockedTargetDirectoryIsReportedAndNotThrown(@TempDir Path root) throws IOException {
		Files.createFile(root.resolve(SPOOL_DIR));
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		WriteResult result = assertDoesNotThrow(
				() -> writer.write(SPOOL_DIR, ARTICLE_ID, Map.of(), contents(row())));

		assertFalse(result.ok());
		assertEquals("spool-write-failed", result.reason());
		assertNull(result.file());
	}

	// --- 인코딩·게시 순서·재기록 -----------------------------------------------------------------

	/** 10번 — 내용은 UTF-8이다(플랫폼 기본 인코딩에 맡기면 수신처가 깨진 한글을 받는다). */
	@Test
	void koreanTextIsWrittenAsUtf8Bytes(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());
		String title = "한글 제목 — 편집부 기사";

		WriteResult result = writer.write(SPOOL_DIR, "A1", Map.of(),
				contents(row("articleId", "A1", "title", title)));

		byte[] actual = Files.readAllBytes(Path.of(result.file()));
		String expected = "{\"articleId\":\"A1\",\"title\":\"" + title
				+ "\",\"distributedAt\":\"2026-07-28T01:02:03.456Z\"}";
		assertArrayEquals(expected.getBytes(StandardCharsets.UTF_8), actual, "UTF-8 바이트가 아니다");
		assertEquals(expected, new String(actual, StandardCharsets.UTF_8));
		if (Charset.isSupported("windows-949")) {
			assertFalse(Arrays.equals(expected.getBytes(Charset.forName("windows-949")), actual),
					"완성형(MS949) 바이트로 기록됐다");
		}
	}

	/**
	 * 13번 — <b>원자 게시의 형태</b>를 잠근다. 결과 파일만 보면 최종 경로 직접 쓰기와 구별되지 않으므로
	 * (그 변이는 1번을 통과한다) 호출 <b>순서</b>를 seam으로 관찰한다.
	 */
	@Test
	void theAtomicPublishSequenceIsTempWriteThenAtomicMove(@TempDir Path root) {
		RecordingFs fs = new RecordingFs();
		SpoolWriter writer = new SpoolWriter(root, fixedClock(), fs);

		writer.write(SPOOL_DIR, ARTICLE_ID, Map.of(), contents(row()));

		Path dir = root.resolve(SPOOL_DIR);
		String name = ARTICLE_ID + "_" + STAMP + ".json";
		Path tmp = dir.resolve("." + name + ".tmp");
		Path target = dir.resolve(name);
		assertEquals(List.of("createDirectories " + dir, "write " + tmp, "moveAtomically " + tmp + " -> " + target),
				fs.calls, "임시 파일에 쓰고 원자 이동한다 — 최종 경로에 직접 쓰면 외부 전송기가 부분 파일을 집어간다");
		assertFalse(fs.calls.contains("write " + target), "최종 경로에 직접 썼다");
	}

	/** 11번 — 스탬프가 다르면 파일이 2개다(덮어쓰기가 아니다). */
	@Test
	void twoWritesAtDifferentInstantsPublishTwoFiles(@TempDir Path root) {
		Clock advancing = new Clock() {
			private int calls;

			@Override
			public ZoneOffset getZone() {
				return ZoneOffset.UTC;
			}

			@Override
			public Clock withZone(java.time.ZoneId zone) {
				return this;
			}

			@Override
			public Instant instant() {
				return FIXED.plusMillis(this.calls++);
			}
		};
		SpoolWriter writer = new SpoolWriter(root, advancing);

		WriteResult first = writer.write(SPOOL_DIR, ARTICLE_ID, Map.of(), contents(row()));
		WriteResult second = writer.write(SPOOL_DIR, ARTICLE_ID, Map.of(), contents(row()));

		assertFalse(first.file().equals(second.file()), "스탬프가 다르면 파일명도 다르다");
		assertEquals(2, filesUnder(root).size());
	}

	/**
	 * 11번 — 시계가 고정되면 파일명이 같아져 <b>덮어쓴다</b>. Node도 같다(2026-08-25 실측: 같은 now()로 두 번
	 * 쓰면 파일 1개) — open_questions (e)의 기본 결정(Node 동형)을 여기 못 박는다. 접미사를 붙여 회피하면
	 * 두 서버의 스풀 산출물이 갈린다.
	 */
	@Test
	void twoWritesAtTheSameInstantOverwriteTheSameFile(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());

		WriteResult first = writer.write(SPOOL_DIR, ARTICLE_ID, Map.of(), contents(row("status", "DES")));
		WriteResult second = writer.write(SPOOL_DIR, ARTICLE_ID, Map.of(), contents(row("status", "DPS")));

		assertEquals(first.file(), second.file());
		assertEquals(1, filesUnder(root).size(), "같은 밀리초 재기록은 Node와 같이 덮어쓴다");
		assertTrue(Files.readString(Path.of(second.file()), StandardCharsets.UTF_8).contains("\"status\":\"DPS\""));
	}

	// --- Node와 바이트 동일 -----------------------------------------------------------------------

	/**
	 * 14번 — 스풀 파일은 <b>외부 전송기가 읽는 산출물</b>이라 키 순서만으로는 부족하다. 이스케이프 정책과
	 * 수치 표기의 차이는 HTTP를 타지 않아 계약에도 {@code --parity}에도 <b>영원히 보이지 않는다</b>.
	 *
	 * <p>기대값은 2026-08-25 Node {@code createSpoolWriter} 실측 산출 <b>634바이트</b>를 그대로 옮긴 것이다
	 * (전사 오류를 막으려고 스크립트로 Java 표현식을 생성했다). 한글·이모지·U+2028/U+2029는 {@code
	 * JSON.stringify}가 escape하지 않고 그대로 싣는다.
	 */
	@Test
	void thePayloadIsByteIdenticalToTheNodeWriter(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());
		String title = "한글 \"따옴표\" \\역슬래시\\ 줄바꿈\n<script>alert(1)</script> 이모지🚀 U+2028"
				+ (char) 0x2028 + " U+2029" + (char) 0x2029 + " &amp; 탭\t";
		Map<String, Object> columns = row("articleId", ARTICLE_ID, "title", title, "author", "김기자", "coAuthor", null,
				"department", "편집부", "departmentCode", "D-01", "category", "정치", "region", "서울", "attribute", "일반",
				"keyword", "키워드1,키워드2", "externalComment", "외부코멘트", "attachmentFile", "photo_01.jpg",
				"referenceFile", null, "createdAt", "2026-07-01T00:00:00.000Z", "sentAt", "2026-07-02T03:04:05.678Z",
				"embargoAt", null, "secondEmbargoAt", "2026-07-30T09:00:00.000Z", "status", "DPS", "internalComment",
				"내부", "lockerSessionId", "SECRET");

		WriteResult result = writer.write(SPOOL_DIR, ARTICLE_ID,
				row("markupVersion", "{\"blocks\":[{\"text\":\"본문 <b>&</b>\"}]}"), contents(columns));

		String expected = "{\"articleId\":\"AKR20260728001\",\"title\":\"한글 \\\"따옴표\\\" \\\\역슬래시\\\\ 줄바꿈"
				+ "\\n<script>alert(1)</script> 이모지🚀 U+2028"
				+ (char) 0x2028
				+ " U+2029"
				+ (char) 0x2029
				+ " &amp; 탭\\t\",\"author\":\"김기자\",\"department\":\"편집부\",\"departmentCode\":\"D-01\","
				+ "\"category\":\"정치\",\"region\":\"서울\",\"attribute\":\"일반\",\"keyword\":\"키워드1,키워드2\","
				+ "\"externalComment\":\"외부코멘트\",\"attachmentFile\":\"photo_01.jpg\","
				+ "\"createdAt\":\"2026-07-01T00:00:00.000Z\",\"sentAt\":\"2026-07-02T03:04:05.678Z\","
				+ "\"secondEmbargoAt\":\"2026-07-30T09:00:00.000Z\",\"status\":\"DPS\","
				+ "\"markupVersion\":\"{\\\"blocks\\\":[{\\\"text\\\":\\\"본문 <b>&</b>\\\"}]}\","
				+ "\"distributedAt\":\"2026-07-28T01:02:03.456Z\"}";
		byte[] actual = Files.readAllBytes(Path.of(result.file()));
		assertEquals(634, expected.getBytes(StandardCharsets.UTF_8).length, "Node 실측 바이트 수와 기대값이 갈렸다");
		assertArrayEquals(expected.getBytes(StandardCharsets.UTF_8), actual,
				"Node JSON.stringify와 바이트가 갈렸다: " + new String(actual, StandardCharsets.UTF_8));
	}

	/**
	 * 14번 — 제어문자의 {@code \\u00XX} 16진수는 <b>소문자</b>다({@code JSON.stringify}). Jackson 기본값만
	 * 대문자라 그대로 두면 갈린다(phase 71a {@code CollectionMarkup}에서 같은 divergence가 실측됐다).
	 * {@code U+007F}(DEL)와 비ASCII는 양쪽 다 escape하지 않는다.
	 */
	@Test
	void controlCharactersAreEscapedExactlyLikeJsonStringify(@TempDir Path root) throws IOException {
		SpoolWriter writer = new SpoolWriter(root, fixedClock());
		StringBuilder title = new StringBuilder("ctrl ");
		for (int code : new int[] { 0x00, 0x01, 0x08, 0x0B, 0x0C, 0x0E, 0x0F, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F,
				0x7F }) {
			title.append((char) code);
		}
		title.append(" end");

		WriteResult result = writer.write(SPOOL_DIR, "A1", row("markupVersion", "MV"),
				contents(row("articleId", "A1", "title", title.toString(), "status", "DPS")));

		String expected = "{\"articleId\":\"A1\",\"title\":\"ctrl "
				+ "\\u0000\\u0001\\b\\u000b\\f\\u000e\\u000f\\u001a\\u001b\\u001c\\u001d\\u001e\\u001f"
				+ (char) 0x7F
				+ " end\",\"status\":\"DPS\",\"markupVersion\":\"MV\","
				+ "\"distributedAt\":\"2026-07-28T01:02:03.456Z\"}";
		byte[] actual = Files.readAllBytes(Path.of(result.file()));
		assertEquals(188, expected.getBytes(StandardCharsets.UTF_8).length, "Node 실측 바이트 수와 기대값이 갈렸다");
		assertArrayEquals(expected.getBytes(StandardCharsets.UTF_8), actual,
				"제어문자 이스케이프가 Node와 갈렸다: " + new String(actual, StandardCharsets.UTF_8));
	}

	// --- 고정 토큰 --------------------------------------------------------------------------------

	/** 사유는 고정 토큰 4종뿐이다 — 예외 메시지를 실으면 tick 응답으로 경로가 새어 나간다. */
	@Test
	void theFailureReasonsAreFixedTokens() {
		assertEquals("spool-disabled", SpoolWriter.SPOOL_DISABLED);
		assertEquals("invalid-spool-dir", SpoolWriter.INVALID_SPOOL_DIR);
		assertEquals("invalid-article-id", SpoolWriter.INVALID_ARTICLE_ID);
		assertEquals("spool-write-failed", SpoolWriter.SPOOL_WRITE_FAILED);
	}

	// --- 픽스처 ------------------------------------------------------------------------------------

	/** Node 실측 [1]과 같은 입력 — 전 컬럼(잠금·내부코멘트 포함)을 담은 Contents 행. */
	private static Map<String, Object> fullContents() {
		return row("articleId", ARTICLE_ID, "title", "제목", "author", "기자", "coAuthor", null, "department", "",
				"departmentCode", "D1", "category", "C", "region", "R", "attribute", "A", "keyword", "K",
				"externalComment", "EC", "internalComment", "내부코멘트", "attachmentFile", "a.jpg", "referenceFile", null,
				"content", "평문본문", "createdAt", "2026-07-01T00:00:00.000Z", "sentAt", null, "editedAt",
				"2026-07-02T00:00:00.000Z", "modifier", "M", "sender", "S", "embargoAt", "2026-07-30T00:00:00.000Z",
				"secondEmbargoAt", null, "status", "DPS", "distributedAt", "2000-01-01T00:00:00.000Z", "lockYN", "Y",
				"lockerUserId", "u1", "lockerSessionId", "SECRET-SESSION", "lockerClientId", "c1", "lockedAt",
				"2026-07-02T00:00:00.000Z");
	}

	private static Map<String, Object> fullArticle() {
		return row("articleId", ARTICLE_ID, "title", "아티클제목", "content", "평문", "markupVersion", "{\"blocks\":[]}",
				"modifier", "M");
	}

}
