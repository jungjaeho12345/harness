package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;

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
