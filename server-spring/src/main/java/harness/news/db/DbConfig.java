package harness.news.db;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.config.AppProperties;
import javax.sql.DataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * DB 계층 배선(합성 루트).
 *
 * <p>기동 순서가 곧 방어선이다: 데이터 디렉토리 주입 확인({@code AppProperties}) → DB 파일 존재 확인
 * ({@link NewsDataSource}) → 요구 테이블·컬럼 존재 확인({@link SchemaGuard}). 셋 중 하나라도 실패하면
 * 컨텍스트가 뜨지 않는다. 요청을 받기 시작한 뒤에 이 사실들을 알게 되는 편이 훨씬 나쁘다.
 *
 * <p>스키마 자동 생성/마이그레이션 기능은 쓰지 않는다 — 스키마 소유자는 Node 서버이고, 자동화 도구는
 * 예외 없이 재생성 경로를 품고 있어 DB 비파괴 규칙과 정면으로 충돌한다.
 */
@Configuration(proxyBeanMethods = false)
public class DbConfig {

	/** {@code <data-dir>/news.db}를 여는 커넥션 풀(최대 1). 컨텍스트 종료 시 닫힌다. */
	@Bean(destroyMethod = "close")
	public HikariDataSource newsDataSource(AppProperties properties) {
		return NewsDataSource.create(properties.dataDirPath());
	}

	/** SQL 문자열이 코드에 그대로 남는 접근 API — 리포지토리가 이것만 쓴다. */
	@Bean
	public JdbcClient jdbcClient(DataSource dataSource) {
		return JdbcClient.create(dataSource);
	}

	/**
	 * 부팅 스키마 검증 지점. 여기서 던지면 컨텍스트 refresh가 실패하고 서버가 뜨지 않는다 —
	 * 이 빈이 하는 일은 그 검증 하나뿐이다.
	 */
	@Bean
	public SchemaGuard schemaGuard(JdbcClient jdbcClient, AppProperties properties) {
		SchemaGuard guard = new SchemaGuard(
				jdbcClient, properties.dataDirPath().resolve(NewsDataSource.DB_FILE_NAME));
		guard.verify();
		return guard;
	}
}
