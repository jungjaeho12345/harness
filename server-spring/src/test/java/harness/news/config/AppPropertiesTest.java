package harness.news.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

/** AppProperties 정규화 규칙 — Spring 컨텍스트 없이 판정한다(순수 값 객체). */
class AppPropertiesTest {

	@Test
	void blankDataDirIsRejectedWithActionableMessage() {
		for (String blank : Arrays.asList(null, "", "   ")) {
			IllegalArgumentException ex = assertThrows(
					IllegalArgumentException.class,
					() -> new AppProperties(blank, null, null));
			assertTrue(ex.getMessage().contains("app.data-dir"), ex.getMessage());
			assertTrue(ex.getMessage().contains("DATA_DIR"), ex.getMessage());
		}
	}

	@Test
	void envDefaultsToNonProduction() {
		assertEquals("development", new AppProperties("/tmp/x", null, null).env());
		assertFalse(new AppProperties("/tmp/x", null, null).production());
		assertFalse(new AppProperties("/tmp/x", "  ", null).production());
		assertTrue(new AppProperties("/tmp/x", "production", null).production());
	}

	@Test
	void allowedOriginsDefaultsToEmptyAndDropsBlanks() {
		assertEquals(List.of(), new AppProperties("/tmp/x", null, null).allowedOrigins());
		assertEquals(
				List.of("http://a", "http://b"),
				new AppProperties("/tmp/x", null, List.of(" http://a ", "", "http://b")).allowedOrigins());
	}

	@Test
	void dataDirIsTrimmed() {
		assertEquals("/tmp/x", new AppProperties("  /tmp/x  ", null, null).dataDir());
	}

	/**
	 * uploads 루트는 <b>여기 한 지점</b>에서만 도출된다 — 저장측({@code UploadStore})과 서빙측(정적 리소스
	 * 핸들러)이 각자 도출하면 업로드는 성공하는데 서빙은 404가 되는 조용한 divergence가 생긴다.
	 * Node {@code resolveRuntimePaths}의 {@code uploadDir = <dataDir>/uploads}와 같은 자리다.
	 */
	@Test
	void uploadsDirIsAlwaysUnderTheDataDir() {
		AppProperties properties = new AppProperties("  /tmp/x  ", null, null);

		assertEquals(properties.dataDirPath().resolve("uploads"), properties.uploadsDirPath());
		assertEquals("uploads", properties.uploadsDirPath().getFileName().toString());
		assertEquals(properties.dataDirPath(), properties.uploadsDirPath().getParent(),
				"uploads 루트가 데이터 디렉토리 바로 아래가 아니다 — cwd 상대 경로면 리포를 오염시킨다");
	}
}
