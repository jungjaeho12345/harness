package harness.news.testsupport;

import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 테스트용 <b>임시 MySQL 데이터베이스</b> — 만들고, 쓰고, 통째로 버린다(phase 75 step1).
 *
 * <h2>왜 이런 물건이 필요한가</h2>
 * P2(DB 이관)의 측정은 "SQLite와 MySQL이 같은 입력에 같은 답을 내는가"이고, 그 측정은 <b>변조</b>를
 * 동반한다(타입을 바꿔 보고, 길이를 넘겨 보고, 롤백해 보고, id를 지워 본다). 그런 변조를 운영 DB나
 * 스테이징({@code news_stage})에서 하면 폭발 반경이 그 DB 전체다. 그래서 실행마다 <b>자기만의 빈 DB</b>를
 * 만들어 쓰고 버린다 — 폭발 반경이 0이다.
 *
 * <h2>삭제는 이중으로 잠근다</h2>
 * 최상위 규칙(DB 행 삭제 금지)이 지키는 대상은 <b>뉴스 데이터</b>다. 오늘도 임시 SQLite 파일은
 * 만들어지고 지워진다 — 임시 MySQL DB는 그것과 같은 지위다. 그래도 실수 한 번이 되돌릴 수 없으므로
 * 보호를 두 겹으로 건다.
 * <ol>
 * <li><b>이름 정규식</b>({@link #EPHEMERAL_NAME}) — {@code harness_ct_} + 16자리 소문자 hex만 드롭한다.
 * 그 밖의 이름이 오면 <b>드롭하지 않고 던진다</b>. 이 클래스에 드롭 코드는 {@link #dropDatabase} 하나뿐이다.</li>
 * <li><b>GRANT 경계</b> — 접속 계정({@code NEWS_CT_MYSQL_USERNAME})은 부트스트랩에서
 * {@code harness\_ct\_%} 밖에 아무 권한이 없다(phase 75 step0). 정규식이 뚫려도 서버가 막는다.</li>
 * </ol>
 *
 * <h2>접속 정보는 환경변수에서만 온다</h2>
 * 리터럴도 기본값도 두지 않는다. 값이 없으면 {@link #requireConfigured()}가 <b>무엇이 없는지 지목하고
 * 던진다</b> — 조용한 skip은 이 phase의 모든 MySQL 게이트를 공허하게 만든다(decisions (14)).
 */
public final class EphemeralMysqlDb implements AutoCloseable {

	/** 드롭이 허용되는 <b>유일한</b> 이름 형태. 이 상수 하나가 삭제의 경계다. */
	public static final Pattern EPHEMERAL_NAME = Pattern.compile("^harness_ct_[0-9a-f]{16}$");

	/** 임시 DB 이름 접두사 — 부트스트랩의 GRANT 패턴과 같은 문자열이어야 한다. */
	public static final String NAME_PREFIX = "harness_ct_";

	/** 접속 URL(데이터베이스 이름 없이 서버만 가리킨다). */
	public static final String URL_KEY = "NEWS_CT_MYSQL_URL";

	/** 접속 계정 이름. */
	public static final String USERNAME_KEY = "NEWS_CT_MYSQL_USERNAME";

	/** 접속 비밀번호 — 값은 리포 밖 env 파일에만 있고 여기에는 <b>키 이름</b>만 있다. */
	public static final String PASSWORD_KEY = "NEWS_CT_MYSQL_PASSWORD";

	/** 이 phase가 채택한 기본 collation — 근거는 {@code docs/db-mysql-mapping.md} 축 3·4·5다. */
	public static final String DEFAULT_COLLATION = "utf8mb4_0900_bin";

	private static final SecureRandom RANDOM = new SecureRandom();

	private static final String SCHEME_SEPARATOR = "://";

	private final String database;

	private final String jdbcUrl;

	private boolean dropped;

	private EphemeralMysqlDb(String database, String jdbcUrl) {
		this.database = database;
		this.jdbcUrl = jdbcUrl;
	}

	/** 환경변수 3종이 전부 있는가. 판정만 하고 던지지 않는다(가드 테스트가 메시지를 만든다). */
	public static boolean isConfigured() {
		return missingKeys().isEmpty();
	}

	/** 비어 있는 환경변수 키 목록(순서 고정). */
	public static List<String> missingKeys() {
		List<String> missing = new ArrayList<>();
		for (String key : List.of(URL_KEY, USERNAME_KEY, PASSWORD_KEY)) {
			String value = System.getenv(key);
			if (value == null || value.isBlank()) {
				missing.add(key);
			}
		}
		return missing;
	}

	/**
	 * 설정이 없으면 <b>던진다</b>(skip이 아니다).
	 *
	 * @throws IllegalStateException 환경변수가 하나라도 비었을 때
	 */
	public static void requireConfigured() {
		List<String> missing = missingKeys();
		if (!missing.isEmpty()) {
			throw new IllegalStateException(
					"MySQL 접속 환경변수가 없습니다: " + missing
							+ " — docs/ops-mysql.md 절차로 리포 밖 env 파일을 셸에 로드한 뒤 다시 실행하세요. "
							+ "(이 테스트는 조용히 건너뛰지 않습니다 — skip은 이 phase의 게이트를 전부 공허하게 만듭니다.)");
		}
	}

	/** 기본 collation({@link #DEFAULT_COLLATION})으로 임시 DB를 만든다. */
	public static EphemeralMysqlDb create() {
		return create(DEFAULT_COLLATION);
	}

	/**
	 * 임시 DB를 만들고 그것을 가리키는 핸들을 준다.
	 *
	 * @param collation 데이터베이스 기본 collation(측정용으로 바꿔 넣을 수 있다)
	 */
	public static EphemeralMysqlDb create(String collation) {
		requireConfigured();
		String database = NAME_PREFIX + randomSuffix();
		if (!EPHEMERAL_NAME.matcher(database).matches()) {
			throw new IllegalStateException("생성한 이름이 임시 DB 규약을 벗어난다: " + database);
		}
		String serverUrl = System.getenv(URL_KEY);
		try (Connection connection = open(serverUrl); Statement statement = connection.createStatement()) {
			statement.executeUpdate("CREATE DATABASE `" + database + "` CHARACTER SET utf8mb4 COLLATE "
					+ requireIdentifier(collation));
		}
		catch (SQLException ex) {
			throw new IllegalStateException("임시 MySQL DB 생성 실패: " + database, ex);
		}
		EphemeralMysqlDb handle = new EphemeralMysqlDb(database, urlForDatabase(serverUrl, database));
		Runtime.getRuntime().addShutdownHook(new Thread(handle::closeQuietly));
		return handle;
	}

	/** 이 핸들이 만든 DB 이름. */
	public String database() {
		return this.database;
	}

	/** 이 DB를 가리키는 JDBC URL(비밀번호는 담기지 않는다 — 인자로만 흐른다). */
	public String jdbcUrl() {
		return this.jdbcUrl;
	}

	/** 이 DB로 새 연결을 연다. 호출자가 닫는다. */
	public Connection openConnection() throws SQLException {
		return open(this.jdbcUrl);
	}

	/** 이 DB에 DDL/DML 1건을 실행한다(측정 픽스처 전용). */
	public void exec(String sql) {
		try (Connection connection = openConnection(); Statement statement = connection.createStatement()) {
			statement.executeUpdate(sql);
		}
		catch (SQLException ex) {
			throw new IllegalStateException("임시 MySQL DB 실행 실패: " + this.database + " / " + sql, ex);
		}
	}

	/** 만든 DB를 버린다(멱등). */
	@Override
	public void close() {
		if (this.dropped) {
			return;
		}
		dropDatabase(this.database);
		this.dropped = true;
	}

	private void closeQuietly() {
		try {
			close();
		}
		catch (RuntimeException ignored) {
			// 종료 훅은 best-effort — 여기서 던지면 JVM 종료 로그만 더럽힌다.
		}
	}

	/**
	 * <b>삭제의 유일한 통로</b> — 이름이 {@link #EPHEMERAL_NAME}에 맞지 않으면 접속조차 하지 않고 던진다.
	 *
	 * @throws IllegalArgumentException 임시 DB 규약 밖의 이름일 때
	 */
	public static void dropDatabase(String database) {
		if (database == null || !EPHEMERAL_NAME.matcher(database).matches()) {
			throw new IllegalArgumentException(
					"임시 DB 규약(" + EPHEMERAL_NAME.pattern() + ")을 벗어난 이름은 드롭하지 않는다: " + database);
		}
		requireConfigured();
		try (Connection connection = open(System.getenv(URL_KEY));
				Statement statement = connection.createStatement()) {
			statement.executeUpdate("DROP DATABASE IF EXISTS `" + database + "`");
		}
		catch (SQLException ex) {
			throw new IllegalStateException("임시 MySQL DB 정리 실패: " + database, ex);
		}
	}

	/**
	 * 서버 URL의 경로를 데이터베이스 이름으로 바꾼다(질의 문자열은 보존).
	 *
	 * <p>순수 함수라 DB 없이 단위 테스트할 수 있다 — 이 조립이 틀리면 측정이 <b>엉뚱한 DB</b>에서 돈다.
	 */
	public static String urlForDatabase(String baseUrl, String database) {
		int question = baseUrl.indexOf('?');
		String head = (question < 0) ? baseUrl : baseUrl.substring(0, question);
		String query = (question < 0) ? "" : baseUrl.substring(question);
		int scheme = head.indexOf(SCHEME_SEPARATOR);
		if (scheme < 0) {
			throw new IllegalArgumentException("접속 URL 형태를 알 수 없다(" + URL_KEY + "): " + head);
		}
		int path = head.indexOf('/', scheme + SCHEME_SEPARATOR.length());
		String authority = (path < 0) ? head : head.substring(0, path);
		return authority + "/" + database + query;
	}

	private static Connection open(String url) throws SQLException {
		return DriverManager.getConnection(url, System.getenv(USERNAME_KEY), System.getenv(PASSWORD_KEY));
	}

	/** 식별자 자리에 들어가는 값은 영숫자·밑줄만 허용한다(문자열 이어붙이기의 최소 방어). */
	private static String requireIdentifier(String value) {
		if (value == null || !value.matches("[A-Za-z0-9_]+")) {
			throw new IllegalArgumentException("식별자 형태가 아니다: " + value);
		}
		return value;
	}

	private static String randomSuffix() {
		byte[] bytes = new byte[8];
		RANDOM.nextBytes(bytes);
		return HexFormat.of().formatHex(bytes);
	}

}
