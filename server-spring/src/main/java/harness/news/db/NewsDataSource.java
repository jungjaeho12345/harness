package harness.news.db;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

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

	/**
	 * MySQL 세션에 <b>반드시</b> 있어야 하는 SQL 모드 — 없으면 상한 초과 값이 거부 대신 절단된다
	 * ({@link #verifySession}의 근거 1).
	 */
	public static final String REQUIRED_SQL_MODE = "STRICT_TRANS_TABLES";

	/** MySQL 세션 문자셋 — 기반선이 {@code utf8mb4}이므로 접속도 같아야 한다. */
	public static final String REQUIRED_CHARSET = "utf8mb4";

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
		if (!db.mysql()) {
			return create(dataDir);
		}
		HikariDataSource dataSource = new HikariDataSource(mysqlConfig(db));
		try {
			verifySession(dataSource, describeTarget(db, dataDir));
		}
		catch (RuntimeException ex) {
			dataSource.close();
			throw ex;
		}
		return dataSource;
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
	 * <p>연결 초기화 SQL을 두지 않는다: {@code busy_timeout}은 SQLite 전용이고, 여기서 필요한 것은
	 * 값을 <b>세우는</b> 일이 아니라 세워진 값을 <b>확인</b>하는 일이다({@link #verifySession}).
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

	/**
	 * MySQL 세션 read-back — <b>의도한 설정으로 떴는지 읽어 확인하고, 아니면 뜨지 않는다.</b>
	 *
	 * <p>SQLite 쪽 {@link #verifyBusyTimeout}과 같은 규율이다(조용히 다른 설정으로 도는 것을 금지). 다만
	 * 확인 대상은 우리가 <b>세운</b> 값이 아니라 서버·드라이버·URL이 <b>합의한</b> 값이다 — 이 서버는 접속
	 * 파라미터를 덧붙이지 않으므로({@link #mysqlConfig}) 세션 설정의 출처가 배포 환경이고, 그래서 더더욱
	 * 읽어 봐야 한다.
	 *
	 * <p>확인하는 것은 넷이고 각각의 근거가 실측이다(docs/db-mysql-mapping.md).
	 * <ol>
	 *   <li><b>{@code STRICT_TRANS_TABLES}</b> — 이 모드가 빠지면 상한을 넘는 값이 <b>거부되는 대신 조용히
	 *       잘려서</b> 저장된다. 축 8이 "769자는 MySQL이 1406으로 거부하고 절단하지 않는다"를 확인했고
	 *       텍스트 PK를 {@code VARCHAR(768)}로 옮기는 결정이 그 사실 위에 서 있다 — 절단이 살아나면
	 *       {@code userId} 하나가 다른 계정과 충돌하는 형태의 데이터 손상이 된다.</li>
	 *   <li><b>{@code character_set_client}</b>·<b>{@code character_set_connection}</b> = {@code utf8mb4} —
	 *       한글 본문·제목이 왕복에서 깨지지 않는 최소 조건이다({@code characterEncoding} 오타 하나가
	 *       이 자리를 바꾼다).</li>
	 *   <li><b>{@code collation_connection}</b>의 문자셋 계열 — 값 자체는 배포 선택이라 고정하지 않는다
	 *       (실측: 이 서버 기본은 {@code utf8mb4_0900_ai_ci}이고 <b>컬럼 collation이 우선</b>하므로
	 *       비교 의미론은 기반선이 정한다 — 축 3·11). 다른 <b>문자셋</b>이면 그 전제가 깨지므로
	 *       계열만 본다.</li>
	 * </ol>
	 *
	 * <p>메시지에 자격을 싣지 않는다 — 대상 표기는 {@link #describeTarget}가 만든 값이다.
	 */
	private static void verifySession(HikariDataSource dataSource, String target) {
		try (Connection connection = dataSource.getConnection();
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery("SELECT @@session.sql_mode, @@session.character_set_client,"
						+ " @@session.character_set_connection, @@session.collation_connection")) {
			if (!rs.next()) {
				throw new IllegalStateException("MySQL 세션 설정을 읽지 못했습니다 (" + target + ")");
			}
			String sqlMode = rs.getString(1);
			List<String> problems = new ArrayList<>();
			if (sqlMode == null || !List.of(sqlMode.split(",")).contains(REQUIRED_SQL_MODE)) {
				problems.add("sql_mode 에 " + REQUIRED_SQL_MODE + " 가 없습니다(actual=" + sqlMode + ")");
			}
			requireValue(problems, "character_set_client", rs.getString(2), REQUIRED_CHARSET);
			requireValue(problems, "character_set_connection", rs.getString(3), REQUIRED_CHARSET);
			String collation = rs.getString(4);
			if (collation == null || !collation.startsWith(REQUIRED_CHARSET + "_")) {
				problems.add("collation_connection 이 " + REQUIRED_CHARSET
						+ " 계열이 아닙니다(actual=" + collation + ")");
			}
			if (!problems.isEmpty()) {
				throw new IllegalStateException("MySQL 세션 설정이 의도와 다릅니다 (" + target + "): "
						+ String.join(" / ", problems)
						+ ". 접속 URL 파라미터와 서버 설정을 확인하세요 — 이 서버는 다른 설정으로 조용히 뜨지 않습니다.");
			}
		}
		catch (SQLException ex) {
			throw new IllegalStateException("DB 연결에 실패했습니다: " + target, ex);
		}
	}

	private static void requireValue(List<String> problems, String name, String actual, String expected) {
		if (!expected.equals(actual)) {
			problems.add(name + " 이 " + expected + " 가 아닙니다(actual=" + actual + ")");
		}
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
