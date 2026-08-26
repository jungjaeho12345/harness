package harness.news.service;

import harness.news.model.ContentsRow;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import tools.jackson.core.SerializableString;
import tools.jackson.core.io.CharacterEscapes;
import tools.jackson.core.io.SerializedString;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * 배부 스풀 writer — ADR-008 (1) 파일 스풀 outbound. 리포 루트 {@code src/services/spoolWriter.js}와 1:1이다.
 *
 * <p>앱은 배부 스풀 루트 아래 수신처별 하위 폴더에 기사 파일(JSON, {@code markupVersion} 포함)을
 * <b>쓰기만</b> 한다. 실제 발송은 외부 전송기가 담당한다 — 이 클래스에는 네트워크 egress도 타이머도 없다.
 * <b>이 서버에서 파일을 쓰는 자리는 여기 하나뿐</b>이며({@code Adr008DisciplineTest} 4군의 유일한 예외)
 * 그 예외는 <b>경로까지</b> 고정이다({@code harness/news/service/SpoolWriter.java}).
 *
 * <p>이 클래스가 단일 출처로 소유하는 것:
 * <ol>
 *   <li>외부로 나가는 파일의 shape(<b>필드 allowlist 20키</b>) — 호출자가 페이로드를 조립하지 않는다.</li>
 *   <li>경로 합성 안전성({@code spoolDir} 슬러그 <b>재검증</b> + {@code articleId} 화이트리스트).</li>
 *   <li>원자적 게시(같은 디렉토리의 임시 파일 → 원자 이동).</li>
 * </ol>
 *
 * <p>파일 연산 3종은 <b>주입 가능</b>하다({@link SpoolFs}). 결과 파일만 보면 "임시 파일에 쓰고 옮겼다"와
 * "최종 경로에 직접 썼다"가 구별되지 않기 때문에, 게시 <b>순서 자체</b>를 관찰할 수 있어야 한다
 * ({@code SpoolWriterTest.theAtomicPublishSequenceIsTempWriteThenAtomicMove}). 구현체는 이 파일 안에 둔다 —
 * 별도 main 파일로 빼면 그 파일이 새로운 파일 쓰기 지점이 되어 ADR-008 예외가 3개가 된다.
 *
 * <p><b>throw하지 않는다.</b> 모든 실패는 고정 토큰의 {@link WriteResult}다 — 한 수신처의 실패가 다른
 * 수신처나 송고(상태 전이)를 막아서는 안 된다. 사유에 예외 메시지·경로를 담지 않는다(tick 응답의 경로 유출
 * 차단이 계약이다).
 */
public final class SpoolWriter {

	/** 스풀 루트 미설정 = 배부 전면 비활성. */
	public static final String SPOOL_DISABLED = "spool-disabled";

	/** 저장된 {@code spoolDir}가 슬러그 규칙을 통과하지 못했다. */
	public static final String INVALID_SPOOL_DIR = "invalid-spool-dir";

	/** {@code articleId}가 파일명 화이트리스트 밖이다. */
	public static final String INVALID_ARTICLE_ID = "invalid-article-id";

	/** 디렉토리 생성·임시 파일 쓰기·원자 이동 중 하나가 실패했다. */
	public static final String SPOOL_WRITE_FAILED = "spool-write-failed";

	/**
	 * 파일명에 합성되는 값이므로 경로 구분자·{@code ..}·공백을 원천 차단한다
	 * ({@code articleId} 생성 규칙은 {@code 'AKR'} + {@code YYYYMMDD} + 난수 9자리).
	 */
	private static final Pattern ARTICLE_ID = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");

	/** ISO-8601을 파일명 안전한 compact 형태로 바꾸는 제거 대상: {@code -} {@code :} {@code .}. */
	private static final Pattern STAMP_PUNCTUATION = Pattern.compile("[-:.]");

