package harness.news.testsupport;

import harness.news.db.DbProperties;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * <b>서버 런타임 자격</b>({@code news_app})으로 붙는 접속 — 최소 권한 구성 자체를 시험하는 자리다
 * (phase 75 step6 A·C).
 *
 * <h2>왜 별도의 접속 지점이 필요한가</h2>
 * 이 리포의 MySQL 테스트는 전부 {@code news_ct}(임시 DB에 {@code ALL PRIVILEGES})로 돈다. 그런데
 * <b>운영은 {@code news_app}으로 뜬다</b> — {@code SELECT/INSERT/UPDATE} + {@code ReceiverConfig} 테이블
 * 단위 {@code DELETE} 하나뿐인 계정이다. 그 조합이 어느 게이트에서도 시험되지 않으면 "권한 부족이 500으로
 * 새는" 상태를 아무도 보지 못한다. 그래서 스모크와 권한 경계 측정만은 이 자격으로 돈다.
 *
 * <h2>대상 DB는 왜 {@code news_stage}인가</h2>
 * {@code news_app}은 {@code harness_ct_*}에 <b>권한이 0</b>이다(부트스트랩이 {@code news}·
 * {@code news_stage}·{@code news_grant_probe}에만 준다). 임시 DB로 이 측정을 하면 모든 쿼리가 거부되어
 * "6/6 거부"가 <b>아무것도 증명하지 않는 공허한 green</b>이 된다 — 성공과 거부가 <b>같은 DB·같은 자격</b>에서
 * 갈려야 경계가 실재한다.
 *
 * <h2>키 이름이 {@code NEWS_DB_*}가 <b>아닌</b> 이유(실측 제약)</h2>
 * 서버가 읽는 키({@code NEWS_DB_URL}·{@code NEWS_DB_USERNAME}·{@code NEWS_DB_PASSWORD})를 테스트 JVM의
 * 환경에 그대로 두면 <b>스위트 전체가 뜨지 않는다</b>: {@code DB_KIND} 기본값은 {@code sqlite}인데
 * {@code NEWS_DB_URL}은 MySQL을 가리키므로 step5가 세운 <b>kind/URL 모순 거부</b>에 걸려 모든
 * {@code @SpringBootTest}가 컨텍스트 로딩에서 죽는다(설계된 거부이지 회귀가 아니다).
 *
 * <p>그래서 <b>같은 값</b>을 테스트 전용 키 이름으로 옮겨 싣는다 — {@code NEWS_CT_MYSQL_*}가 이미 쓰는
 * "하네스가 읽는 키" 규약을 그대로 따르는 것이고, 비밀의 출처는 여전히 리포 밖 env 파일 하나다
 * (docs/ops-mysql.md §3에 셸 한 줄로 적혀 있다). 새 비밀을 만들지 않는다.
 *
 * <p>URL은 {@code news}를 가리키므로 <b>경로(데이터베이스 이름)만</b> 바꿔 쓴다 — 그 조립은
 * {@link EphemeralMysqlDb#urlForDatabase} 하나가 소유한다(순수 함수 · 단위 테스트됨).
 */
public final class NewsAppMysql {

	/** 서버 런타임 접속 URL 키(테스트 전용 이름) — 값의 데이터베이스 이름만 바꿔 쓴다. */
	public static final String URL_KEY = "NEWS_APP_MYSQL_URL";

	/** 서버 런타임 계정 키(테스트 전용 이름). */
	public static final String USERNAME_KEY = "NEWS_APP_MYSQL_USERNAME";

	/** 서버 런타임 비밀번호 키(테스트 전용 이름) — 값은 리포 밖 env 파일에만 있다. */
	public static final String PASSWORD_KEY = "NEWS_APP_MYSQL_PASSWORD";

	/** 이관 리허설·스테이징 DB(step3·step4의 대상). 스모크와 권한 경계 측정이 여기서 돈다. */
	public static final String STAGING_DATABASE = "news_stage";

	/**
	 * 권한 판정 전용 껍데기 DB(step0이 만들었다) — {@code ReceiverConfig}·{@code Contents} 두 테이블에
	 * {@code probe_only} 컬럼 하나뿐이고 뉴스 데이터가 절대 들어가지 않는다. "예외 1건 허용 · 나머지 거부"를
	 * <b>같은 DB·같은 자격</b>으로 실증하는 자리다.
	 */
	public static final String GRANT_PROBE_DATABASE = "news_grant_probe";

	/**
	 * {@code SHOW GRANTS} 한 줄의 형태 — {@code GRANT <권한들> ON <스키마>.<대상> TO ...}.
	 * 스키마·대상은 백틱이 붙기도 하고({@code `news_stage`.`receiverconfig`}) 안 붙기도 한다({@code *.*}).
	 */
	private static final Pattern GRANT_LINE =
			Pattern.compile("^GRANT\\s+(.+?)\\s+ON\\s+(\\S+)\\.(\\S+)\\s+TO\\s", Pattern.CASE_INSENSITIVE);

	private NewsAppMysql() {
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
	 * 설정이 없으면 <b>던진다</b>(skip이 아니다 — decisions (14)).
	 *
	 * @throws IllegalStateException 환경변수가 하나라도 비었을 때
	 */
	public static void requireConfigured() {
		List<String> missing = missingKeys();
		if (!missing.isEmpty()) {
			throw new IllegalStateException("서버 런타임 MySQL 접속 환경변수가 없습니다: " + missing
					+ " — docs/ops-mysql.md §3 절차로 리포 밖 env 파일을 셸에 로드한 뒤, 서버가 읽는 키를 "
					+ "테스트 전용 이름으로 옮겨 싣고(NEWS_DB_* → " + URL_KEY + " 등) NEWS_DB_* 는 지우세요. "
					+ "(NEWS_DB_URL 이 환경에 남아 있으면 DB_KIND 기본값 sqlite 와 모순되어 모든 기동 테스트가 "
					+ "거부됩니다 — 설계된 거부입니다.) 이 테스트는 조용히 건너뛰지 않습니다.");
		}
	}

	/** 주어진 데이터베이스를 가리키는 서버 설정({@code app.db.*}) — 자격은 {@code news_app}이다. */
	public static DbProperties forDatabase(String database) {
		requireConfigured();
		return new DbProperties(DbProperties.MYSQL,
				EphemeralMysqlDb.urlForDatabase(System.getenv(URL_KEY), database),
				System.getenv(USERNAME_KEY), System.getenv(PASSWORD_KEY));
	}

	/** 주어진 데이터베이스로 새 연결을 연다(호출자가 닫는다). */
	public static Connection open(String database) throws SQLException {
		DbProperties db = forDatabase(database);
		return DriverManager.getConnection(db.url(), db.username(), db.password());
	}

	/**
	 * 이 자격이 <b>실제로 들고 있는</b> 테이블 단위 {@code DELETE} 권한(소문자 테이블 이름).
	 *
	 * <p>기대값을 코드에 박지 않고 서버에게 묻는 이유는 둘이다. ① 권한은 root가 손으로 부여하므로 리포가
	 * 통제하지 못한다 — 박아 두면 부여 시점에 따라 테스트가 red/green을 오간다. ② 진짜 물어야 할 질문은
	 * "우리가 기대한 표와 같은가"가 아니라 <b>"서버가 자기 grant 표대로 실제로 막는가"</b>이고, 그것은
	 * 선언(SHOW GRANTS)과 행동(실제 문장)을 대조해야만 답할 수 있다.
	 *
	 * @param database 대상 스키마 이름
	 * @return 테이블 단위 DELETE가 부여된 테이블 이름 집합. 스키마 전체({@code db.*})에 DELETE가 있으면
	 *     {@link #ALL_TABLES} 하나를 담는다
	 */
	public static Set<String> tablesWithDeleteGrant(String database) throws SQLException {
		Set<String> tables = new LinkedHashSet<>();
		for (String line : showGrants(database)) {
			Matcher matcher = GRANT_LINE.matcher(line);
			if (!matcher.find()) {
				continue;
			}
			String privileges = matcher.group(1).toUpperCase(Locale.ROOT);
			String schema = unquote(matcher.group(2));
			String target = unquote(matcher.group(3));
			boolean deletes = privileges.contains("DELETE") || privileges.contains("ALL PRIVILEGES");
			if (!deletes || !schema.equalsIgnoreCase(database)) {
				continue;
			}
			tables.add("*".equals(target) ? ALL_TABLES : target.toLowerCase(Locale.ROOT));
		}
		return tables;
	}

	/** 스키마 전체 DELETE를 뜻하는 표식 — 테이블 이름이 될 수 없는 문자열이다. */
	public static final String ALL_TABLES = "*";

	/** {@code SHOW GRANTS} 원문 줄 목록(자격은 담기지 않는다 — 계정 이름과 권한뿐이다). */
	public static List<String> showGrants(String database) throws SQLException {
		List<String> lines = new ArrayList<>();
		try (Connection connection = open(database);
				Statement statement = connection.createStatement();
				ResultSet rs = statement.executeQuery("SHOW GRANTS")) {
			while (rs.next()) {
				lines.add(rs.getString(1));
			}
		}
		return lines;
	}

	private static String unquote(String identifier) {
		return identifier.replace("`", "");
	}
}
