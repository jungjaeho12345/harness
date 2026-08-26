package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/**
 * 배부 스풀 루트 설정({@code app.distribution.spool-dir}) — <b>미설정이면 배부가 전면 비활성</b>이고
 * 기본값을 하드코딩하지 않는다(ADR-008 · decisions (3)).
 *
 * <p>왜 {@link AppProperties}에 넣지 않는가: 그 record의 생성자 호출부가 테스트 9곳이라 필드를 더하면 무관한
 * 두 파일이 함께 바뀐다({@link CollectionProperties}가 같은 이유로 분리돼 있다).
 *
 * <p>이 클래스는 <b>경로 문자열만</b> 다룬다 — 디렉토리 생성·존재 확인은 {@code SpoolWriter}가 쓰기 직전에
 * 한다. 여기서 파일시스템을 만지면 {@code Adr008DisciplineTest}의 4군(파일 쓰기)이 red다(이 파일은 그
 * 예외가 아니다). 부팅 시점 생성은 미설정 환경에서 의도치 않은 디렉토리를 만든다.
 */
class SpoolPropertiesTest {

	private static final Path PROPERTIES = Path.of("src", "main", "resources", "application.properties");

	@Test
	void aBlankValueMeansThereIsNoSpoolRoot() {
		for (String blank : List.of("", " ", "\t", "\n", "   ")) {
			SpoolProperties properties = new SpoolProperties(blank);

			assertEquals(Optional.empty(), properties.rootPath(), "공백만 있는 값은 미설정이다: [" + blank + "]");
			assertFalse(properties.enabled(), "[" + blank + "]");
		}
	}

	@Test
	void aMissingValueMeansThereIsNoSpoolRoot() {
		SpoolProperties properties = new SpoolProperties(null);

		assertEquals(Optional.empty(), properties.rootPath());
		assertFalse(properties.enabled());
		assertEquals("", properties.spoolDir(), "미설정은 빈 문자열로 수렴한다(null 전파 금지)");
	}

	@Test
	void aConfiguredValueBecomesTheSpoolRoot() {
		SpoolProperties properties = new SpoolProperties("  D:/spool/out  ");

		assertEquals(Optional.of(Path.of("D:/spool/out")), properties.rootPath());
		assertTrue(properties.enabled());
	}

	/**
	 * 판정 지점은 <b>하나</b>다 — tick과 retry가 같은 값을 본다. 두 곳으로 갈라지면 503 조건이 어긋난다.
	 */
	@Test
	void theRootIsNeverGuessedFromTheWorkingDirectory() {
		SpoolProperties properties = new SpoolProperties("");

		assertEquals(Optional.empty(), properties.rootPath(),
				"cwd·DATA_DIR 하위를 추정하면 미설정 환경에서 의도치 않은 파일 쓰기가 생긴다");
	}