	/**
	 * 외부 수신처로 나가는 필드 allowlist(<b>블랙리스트가 아니다</b>) — 새 컬럼이 추가돼도 기본값은
	 * "미노출"이다. {@code internalComment}(내부코멘트)와 편집 잠금 컬럼({@code lockYN}/{@code locker*}/
	 * {@code lockedAt})은 <b>의도적으로</b> 제외한다: 전자는 사내 전용이고 후자에는 유효 세션 토큰이 들어 있다.
	 */
	private static final List<String> CONTENTS_FIELDS = List.of(
			"articleId", "title", "author", "coAuthor", "department", "departmentCode",
			"category", "region", "attribute", "keyword", "externalComment",
			"attachmentFile", "referenceFile", "createdAt", "sentAt",
			"embargoAt", "secondEmbargoAt", "status");

	/** 본문 마크업은 Article 행에서 가져온다(ADR-008이 요구하는 필수 항목). */
	private static final List<String> ARTICLE_FIELDS = List.of("markupVersion");

	/** 저장 컬럼이 아니라 <b>인자</b>가 정본인 키. */
	private static final String ARTICLE_ID_KEY = "articleId";

	/** Contents 우선 · Article 폴백인 키. */
	private static final String TITLE_KEY = "title";

	/**
	 * 스풀 파일 <b>전용</b> 매퍼 — 공백 없음 · 비ASCII 그대로이고, {@code \\u00XX} 16진수만
	 * {@link LowercaseHexEscapes 소문자}로 바꿔 Node {@code JSON.stringify}와 <b>바이트 동일</b>하게 만든다.
	 *
	 * <p>스풀 파일은 <b>외부 전송기가 읽는 산출물</b>인데 HTTP를 타지 않아 계약도 {@code --parity}도 그
	 * 바이트를 보지 못한다 — 그래서 대조는 {@code SpoolWriterTest}의 바이트 단언이 유일한 방어선이다.
	 * {@code JsonHttp}의 와이어 매퍼와 완전히 별개다(전역 매퍼를 건드리면 계약 236관측이 통째로 걸린다).
	 */
	private static final ObjectMapper MAPPER = JsonMapper
			.builder(JsonFactory.builder().characterEscapes(new LowercaseHexEscapes()).build()).build();

	/** 스풀 루트. {@code null}이면 배부 비활성이다(기본값을 추정하지 않는다 — {@code SpoolProperties}). */
	private final Path rootDir;

	private final Clock clock;

	private final SpoolFs fs;

	public SpoolWriter(Path rootDir, Clock clock) {
		this(rootDir, clock, new RealSpoolFs());
	}

	/**
	 * 파일 연산 seam 주입 — 테스트가 게시 <b>순서</b>와 실패 경로를 관찰하기 위한 것이라 빈으로 노출하지
	 * 않는다(패키지 한정 — {@code ArticleRepository}의 난수원 seam과 같은 규율).
	 */
	SpoolWriter(Path rootDir, Clock clock, SpoolFs fs) {
		this.rootDir = rootDir;
		this.clock = clock;
		this.fs = fs;
	}

