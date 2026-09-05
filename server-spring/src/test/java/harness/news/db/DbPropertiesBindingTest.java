package harness.news.db;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.testsupport.TempNewsDb;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 결선 확인 — {@code app.db.*}가 실제로 {@link DbProperties}로 바인딩되고 그 값이 {@code DataSource}를
 * 고른다.
 *
 * <p>레코드 단위 테스트만으로는 {@code DbConfig}의 {@code @EnableConfigurationProperties} 항목이 빠진 것을
 * 잡지 못한다(그 상태에서는 빈이 아예 없어 주입이 실패한다). 그리고 <b>기본값이 sqlite로 남아 있는지</b>가
 * 이 phase의 무회귀 판정선이다 — 기본이 흔들리면 313관측이 다른 저장소를 보게 된다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
class DbPropertiesBindingTest {

	@DynamicPropertySource
	static void dataDir(DynamicPropertyRegistry registry) {
		registry.add("app.data-dir", () -> TempNewsDb.sharedDataDir().toAbsolutePath().toString());
	}

	private final DbProperties properties;

	private final HikariDataSource dataSource;

	DbPropertiesBindingTest(@Autowired DbProperties properties, @Autowired HikariDataSource dataSource) {
		this.properties = properties;
		this.dataSource = dataSource;
	}

	@Test
	void theDefaultKindIsSqliteAndItOpensTheDataDirDatabase() {
		assertEquals(DbProperties.SQLITE, this.properties.kind(), "DB_KIND 미주입의 기본은 sqlite다");
		assertFalse(this.properties.mysql());
		assertEquals("jdbc:sqlite:" + TempNewsDb.dbFile(TempNewsDb.sharedDataDir()).toAbsolutePath(),
				this.dataSource.getJdbcUrl(), "기본 배선은 app.data-dir 아래 news.db다");
		assertEquals(NewsDataSource.MAX_POOL_SIZE, this.dataSource.getMaximumPoolSize());
	}
}