	/**
	 * <b>파일시스템이 파싱조차 못 하는 값</b>도 미설정으로 수렴한다(2026-08-26 ⑤ 코드리뷰 반려 폐색).
	 *
	 * <p>{@code Path.of}는 {@link InvalidPathException}(unchecked)을 던진다. 그 예외가
	 * {@code DistributionConfig.spoolWriter} {@code @Bean} 안에서 새면 <b>컨텍스트 기동 실패 = 32 라우트
	 * 전멸</b>이고, {@code .env}에 따옴표 한 쌍이 들어간 배포가 <b>로그인부터</b> 죽는다. Node는 경로를
	 * 파싱하지 않으므로 같은 값에서 서버가 정상 기동하고 <b>배부만</b> 실패한다 — 여기서 수렴시키는 방향이
	 * 그 동작과 같다(배부만 비활성).
	 *
	 * <p>목록은 JDK21/Windows 실측값이라 플랫폼마다 거부 집합이 다르다. 그래서 <b>이 플랫폼이 실제로
	 * 거부한 값</b>에만 단언하고, 하나도 없으면 그 사실 자체를 red로 만든다(공허한 green 금지).
	 */
	@Test
	void aPathTheFilesystemCannotParseMeansThereIsNoSpoolRoot() {
		int rejectedHere = 0;
		for (String broken : List.of("\"C:\\spool\"", "C:\\spool?", "C:\\sp*ool", "C:/spool/na\0me")) {
			SpoolProperties properties = new SpoolProperties(broken);

			Optional<Path> root = assertDoesNotThrow(properties::rootPath,
					"rootPath()는 어떤 값에도 던지지 않는다 — 빈 생성이 죽으면 전 라우트가 전멸한다");
			assertEquals(root.isPresent(), properties.enabled(),
					"판정 지점은 하나다 — enabled()와 rootPath()가 갈리면 안 된다: [" + broken + "]");
			if (unparsableHere(broken)) {
				rejectedHere++;
				assertEquals(Optional.empty(), root, "파싱 불가 경로는 미설정이다: [" + broken + "]");
			}
		}

		assertTrue(rejectedHere > 0,
				"비공허성 — 이 플랫폼에서 Path.of가 거부한 값이 하나도 없어 단언이 아무것도 검사하지 않았다");
	}

	/**
	 * 파싱 불가를 <b>무음</b>으로 삼키지 않는다(운영이 배부가 꺼진 줄 모른다). 다만 경고 줄에 <b>경로
	 * 문자열을 싣지 않는다</b> — 이 phase의 정보 누출 규율이다(사유·경로는 응답도 로그도 타지 않는다).
	 */
	@Test
	void theWarningNeverCarriesTheOffendingPathString() {
		String secret = "\"D:\\spool-cluster-7\"";
		ch.qos.logback.classic.Logger logger =
				(ch.qos.logback.classic.Logger) LoggerFactory.getLogger(SpoolProperties.class);
		ListAppender<ILoggingEvent> recorded = new ListAppender<>();
		recorded.start();
		logger.addAppender(recorded);
		try {
			SpoolProperties properties = new SpoolProperties(secret);
			Optional<Path> root = properties.rootPath();

			if (!unparsableHere(secret)) {
				return; // 이 플랫폼은 이 값을 파싱한다 — 경고 자체가 없다(위 테스트가 비공허성을 지킨다).
			}
			assertEquals(Optional.empty(), root);
			assertEquals(1, recorded.list.size(), "파싱 불가는 경고 1줄로 표면화된다(무음 금지)");
			String line = recorded.list.get(0).getFormattedMessage();
			assertFalse(line.contains("spool-cluster-7"), "경고에 경로 문자열이 실렸다: " + line);
			assertFalse(line.contains(secret), "경고에 경로 문자열이 실렸다: " + line);
		}
		finally {
			logger.detachAppender(recorded);
		}
	}

	/** 이 플랫폼의 {@link Path#of}가 <b>실제로</b> 거부하는 값인가(윈도우와 유닉스의 거부 집합이 다르다). */
	private static boolean unparsableHere(String value) {
		try {
			Path.of(value);
			return false;
		}
		catch (InvalidPathException ex) {
			return true;
		}
	}

	/**
	 * 설정 키는 환경변수에서만 온다 — {@code application.properties}에 절대경로 기본값이 박히면 계약 하네스가
	 * 프로파일별 임시 스풀을 주입할 수 없고, 미설정 배포가 조용히 어딘가에 파일을 쓴다.
	 */
	@Test
	void thePropertyHasNoHardcodedDefault() throws IOException {
		String text = Files.readString(PROPERTIES, StandardCharsets.UTF_8);

		assertTrue(text.contains("app.distribution.spool-dir=${DIST_SPOOL_DIR:}"),
				"app.distribution.spool-dir 은 DIST_SPOOL_DIR 에서만 오고 기본값이 없어야 한다: " + text);
	}

}