	/**
	 * 기사 1건을 수신처 1곳의 스풀 폴더에 쓴다.
	 *
	 * @param spoolDir 수신처 하위 폴더명. <b>DB에 저장된 값이라도 재검증한다</b> — 경로 합성 직전이 마지막
	 * 방어 지점이다
	 * @param articleId 기사 식별자. 파일명에 합성되므로 화이트리스트 밖은 거부다
	 * @param article {@code Article} 행(평범한 컬럼 맵). {@code null} 허용
	 * @param contents {@code Contents} 행. {@code null} 허용이며 컬럼 접근은 {@link ContentsRow#column(String)}
	 * 하나다(전 컬럼 맵은 그 패키지 밖으로 나오지 않는다)
	 * @return 성공이면 {@code ok=true}와 <b>절대경로</b>, 실패면 {@code ok=false}와 고정 토큰. 절대 throw하지
	 * 않는다
	 */
	public WriteResult write(String spoolDir, String articleId, Map<String, ?> article, ContentsRow contents) {
		if (this.rootDir == null) {
			return WriteResult.failed(SPOOL_DISABLED);
		}
		// 저장된 값이라도 신뢰하지 않는다 — 규칙은 SpoolDir 한 벌뿐이다(복제하면 한쪽이 조작을 통과시킨다).
		String dir = SpoolDir.sanitizeSpoolDir(spoolDir);
		if (dir.isEmpty()) {
			return WriteResult.failed(INVALID_SPOOL_DIR);
		}
		if (articleId == null || !ARTICLE_ID.matcher(articleId).matches()) {
			return WriteResult.failed(INVALID_ARTICLE_ID);
		}

		String stamp = Iso8601.now(this.clock);
		Map<String, Object> payload = payload(articleId, article, contents, stamp);
		Path targetDir = this.rootDir.resolve(dir);
		String name = articleId + "_" + compactStamp(stamp) + ".json";
		Path target = targetDir.resolve(name);
		// 같은 디렉토리 안 임시 파일에 먼저 쓴다 — 외부 전송기가 부분 기록 파일을 집어가지 못하게 한다
		// (수집 watcher가 부분 파일을 읽는 문제의 대칭). 같은 볼륨이라 이동이 원자적이다.
		Path tmp = targetDir.resolve("." + name + ".tmp");

		try {
			byte[] bytes = MAPPER.writeValueAsString(payload).getBytes(StandardCharsets.UTF_8);
			this.fs.createDirectories(targetDir);
			this.fs.write(tmp, bytes);
			this.fs.moveAtomically(tmp, target);
			return WriteResult.written(target.toString());
		}
		catch (IOException | RuntimeException ex) {
			// 발송 실패 재전송은 실패 원장이 소유한다 — 여기서는 결과만 보고한다(예외 메시지 금지: 경로가 실린다).
			return WriteResult.failed(SPOOL_WRITE_FAILED);
		}
	}

	/**
	 * 페이로드 조립 — <b>여기서만</b> 한다. 조립 순서가 곧 파일의 키 순서이고 그것도 산출물이다.
	 *
	 * <p>Contents 18키 → {@code markupVersion} → {@code articleId}(인자가 정본, 첫 등장 자리 유지) →
	 * {@code title} 폴백 → {@code distributedAt}.
	 *
	 * <p><b>pick 의미론</b>: 값이 {@code null}이면 <b>키 자체가 빠진다</b> — API 투영의 "NULL 키 보존"과
	 * 정반대다(두 규칙을 섞지 마라).
	 */
	private static Map<String, Object> payload(String articleId, Map<String, ?> article, ContentsRow contents,
			String stamp) {
		Map<String, Object> payload = new LinkedHashMap<>();
		for (String field : CONTENTS_FIELDS) {
			Object value = (contents == null) ? null : contents.column(field);
			if (value != null) {
				payload.put(field, value);
			}
		}
		for (String field : ARTICLE_FIELDS) {
			Object value = (article == null) ? null : article.get(field);
			if (value != null) {
				payload.put(field, value);
			}
		}
		payload.put(ARTICLE_ID_KEY, articleId);
		// title은 Contents 우선, 없으면 Article로 폴백. Node의 조건은 article.title !== undefined이므로
		// 컬럼이 NULL이어도 "키가 있으면" 실린다("title":null) — Map.get만 보면 그 키가 조용히 사라진다.
		if (!payload.containsKey(TITLE_KEY) && article != null && article.containsKey(TITLE_KEY)) {
			payload.put(TITLE_KEY, article.get(TITLE_KEY));
		}
		// 스풀 기록 시각 = 배부 지시 시각(ADR-008 트레이드오프: 발송 완료가 아니다).
		payload.put("distributedAt", stamp);
		return payload;
	}

	/** {@code 2026-07-28T01:02:03.456Z} → {@code 20260728T010203456Z}. */
	private static String compactStamp(String iso) {
		return STAMP_PUNCTUATION.matcher(iso).replaceAll("");
	}

	/**
	 * 스풀 쓰기 결과 — 성공이면 경로가, 실패면 <b>고정 토큰</b>이 담긴다. 둘이 동시에 담기지 않는다:
	 * 실패 사유는 상위(tick 응답·실패 원장)로 그대로 흐르므로 경로가 붙으면 화이트리스트 투영이 우회된다.
	 *
	 * @param ok 게시 성공 여부
	 * @param reason 실패 사유 고정 토큰(성공이면 {@code null})
	 * @param file 게시된 파일의 절대경로(실패면 {@code null}). <b>호출자는 이 값을 응답·로그로 흘리지 않는다</b>
	 */
	public record WriteResult(boolean ok, String reason, String file) {

