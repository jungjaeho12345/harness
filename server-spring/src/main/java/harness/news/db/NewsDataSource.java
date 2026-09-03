package harness.news.db;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * DataSource 팩토리 — <b>이 서버에서 저장소 방언을 아는 유일한 파일</b>(ADR-016 · phase 75 step5).
 *
 * <p>방언 철자(드라이버 좌표·URL 스킴·전용 함수)가 여기 말고 어디에도 없다는 사실은
 * {@code DialectSeamTest}가 <b>파일 집합</b>으로 단언한다. 그래야 다음 방언을 붙이는 비용이 이 파일
 * 하나이고, 옮겨 간 뒤에 남은 SQLite 전용 표면이 "조용히 다르게 도는 자리"로 살아남지 않는다.
 * 어느 분기를 탈지는 {@link DbProperties}가 <b>명시 주입</b>으로 정한다 — URL을 보고 추론하지 않는다.
 *
 * <p>SQLite 분기의 규칙 셋을 지킨다.
 * <ol>
 *   <li><b>없으면 만들지 않는다.</b> SQLite JDBC는 파일이 없으면 조용히 새 파일을 만든다 — 그러면
 *       "빈 DB로 떠서 첫 로그인에서 터지는" 상태가 된다. 그래서 여는 <i>전에</i> 존재를 확인하고,
 *       없으면 경로를 담은 메시지로 기동을 실패시킨다.</li>
 *   <li><b>연결 설정은 {@code busy_timeout} 하나뿐이다.</b> Node 부트 연결
 *       ({@code src/db/connection.js})과 같은 값을 쓰고, 적용됐는지 read-back으로 확인한다
 *       (조용히 적용 안 된 채 진행하면 경합 완화가 없다는 사실이 장애 때야 드러난다).
 *       {@code journal_mode}·{@code synchronous}는 <b>절대</b> 건드리지 않는다 — WAL 전환은 DB 파일
 *       자체를 변형하고 {@code -wal}/{@code -shm} 부산물을 남겨 되돌리기 어렵다.</li>
 *   <li><b>풀 최대 1.</b> SQLite는 단일 파일이라 동시 쓰기가 {@code SQLITE_BUSY}를 낸다. Node 서버는
 *       단일 연결·동기 실행이라 이 문제가 없었고, 여기서도 같은 형태로 시작한다. 이 실패는 계약
 *       스위트에서 간헐적으로 나타나 flake로 오인되므로 애초에 만들지 않는 편이 진단에 낫다.
 *       <b>MySQL 분기도 1이다</b>(ADR-016 결정 6): 단일 writer라는 원래 근거는 사라지지만 확대는
 *       동시성 동작을 바꾸는 별개 결정이고, 락 순서 방어선({@code LogsStreamWireTest} 항목 22)이 이
 *       상수에 걸려 있다.</li>
 * </ol>
 */
public final class NewsDataSource {

	/** 데이터 디렉토리 안의 DB 파일 이름 — Node 서버가 쓰는 이름과 같다. */
	public static final String DB_FILE_NAME = "news.db";

	/** 부트 연결 설정 값. Node {@code DEFAULT_BUSY_TIMEOUT_MS}와 동형(5000ms). */
	public static final int BUSY_TIMEOUT_MS = 5000;

	/** 커넥션 풀 상한. 위 3번 근거로 1이다(방언과 무관). */
	public static final int MAX_POOL_SIZE = 1;

	/** SQLite JDBC URL 접두사 — {@link DbProperties}의 방언 일치 검증이 이 상수를 본다. */
	public static final String SQLITE_URL_PREFIX = "jdbc:sqlite:";

	/** MySQL JDBC URL 접두사 — 위와 같은 자리. */
	public static final String MYSQL_URL_PREFIX = "jdbc:mysql:";

	private static final String SQLITE_DRIVER = "org.sqlite.JDBC";

	private static final String MYSQL_DRIVER = "com.mysql.cj.jdbc.Driver";

	private static final String POOL_NAME = "news-db";

	private NewsDataSource() {
	}

	/**
	 * 주입된 방언대로 DataSource를 만든다 — <b>분기는 여기 하나뿐</b>이다.
	 *
	 * @param db 방언 선택(기본 {@code sqlite})
	 * @param dataDir {@code app.data-dir}(환경변수 {@code DATA_DIR})가 가리키는 디렉토리. mysql 모드에서도
	 *     여전히 필수다 — 업로드 루트가 그 값에서 나온다({@code AppProperties#uploadsDirPath})
	 * @throws IllegalStateException sqlite 모드에서 DB 파일이 없거나 열 수 없을 때(기동 실패)
	 */
	public static HikariDataSource create(DbProperties db, Path dataDir) {
		return db.mysql() ? new HikariDataSource(mysqlConfig(db)) : create(dataDir);
	}

