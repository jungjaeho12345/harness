package harness.news.db;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 저장소 방언 선택 바인딩({@code app.db.*}) — <b>명시 주입이고 추론이 없다</b>(ADR-016 · 포팅 불변식 7).
 *
 * <h2>왜 URL을 보고 방언을 정하지 않는가</h2>
 * "URL이 MySQL이면 MySQL"이라는 규칙은 편해 보이지만, 그 규칙 아래에서는 <b>URL을 빠뜨린 배포가 조용히
 * SQLite로 뜬다</b>. 이관 중에 가장 흔한 사고가 정확히 그것이고(환경변수 하나 누락), 결과는 "옮겼다고
 * 믿는 사람"과 "옛 파일에 쓰는 서버"다 — 두 저장소의 내용이 갈린 뒤에야 드러나고 그때는 병합이 불가능하다.
 * 그래서 판정 입력은 {@code app.db.kind} <b>하나</b>이고, URL은 그 선택과 <b>일치하는지 검증만</b> 받는다.
 * 둘이 모순이면 무엇이 진심인지 알 수 없으므로 기동을 거부한다(모르면 뜨지 않는다 — {@code AppProperties}의
 * {@code app.data-dir} 규율과 같은 자리다).
 *
 * <h2>왜 {@code harness.news.config}가 아니라 여기 있는가</h2>
 * 이 레코드는 {@link NewsDataSource}의 URL 접두사 상수를 참조한다 — 방언 <b>철자</b>가 한 파일에만 있게
 * 하려는 것이고({@code DialectSeamTest}), 설정 패키지에 두면 {@code config → db} 방향 의존이 생겨
 * {@code db → config}(현재 {@code DbConfig}가 {@code AppProperties}를 읽는다)와 함께 패키지 순환이 된다.
 * 소비자도 {@link DbConfig} 하나뿐이라 그 클래스가 바인딩을 활성화한다.
 *
 * <p><b>비밀은 메시지에 싣지 않는다.</b> 실패 메시지에 URL을 그대로 실으면 자격이 박힌 URL이 기동 로그로
 * 샌다 — 권한부(authority) 이후는 잘라 낸다({@link NewsDataSource#describeTarget}와 같은 규율).
 *
 * @param kind {@code sqlite}(기본) 또는 {@code mysql}. 환경변수 {@code DB_KIND}
 * @param url mysql 모드의 JDBC URL(환경변수 {@code NEWS_DB_URL}). 접속 파라미터는 이 값이 통째로 실어
 *     온다 — 이 서버가 덧붙이지 않는다(docs/db-mysql-mapping.md §5). <b>자격을 URL에 넣지 않는다.</b>
 * @param username mysql 모드의 계정(환경변수 {@code NEWS_DB_USERNAME})
 * @param password mysql 모드의 비밀번호(환경변수 {@code NEWS_DB_PASSWORD}). 다듬지 않는다 — 앞뒤 공백도
 *     비밀번호의 일부일 수 있다
 */
@ConfigurationProperties("app.db")
public record DbProperties(String kind, String url, String username, String password) {

	/** 기본 방언. 이 값이 흔들리면 기존 배포가 다른 저장소로 뜬다 — 바꾸는 것은 별도 결정이다. */
	public static final String SQLITE = "sqlite";

	/** phase 75가 들여오는 두 번째 방언(MySQL 8.0 — decisions (1)). */
	public static final String MYSQL = "mysql";

	private static final String URL_KEY = "NEWS_DB_URL";

	private static final String USERNAME_KEY = "NEWS_DB_USERNAME";

	private static final String PASSWORD_KEY = "NEWS_DB_PASSWORD";

	public DbProperties {
		kind = (kind == null || kind.isBlank()) ? SQLITE : kind.trim().toLowerCase(Locale.ROOT);
		url = (url == null) ? "" : url.trim();
		username = (username == null) ? "" : username.trim();
		password = (password == null) ? "" : password;

		if (!SQLITE.equals(kind) && !MYSQL.equals(kind)) {
			throw new IllegalArgumentException("app.db.kind 값을 알 수 없습니다: " + kind
					+ " — 허용 값은 " + SQLITE + " 또는 " + MYSQL + " 입니다(환경변수 DB_KIND). "
					+ "이 서버는 저장소를 추측하지 않습니다.");
		}
		if (MYSQL.equals(kind)) {
			List<String> missing = new ArrayList<>();
			if (url.isBlank()) {
				missing.add(URL_KEY);
			}
			if (username.isBlank()) {
				missing.add(USERNAME_KEY);
			}
			if (password.isBlank()) {
				missing.add(PASSWORD_KEY);
			}
			if (!missing.isEmpty()) {
				throw new IllegalArgumentException("app.db.kind=" + MYSQL + " 인데 접속 정보가 없습니다: "
						+ String.join(", ", missing)
						+ " — 값을 주입하거나 DB_KIND 를 " + SQLITE + " 로 되돌리세요. "
						+ "이 서버는 접속 정보가 없다고 조용히 " + SQLITE + " 로 되돌아가지 않습니다.");
			}
		}
		requireUrlMatchesKind(kind, url);
	}

	/** 이 설정이 MySQL을 가리키는가 — 분기 판정의 <b>단일 출처</b>다({@link NewsDataSource}). */
	public boolean mysql() {
		return MYSQL.equals(this.kind);
	}

	/**
	 * URL이 있으면 그 스킴이 선택한 방언과 같아야 한다 — 다르면 <b>모순</b>이고 기동을 거부한다.
	 *
	 * <p>비어 있는 URL은 모순이 아니다(sqlite 모드에서 {@code NEWS_DB_*}는 무시한다 — 남아 있는 환경변수가
	 * 기동을 막지 않는다). 반대로 <b>값이 있는데 다른 방언</b>이면 둘 중 무엇이 의도인지 알 수 없다.
	 */
	private static void requireUrlMatchesKind(String kind, String url) {
		if (url.isEmpty()) {
			return;
		}
		String expected = MYSQL.equals(kind) ? NewsDataSource.MYSQL_URL_PREFIX : NewsDataSource.SQLITE_URL_PREFIX;
		if (!url.toLowerCase(Locale.ROOT).startsWith(expected)) {
			throw new IllegalArgumentException("app.db.kind 와 app.db.url 이 서로 다른 저장소를 가리킵니다: "
					+ "kind=" + kind + " 인데 url 은 " + scheme(url) + " 로 시작합니다(기대: " + expected + "). "
					+ "이 서버는 URL 로 방언을 추론하지 않습니다 — DB_KIND 와 " + URL_KEY + " 를 맞추세요.");
		}
	}

	/**
	 * 메시지에 실어도 안전한 URL 앞부분 — 권한부({@code //호스트...})가 시작되기 <b>전까지</b>다.
	 * 자격이 박힌 URL(정책상 금지지만 운영 환경변수는 이 코드가 통제하지 않는다)이 로그로 새지 않게 한다.
	 */
	private static String scheme(String url) {
		int authority = url.indexOf("//");
		String head = (authority < 0) ? url : url.substring(0, authority);
		return (head.length() <= 40) ? head : head.substring(0, 40);
	}
}