		static WriteResult failed(String reason) {
			return new WriteResult(false, reason, null);
		}

		static WriteResult written(String file) {
			return new WriteResult(true, null, file);
		}
	}

	/**
	 * 파일 연산 seam — Node도 {@code mkdir}/{@code writeFile}/{@code rename} 3종을 주입받는다.
	 *
	 * <p>{@link #moveAtomically(Path, Path)}는 <b>원자적</b> 이동이 계약이다. 원자 이동이 불가하면 실패로
	 * 보고하고 <b>일반 move·copy로 폴백하지 않는다</b> — 폴백은 원자성 보장을 조용히 잃고, 그 순간 외부
	 * 전송기가 부분 기록 파일을 집어간다.
	 */
	interface SpoolFs {

		void createDirectories(Path dir) throws IOException;

		void write(Path file, byte[] bytes) throws IOException;

		void moveAtomically(Path source, Path target) throws IOException;

	}

	/** 실제 파일시스템 구현 — 이 파일 안에 둔다(별도 파일로 빼면 ADR-008 예외가 하나 더 생긴다). */
	private static final class RealSpoolFs implements SpoolFs {

		@Override
		public void createDirectories(Path dir) throws IOException {
			Files.createDirectories(dir);
		}

		@Override
		public void write(Path file, byte[] bytes) throws IOException {
			Files.write(file, bytes);
		}

		@Override
		public void moveAtomically(Path source, Path target) throws IOException {
			Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
		}

	}

	/**
	 * {@code \\u00XX} 이스케이프의 16진수를 <b>소문자</b>로 쓴다 — Jackson 기본값만 대문자이기 때문이다
	 * ({@code JSON.stringify}는 소문자다). 갈리는 자리는 9자뿐이다: {@code U+000B} · {@code U+000E} ·
	 * {@code U+000F} · {@code U+001A}~{@code U+001F}. 나머지 제어문자는 짧은 이스케이프({@code \b} {@code \t}
	 * {@code \n} {@code \f} {@code \r})이거나 16진수가 숫자뿐이라 표기가 하나다. {@code U+007F}(DEL)·비ASCII·
	 * 대리 쌍·{@code U+2028}/{@code U+2029}는 양쪽 다 escape하지 않는다(2026-08-25 Node 실측).
	 *
	 * <p><b>{@code CollectionMarkup}의 동명 클래스와 규칙이 같지만 그쪽은 {@code private}</b>이고, 그 파일은
	 * 이 step의 증분이 아니다(71a 산출물). 공용화는 별도 리팩터링 결정이라 여기서 하지 않는다 — 두 자리
	 * 모두 "Node가 만든 문자열과 바이트 동일"을 각자의 테스트로 잠근다.
	 */
	private static final class LowercaseHexEscapes extends CharacterEscapes {

		private static final long serialVersionUID = 1L;

		/** 16진수 letter가 섞이는 제어문자들 — 이 값들만 우리가 쓴다. */
		private static final int[] LOWERCASE_HEX_CHARS = { 0x0B, 0x0E, 0x0F, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F };

		private final int[] escapeCodes;

		private final SerializableString[] sequences = new SerializableString[0x20];

		LowercaseHexEscapes() {
			this.escapeCodes = CharacterEscapes.standardAsciiEscapesForJSON();
			for (int ch : LOWERCASE_HEX_CHARS) {
				this.escapeCodes[ch] = CharacterEscapes.ESCAPE_CUSTOM;
				this.sequences[ch] = new SerializedString(String.format("\\u%04x", ch));
			}
		}

		@Override
		public int[] getEscapeCodesForAscii() {
			// 사본을 준다 — 생성기가 이 배열을 자기 것으로 들고 가므로 원본이 밖에서 변형되면 안 된다.
			return this.escapeCodes.clone();
		}

		@Override
		public SerializableString getEscapeSequence(int ch) {
			// ESCAPE_CUSTOM으로 표시한 9자에만 불린다. 그 밖은 null이고 그때 Jackson이 실패로 알린다.
			return (ch >= 0 && ch < this.sequences.length) ? this.sequences[ch] : null;
		}

	}

}
