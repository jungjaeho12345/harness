package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertFalse;
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
 * 정적 잠금: main 소스는 <b>벽시계를 직접 읽지 않는다</b> — 시각의 출처는 주입된 {@code java.time.Clock}
 * 빈뿐이다(ADR-013 · phase 68 decisions (14) · phase 69 decisions (6)).
 *
 * <p>왜 정적 스캔인가(2026-08-24 변이 실측): 엠바고 판정에 {@code System.currentTimeMillis()}를 끼워 넣는
 * 변이를 심었을 때, red가 난 것은 <b>그 판정의 결과</b>를 보는 행동 테스트 4건뿐이었고 "시계를 직접 읽었다"는
 * 사실 자체를 잡는 게이트는 <b>하나도 없었다</b>. 규칙은 여러 문서와 주석에 적혀 있었지만 기계가 지키지
 * 않았다는 뜻이다. 결과를 보는 테스트가 없는 자리(신규 코드)에 같은 호출이 들어오면 그때는 아무것도
 * 울리지 않는다 — 그러면 그 코드의 시간축은 테스트에서 결정적이지 않게 되고, 그 비결정성은 계약
 * 하네스의 자기 결정성(`--dual-run`) diff로만 뒤늦게 드러난다.
 *
 * <p><b>덮는 벡터</b>: 인자 없는 시각 API 호출({@code System.currentTimeMillis()}·{@code Instant.now()} 등).
 * <b>덮지 못하는 벡터</b>: 시계를 주입받고도 <b>잘못 쓰는</b> 코드(예: 고정 시각 하드코딩)와 리플렉션·문자열
 * 조립으로 만든 호출 — 그것은 각 클래스의 고정 시계 단위 테스트가 잡는다.
 *
 * <p>판정 전에 주석을 지운다. 규칙을 <b>설명하는</b> 문장({@code Iso8601}·{@code AppConfig}의 javadoc)이
 * 위반으로 잡히면 이 게이트는 즉시 무력화될 것이기 때문이다(주석까지 금지하면 규칙을 문서화할 수 없다).
 */
class ClockDisciplineTest {

	private static final Path MAIN_SOURCES = Path.of("src", "main", "java");

	/**
	 * 금지 호출 — 전부 "인자 없는" 형태다. {@code Instant.now(clock)}·{@code LocalDate.now(this.clock)}처럼
	 * <b>시계를 넘기는</b> 호출은 규율에 맞으므로 잡지 않는다.
	 */
	private static final List<Pattern> WALL_CLOCK_CALLS = List.of(
			Pattern.compile("\\bSystem\\s*\\.\\s*currentTimeMillis\\s*\\(\\s*\\)"),
			Pattern.compile("\\bSystem\\s*\\.\\s*nanoTime\\s*\\(\\s*\\)"),
			Pattern.compile("\\bInstant\\s*\\.\\s*now\\s*\\(\\s*\\)"),
			Pattern.compile("\\bLocalDate\\s*\\.\\s*now\\s*\\(\\s*\\)"),
			Pattern.compile("\\bLocalDateTime\\s*\\.\\s*now\\s*\\(\\s*\\)"),
			Pattern.compile("\\bLocalTime\\s*\\.\\s*now\\s*\\(\\s*\\)"),
			Pattern.compile("\\bZonedDateTime\\s*\\.\\s*now\\s*\\(\\s*\\)"),
			Pattern.compile("\\bOffsetDateTime\\s*\\.\\s*now\\s*\\(\\s*\\)"),
			Pattern.compile("\\bnew\\s+java\\.util\\.Date\\s*\\(\\s*\\)"),
			Pattern.compile("\\bnew\\s+Date\\s*\\(\\s*\\)"),
			Pattern.compile("\\bClock\\s*\\.\\s*system(UTC|DefaultZone)?\\s*\\("));

