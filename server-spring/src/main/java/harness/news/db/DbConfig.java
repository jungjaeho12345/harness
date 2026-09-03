package harness.news.db;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.config.AppProperties;
import javax.sql.DataSource;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * DB 계층 배선(합성 루트).
 *
 * <p>기동 순서가 곧 방어선이다: 데이터 디렉토리 주입 확인({@code AppProperties}) → 방언 선택 검증
 * ({@link DbProperties}) → DB 존재 확인({@link NewsDataSource}) → 요구 테이블·컬럼 존재 확인
 * ({@link SchemaGuard}). 넷 중 하나라도 실패하면 컨텍스트가 뜨지 않는다. 요청을 받기 시작한 뒤에 이
 * 사실들을 알게 되는 편이 훨씬 나쁘다.
 *
 * <p>스키마 자동 생성/마이그레이션 기능은 쓰지 않는다 — 스키마 소유자는 Node 서버이고, 자동화 도구는
 * 예외 없이 재생성 경로를 품고 있어 DB 비파괴 규칙과 정면으로 충돌한다.
 *
 * <p>{@link DbProperties} 바인딩을 여기서 활성화한다 — 소비자가 이 클래스뿐이고, 그 레코드가 방언
 * 상수({@link NewsDataSource})를 참조하므로 설정 패키지에 두면 패키지 순환이 된다.
 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(DbProperties.class)
public class DbConfig {

	/**
	 * 주입된 방언의 커넥션 풀(최대 1). 기본은 {@code <data-dir>/news.db}이고 {@code app.db.kind=mysql}이면
	 * 주입된 URL이다. 컨텍스트 종료 시 닫힌다.
	 */
	@Bean(destroyMethod = "close")
	public HikariDataSource newsDataSource(AppProperties properties, DbProperties db) {
		return NewsDataSource.create(db, properties.dataDirPath());
	}

	/** SQL 문자열이 코드에 그대로 남는 접근 API — 리포지토리가 이것만 쓴다. */
	@Bean
	public JdbcClient jdbcClient(DataSource dataSource) {
		return JdbcClient.create(dataSource);
	}

	/**
	 * 두 테이블(Article·Contents) 동시 변경의 원자성 경계 — Node {@code articleModel.tx()}와 같은 자리다.
	 *
	 * <p>스스로 {@code BEGIN}/{@code COMMIT}을 쓰지 않고 트랜잭션 매니저를 거치는 이유는 <b>커넥션이
	 * 하나</b>이기 때문이다({@link NewsDataSource#MAX_POOL_SIZE}). 직접 커넥션을 꺼내 트랜잭션을 열면
	 * 그 안에서 {@link JdbcClient}가 <b>두 번째 커넥션</b>을 요청해 풀이 고갈된다(교착). 매니저는 커넥션을
	 * 스레드에 묶어 두므로 같은 트랜잭션 안의 모든 문장이 그 하나를 쓴다.
	 *
	 * <p>배선을 여기 명시하는 것은 자동설정에 기대지 않기 위해서다 — 이 빈이 없으면 원자성이 조용히
	 * 사라지는 것이 아니라 배선이 실패해야 한다.
	 */
	@Bean
	public TransactionTemplate transactionTemplate(DataSource dataSource) {
		return new TransactionTemplate(new JdbcTransactionManager(dataSource));
	}

	/**
	 * 부팅 스키마 검증 지점. 여기서 던지면 컨텍스트 refresh가 실패하고 서버가 뜨지 않는다 —
	 * 이 빈이 하는 일은 그 검증 하나뿐이다.
	 *
	 * <p>검증은 JDBC 카탈로그로만 하므로 방언을 가리지 않는다. 실패 메시지가 지목할 대상 표기만
	 * 방언마다 다르다({@link NewsDataSource#describeTarget}).
	 */
	@Bean
	public SchemaGuard schemaGuard(DataSource dataSource, AppProperties properties, DbProperties db) {
		SchemaGuard guard = new SchemaGuard(
				dataSource, NewsDataSource.describeTarget(db, properties.dataDirPath()));
		guard.verify();
		return guard;
	}
}
