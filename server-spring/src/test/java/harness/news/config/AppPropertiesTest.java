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
}
