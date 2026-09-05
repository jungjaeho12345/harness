package harness.newsmigrator;

import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * 계약 하네스가 패스마다 쓰고 버리는 <b>임시 데이터베이스</b> — 이 모듈에서 데이터베이스를 버리는
 * 코드가 있는 <b>유일한 파일</b>이다.
 *
 * <h2>왜 이 파일 하나인가</h2>
 * 최상위 규칙(DB 에 있는 내용은 절대 삭제하지 않는다)이 지키는 대상은 <b>뉴스 데이터</b>다. 하네스는
 * 오늘도 패스마다 임시 SQLite 파일을 만들고 버리며, 임시 MySQL DB 는 그것과 같은 지위다(안 버리면
 * 실행마다 스키마가 영구히 쌓인다). 그래도 실수 한 번이 되돌릴 수 없으므로 보호를 세 겹으로 건다.
 * <ol>
 * <li><b>이름 규약</b>({@link #EPHEMERAL_NAME}) — {@code harness_ct_} + 16자리 <b>소문자</b> hex 만
 * 통과한다. 그 밖의 이름은 <b>접속조차 하지 않고</b> 던진다.</li>
 * <li><b>정적 게이트</b> — {@code MigratorHasNoDestructiveSqlTest} 가 이 파일 하나만 예외로 두고,
 * 그 예외 목록의 크기·경로·소속 군까지 단언한다. 다른 파일에 같은 문장을 쓰면 red 다.</li>
 * <li><b>서버 권한</b> — 이 통로를 쓰는 자격({@code news_ct})은 {@code harness\_ct\_%} 밖에 아무 권한이
 * 없고, 이관용 자격({@code news_migrator})에는 그 권한 자체가 없다. 정규식이 뚫려도 서버가 막는다.</li>
 * </ol>
 *
 * <h2>이름을 문자열로 이어 붙이는 것에 대해</h2>
 * 데이터베이스 이름은 바인딩 파라미터가 될 수 없다(식별자 자리다). 그래서 이어 붙이되, 붙이기 <b>전에</b>
 * {@link #requireEphemeralName}을 통과한 값만 쓴다 — 그 정규식이 hex 16자리만 허용하므로 따옴표·공백·
 * 세미콜론이 애초에 들어올 수 없다.
 */
public final class EphemeralDatabase {

	/** 만들고 버리는 것이 허용되는 <b>유일한</b> 이름 형태. 이 상수 하나가 경계다. */
	public static final Pattern EPHEMERAL_NAME = Pattern.compile("^harness_ct_[0-9a-f]{16}$");

	/** 이름 접두사 — 부트스트랩의 GRANT 패턴과 같은 문자열이어야 한다. */
	public static final String NAME_PREFIX = "harness_ct_";

	/** 임시 DB 의 기본 collation — 근거는 {@code docs/db-mysql-mapping.md} 축 3·4·5 다. */
	public static final String COLLATION = "utf8mb4_0900_bin";

	private static final SecureRandom RANDOM = new SecureRandom();

	private EphemeralDatabase() {
	}

	/** 규약을 만족하는 새 이름. 만드는 쪽과 버리는 쪽이 <b>같은 규약</b>을 쓴다. */
	public static String randomName() {
		byte[] bytes = new byte[8];
		RANDOM.nextBytes(bytes);
		return NAME_PREFIX + HexFormat.of().formatHex(bytes);
	}

	/**
	 * 임시 DB 규약을 만족하는 이름만 통과시킨다.
	 *
	 * @return 통과한 이름 그대로
	 * @throws IllegalArgumentException 규약 밖 이름일 때(운영 DB 이름은 여기서 멈춘다)
	 */
	public static String requireEphemeralName(String database) {
		if (database == null || !EPHEMERAL_NAME.matcher(database).matches()) {
			throw new IllegalArgumentException(
					"임시 DB 규약(" + EPHEMERAL_NAME.pattern() + ")을 벗어난 이름은 만들지도 버리지도 않습니다: " + database);
		}
		return database;
	}

	/** 빈 임시 DB 를 만든다(이미 있으면 그대로 둔다 — 멱등). */
	public static void create(TargetCredentials server, String database) {
		String name = requireEphemeralName(database);
		execute(server, "CREATE DATABASE IF NOT EXISTS `" + name + "` CHARACTER SET utf8mb4 COLLATE " + COLLATION,
				"임시 MySQL DB 생성 실패");
	}

	/**
	 * 임시 DB 를 통째로 버린다(없으면 그대로 성공 — 멱등).
	 *
	 * <p><b>이 모듈에서 데이터베이스를 버리는 유일한 문장이 아래 한 줄이다.</b> 대상 이름은 위
	 * {@link #requireEphemeralName} 을 통과한 것뿐이므로 {@code news}·{@code news_stage} 는 도달할 수 없다.
	 */
	public static void drop(TargetCredentials server, String database) {
		String name = requireEphemeralName(database);
		execute(server, "DROP DATABASE IF EXISTS `" + name + "`", "임시 MySQL DB 정리 실패");
	}

	private static void execute(TargetCredentials server, String sql, String failureMessage) {
		try (Connection connection = TargetCredentials.open(server);
				Statement statement = connection.createStatement()) {
			statement.executeUpdate(sql);
		}
		catch (SQLException ex) {
			throw new IllegalStateException(failureMessage + ": " + server.describe(), ex);
		}
	}

}