	/**
	 * 데이터 디렉토리의 {@code news.db}를 여는 DataSource를 만든다(SQLite 분기).
	 *
	 * @param dataDir {@code app.data-dir}(환경변수 {@code DATA_DIR})가 가리키는 디렉토리
	 * @throws IllegalStateException DB 파일이 없거나 열 수 없을 때(기동 실패)
	 */
	public static HikariDataSource create(Path dataDir) {
		Path db = dataDir.resolve(DB_FILE_NAME).toAbsolutePath();
		if (!Files.isRegularFile(db)) {
			throw new IllegalStateException(
					"DB 파일이 없습니다: " + db + " — 이 서버는 DB를 만들지 않습니다(스키마 소유자는 Node 서버입니다). "
							+ "app.data-dir(환경변수 DATA_DIR)이 올바른 데이터 디렉토리를 가리키는지 확인하세요.");
		}

		HikariConfig config = new HikariConfig();
		config.setPoolName(POOL_NAME);
		config.setDriverClassName(SQLITE_DRIVER);
		config.setJdbcUrl(SQLITE_URL_PREFIX + db);
		config.setMaximumPoolSize(MAX_POOL_SIZE);
		// 물리 연결마다 1회 실행된다 — 연결 단위 설정인 busy_timeout에 정확히 맞는 자리다.
		config.setConnectionInitSql("PRAGMA busy_timeout = " + BUSY_TIMEOUT_MS);

		HikariDataSource dataSource = new HikariDataSource(config);
		try {
			verifyBusyTimeout(dataSource, db);
		}
		catch (RuntimeException ex) {
			dataSource.close();
			throw ex;
		}
		return dataSource;
	}

	/**
	 * MySQL 분기의 풀 설정 — <b>주입된 값을 그대로</b> 쓴다.
	 *
	 * <p>접속 파라미터를 코드에서 덧붙이지 않는다: 필수 파라미터가 없다는 것이 실측이고
	 * (docs/db-mysql-mapping.md §5) 선택 집합은 배포마다 다르다(운영에서 TLS를 켜면 지운다). 코드가
	 * 몰래 붙이면 운영자가 URL을 고쳐도 그 값이 이기지 못한다. 자격은 <b>언제나 별도 키</b>다 —
	 * URL에 섞으면 프로세스 목록·로그로 샌다.
	 *
	 * <p>연결 초기화 SQL을 두지 않는다: {@code busy_timeout}은 SQLite 전용이고, MySQL 세션 설정의
	 * read-back 검증은 step6이 붙인다(이 step은 배선만 만들고 동작을 바꾸지 않는다).
	 */
	static HikariConfig mysqlConfig(DbProperties db) {
		HikariConfig config = new HikariConfig();
		config.setPoolName(POOL_NAME);
		config.setDriverClassName(MYSQL_DRIVER);
		config.setJdbcUrl(db.url());
		config.setUsername(db.username());
		config.setPassword(db.password());
		config.setMaximumPoolSize(MAX_POOL_SIZE);
		return config;
	}

	/**
	 * 실패 메시지가 지목할 <b>대상 표기</b> — sqlite는 파일 경로, mysql은 권한부를 지운 URL이다.
	 *
	 * <p>{@link SchemaGuard}의 메시지가 이 값을 싣는다. MySQL 쪽에서 URL을 통째로 실으면 자격이 박힌
	 * URL이 기동 로그로 새므로 {@code //} 이후(호스트·DB·질의)는 버린다 — 운영자가 알아야 하는 것은
	 * "어느 저장소를 열려 했는가"이고 그것은 방언 표기로 충분하다(어느 인스턴스인지는 배포 설정이 안다).
	 */
	static String describeTarget(DbProperties db, Path dataDir) {
		if (!db.mysql()) {
			return dataDir.resolve(DB_FILE_NAME).toAbsolutePath().toString();
		}
		String url = db.url();
		int authority = url.indexOf("//");
		return (authority < 0) ? url : url.substring(0, authority);
	}

	/** 적용 후 read-back — Node {@code applyConnectionPragmas}와 같은 규율(조용한 no-op 금지). */
	private static void verifyBusyTimeout(HikariDataSource dataSource, Path db) {
		try (Connection connection = dataSource.getConnection();
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery("PRAGMA busy_timeout")) {
			int applied = rs.next() ? rs.getInt(1) : -1;
			if (applied != BUSY_TIMEOUT_MS) {
				throw new IllegalStateException(
						"busy_timeout read-back 불일치 — expected=" + BUSY_TIMEOUT_MS + " actual=" + applied
								+ " (" + db + ")");
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("DB 연결에 실패했습니다: " + db, ex);
		}
	}
}
