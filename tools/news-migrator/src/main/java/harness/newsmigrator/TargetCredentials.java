package harness.newsmigrator;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * 접속 자격 한 벌 — <b>환경변수 키 집합</b> 하나에서 온다.
 *
 * <h2>왜 argv 가 아닌가</h2>
 * 같은 머신의 어떤 프로세스든 다른 프로세스의 커맨드라인을 읽는다(Windows 도 예외가 아니다). 그래서
 * 비밀번호는 인자로 흐르지 않고, CLI 는 <b>키 집합 이름</b>({@code NEWS_MIGRATOR} 같은 것)만 받는다.
 * 값은 리포 밖 한 곳({@code docs/ops-mysql.md} §3)에만 있고 셸이 환경변수로 실어 준다.
 *
 * <h2>왜 조회 함수를 주입받는가</h2>
 * {@code System::getenv} 를 직접 부르면 이 클래스의 판정(무엇이 없는지 · 형태가 맞는지)을 환경변수 없이
 * 테스트할 수 없다. 주입해 두면 판정은 순수 함수가 되고, 실기 접속만 실제 환경을 쓴다.
 */
public record TargetCredentials(String keySet, String url, String username, String password) {

	/** 키 집합 이름 규약 — 대문자·숫자·밑줄. URL 이나 값이 이 자리에 오는 것을 형태로 막는다. */
	public static final Pattern KEY_SET_NAME = Pattern.compile("^[A-Z][A-Z0-9_]*$");

	private static final String SCHEME_SEPARATOR = "://";

	/** 키 집합 이름에서 세 키 이름을 만든다(순서 고정 — 진단 메시지가 흔들리지 않게). */
	public static List<String> keysOf(String keySet) {
		requireKeySetName(keySet);
		return List.of(keySet + "_URL", keySet + "_USERNAME", keySet + "_PASSWORD");
	}

	/**
	 * 환경변수에서 자격을 읽는다.
	 *
	 * @param keySet 키 집합 이름({@code NEWS_MIGRATOR} · {@code NEWS_CT_MYSQL} …)
	 * @param lookup 환경 조회 함수(보통 {@code System::getenv})
	 * @throws IllegalArgumentException 키 집합 이름이 규약 밖일 때
	 * @throws IllegalStateException 값이 하나라도 비었을 때 — <b>무엇이 없는지 지목하고 던진다.</b>
	 * 조용한 skip 이나 기본값 대입은 이 phase 의 게이트를 전부 공허하게 만든다.
	 */
	public static TargetCredentials of(String keySet, Function<String, String> lookup) {
		List<String> keys = keysOf(keySet);
		List<String> missing = new ArrayList<>();
		for (String key : keys) {
			String value = lookup.apply(key);
			if (value == null || value.isBlank()) {
				missing.add(key);
			}
		}
		if (!missing.isEmpty()) {
			throw new IllegalStateException("접속 환경변수가 없습니다: " + missing
					+ " — docs/ops-mysql.md §3 절차로 리포 밖 env 파일을 셸에 실은 뒤 다시 실행하세요."
					+ " (조용히 건너뛰지 않습니다.)");
		}
		return new TargetCredentials(keySet, lookup.apply(keys.get(0)).strip(), lookup.apply(keys.get(1)).strip(),
				lookup.apply(keys.get(2)));
	}

	/** 같은 자격으로 <b>다른 데이터베이스</b>를 가리킨다(경로만 바꾸고 질의 문자열은 보존한다). */
	public TargetCredentials forDatabase(String database) {
		int question = url().indexOf('?');
		String head = (question < 0) ? url() : url().substring(0, question);
		String query = (question < 0) ? "" : url().substring(question);
		int scheme = head.indexOf(SCHEME_SEPARATOR);
		if (scheme < 0) {
			throw new IllegalArgumentException(
					"접속 URL 형태를 알 수 없습니다(" + keySet() + "_URL) — 조용히 고쳐 엉뚱한 DB 를 가리키지 않습니다");
		}
		int path = head.indexOf('/', scheme + SCHEME_SEPARATOR.length());
		String authority = (path < 0) ? head : head.substring(0, path);
		return new TargetCredentials(keySet(), authority + "/" + database + query, username(), password());
	}

	/** 이 자격으로 새 연결을 연다. 호출자가 닫는다. */
	public static Connection open(TargetCredentials credentials) throws SQLException {
		return DriverManager.getConnection(credentials.url(), credentials.username(), credentials.password());
	}

	/** 로그·리포트에 실어도 되는 형태 — <b>비밀번호는 들어가지 않는다.</b> */
	public String describe() {
		return keySet() + " → " + url() + " (" + username() + ")";
	}

	/**
	 * 비밀번호를 가린 표현.
	 *
	 * <p>레코드의 자동 생성 {@code toString} 은 전 컴포넌트를 그대로 싣는다 — 예외 메시지 한 번, 로그
	 * 한 줄이면 비밀이 파일로 남는다. 그래서 덮어쓴다.
	 */
	@Override
	public String toString() {
		return "TargetCredentials[" + describe() + ", password=<" + keySet() + "_PASSWORD>]";
	}

	private static void requireKeySetName(String keySet) {
		if (keySet == null || !KEY_SET_NAME.matcher(keySet).matches()) {
			throw new IllegalArgumentException(
					"키 집합 이름이 규약(" + KEY_SET_NAME.pattern() + ")을 벗어납니다: " + keySet
							+ " — 여기에는 값이 아니라 환경변수 이름의 앞부분만 옵니다");
		}
	}

}
