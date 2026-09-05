package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * SPA 루트 판정({@code app.spa-dir}) — Node {@code resolveSpaRoot}/{@code resolveSpaDir}의 동형이며
 * {@code test/spa-serving.test.js}의 <b>F23~F25</b>를 옮긴 것이다.
 *
 * <h2>왜 디렉토리가 아니라 {@code index.html} 파일인가</h2>
 * Node {@code resolveSpaRoot}의 CRITICAL 주석이 이유를 적어 뒀다 — 파일이 없는데 폴백을 켜면 미정의 GET마다
 * 파일 부재가 전역 에러 핸들러로 흘러 <b>404가 500으로 뒤집힌다</b>. 그 뒤집힘은
 * {@code SpaEmptyRootWireTest}가 와이어로 잡는다.
 *
 * <p><b>미설정이 기본(비활성)이다.</b> 그 기본값 덕분에 계약 하네스 313관측 × 2축이 구조적으로 무회귀다
 * ({@code scripts/spring-contract.mjs}의 {@code javaChildEnv()}는 허용목록 방식이라 {@code SPA_DIR}을 자식에게
 * 넘기지 않는다).
 *
 * <p><b>절대 던지지 않는다</b> — {@link SpoolProperties#rootPath()}와 같은 규율이다({@link Path#of}는
 * 파일시스템이 파싱조차 못 하는 문자열에 unchecked 예외를 던진다. 그 예외가 {@code @Bean} 안에서 새면
 * <b>컨텍스트 기동이 실패</b>해 39 라우트가 전멸한다 — SPA 설정 오타가 로그인을 죽이면 안 된다).
 */
class SpaPropertiesTest {

	/** F25: 미설정·빈 값·공백은 전부 비활성이다(off 스위치). */
	@Test
	void anUnsetOrBlankValueDisablesServing() {
		for (String raw : new String[] { null, "", "   ", "\t\n" }) {
			assertEquals(Optional.empty(), new SpaProperties(raw).spaRootPath(), String.valueOf(raw));
			assertFalse(new SpaProperties(raw).enabled(), String.valueOf(raw));
		}
	}

	/** F23: {@code <dir>/index.html}이 있으면 절대 경로다. */
	@Test
	void aDirectoryWithAnIndexHtmlIsTheServingRoot(@TempDir Path dist) throws IOException {
		Files.writeString(dist.resolve("index.html"), "<!doctype html>", StandardCharsets.UTF_8);

		SpaProperties properties = new SpaProperties(dist.toString());

		assertEquals(Optional.of(dist.toAbsolutePath().normalize()), properties.spaRootPath());
		assertTrue(properties.enabled());
	}

	/** F23: 디렉토리는 있어도 {@code index.html}이 없으면 비활성이다(404가 500이 되는 것을 막는다). */
	@Test
	void aDirectoryWithoutAnIndexHtmlIsInactive(@TempDir Path empty) {
		assertEquals(Optional.empty(), new SpaProperties(empty.toString()).spaRootPath());
	}

	/** F23: 존재하지 않는 경로는 <b>throw 없이</b> 비활성이다. */
	@Test
	void aMissingDirectoryIsInactiveWithoutThrowing(@TempDir Path parent) {
		Path missing = parent.resolve("does-not-exist");

		assertEquals(Optional.empty(), new SpaProperties(missing.toString()).spaRootPath());
	}

	/** {@code index.html}이 <b>디렉토리</b>면 파일이 아니다 — 비활성이다. */
	@Test
	void anIndexHtmlDirectoryIsNotAFile(@TempDir Path dist) throws IOException {
		Files.createDirectory(dist.resolve("index.html"));

		assertEquals(Optional.empty(), new SpaProperties(dist.toString()).spaRootPath());
	}

	/** 파일시스템이 파싱조차 못 하는 값에도 기동을 죽이지 않는다(경고만 남기고 비활성). */
	@Test
	void anUnparseablePathIsInactiveRatherThanFatal() {
		assertEquals(Optional.empty(), new SpaProperties("C:\\web\\dist?*|").spaRootPath());
		assertEquals(Optional.empty(), new SpaProperties("\"C:\\web\\dist\"").spaRootPath());
	}

	/** F24: 상대 경로는 절대화한다(값 해석의 단일 지점). */
	@Test
	void aRelativePathIsResolvedToAnAbsolutePath() {
		Optional<Path> root = new SpaProperties("rel/dist").spaRootPath();

		// 실재하지 않으므로 비활성이지만, 절대화 규칙 자체는 경로 도출에서 확인한다.
		assertEquals(Optional.empty(), root);
		assertTrue(new SpaProperties("rel/dist").resolvedDir().orElseThrow().isAbsolute(),
				"상대 경로가 절대화되지 않으면 프로세스 작업 디렉토리에 따라 서빙 루트가 달라진다");
	}
}