	/**
	 * 예외 1곳 — 프로덕션 {@code Clock} 빈을 만드는 자리다. 시계 자체를 만드는 코드가 시계를 주입받을 수는
	 * 없다. 예외를 <b>파일 단위로 명시</b>해 두는 이유는, 예외가 늘어나는 순간 그 사실이 diff에 보이게
	 * 하기 위해서다.
	 */
	private static final List<String> CLOCK_FACTORY_FILES = List.of("AppConfig.java");

	@Test
	void mainSourcesNeverReadTheWallClockDirectly() throws IOException {
		assertTrue(Files.isDirectory(MAIN_SOURCES),
				"스캔 대상이 없다 — 테스트 작업 디렉토리가 모듈 루트가 아니다: " + MAIN_SOURCES.toAbsolutePath());

		List<String> hits = new ArrayList<>();
		try (Stream<Path> files = Files.walk(MAIN_SOURCES)) {
			for (Path file : files.filter(Files::isRegularFile).toList()) {
				if (CLOCK_FACTORY_FILES.contains(file.getFileName().toString())) {
					continue;
				}
				String code = stripComments(Files.readString(file, StandardCharsets.UTF_8));
				for (Pattern pattern : WALL_CLOCK_CALLS) {
					if (pattern.matcher(code).find()) {
						hits.add(file + " ~ " + pattern.pattern());
					}
				}
			}
		}

		assertTrue(hits.isEmpty(),
				"main 소스가 주입 시계 대신 벽시계를 직접 읽는다(ADR-013): " + hits);
	}

	/** 스캐너가 공허하지 않다는 증거 — 실제 변이와 같은 형태를 심어 잡히는지 확인한다. */
	@Test
	void theScannerDetectsAPlantedWallClockCall() {
		String planted = stripComments("if (at != null && at > System.currentTimeMillis()) { return true; }");

		assertTrue(WALL_CLOCK_CALLS.stream().anyMatch((pattern) -> pattern.matcher(planted).find()),
				"심어 둔 벽시계 호출을 잡지 못한다 — 스캐너가 공허하다: " + planted);
	}

	/** 시계를 <b>넘기는</b> 호출은 규율에 맞다 — 스캔이 넓어져 정상 코드를 막으면 여기서 먼저 깨진다. */
	@Test
	void theScannerAllowsCallsThatTakeTheInjectedClock() {
		String allowed = stripComments("Instant now = Instant.now(this.clock); long ms = this.clock.millis();");

		assertTrue(WALL_CLOCK_CALLS.stream().noneMatch((pattern) -> pattern.matcher(allowed).find()),
				"주입 시계를 넘기는 호출까지 막고 있다: " + allowed);
	}

	/** 주석 제거가 실제로 동작하는지 — 규칙을 설명하는 javadoc이 위반으로 잡히면 안 된다. */
	@Test
	void ruleDocumentationInCommentsIsNotAViolation() {
		String documented = stripComments("""
				/**
				 * {@code System.currentTimeMillis()} 직접 호출은 금지다.
				 */
				// Instant.now() 도 마찬가지다.
				long ms = clock.millis();
				""");

		assertFalse(documented.contains("currentTimeMillis"), "블록 주석이 제거되지 않았다: " + documented);
		assertTrue(WALL_CLOCK_CALLS.stream().noneMatch((pattern) -> pattern.matcher(documented).find()),
				"주석 속 설명이 위반으로 잡힌다 — 그러면 규칙을 문서화할 수 없다: " + documented);
	}

	/**
	 * 블록·줄 주석을 지운다. 문자열 리터럴 안의 {@code //}(예: URL)까지 잘라내지만, 그것은 <b>탐지를 줄이는</b>
	 * 방향이라 오탐(정상 코드 차단)을 만들지 않는다.
	 */
	private static String stripComments(String source) {
		return source.replaceAll("(?s)/\\*.*?\\*/", " ").replaceAll("//[^\\n]*", " ");
	}
}
