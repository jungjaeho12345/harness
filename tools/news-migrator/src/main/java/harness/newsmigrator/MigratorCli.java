package harness.newsmigrator;

import java.io.PrintStream;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 마이그레이터의 커맨드라인 <b>계약</b>.
 *
 * <h2>이 step 이 고정하는 것과 고정하지 않는 것</h2>
 * 커맨드 이름 · 옵션 · 종료코드는 <b>지금</b> 고정한다 — step4 의 AC 가
 * {@code verify --source <db> --target-sqlite <db>} 를 그대로 부르고, step7 의 계약 하네스가
 * {@code ephemeral-create}/{@code ephemeral-drop} 을 그대로 부른다. 그때 이름이 바뀌면 그 step 들의 AC
 * 문장이 거짓이 된다. 반면 행 복사·대조·역방향 export 의 <b>구현</b>은 이 step 의 범위가 아니다
 * (step3·step4가 소유한다).
 *
 * <h2>미구현은 조용한 성공이 되지 않는다</h2>
 * 아직 채워지지 않은 커맨드는 {@link #EXIT_UNIMPLEMENTED} 로 끝나고 어느 step 이 소유하는지 밝힌다.
 * 골격이 0을 내면 그 순간부터 "이관이 됐다"는 거짓 신호가 런북과 다음 step 의 전제로 흘러 들어간다.
 *
 * <h2>자격은 argv 로 흐르지 않는다</h2>
 * {@code --target} 은 <b>환경변수 키 집합 이름</b>만 받는다(값도 URL 도 아니다). 비밀번호·사용자명을
 * 인자로 주려는 시도는 형태 단계에서 거부한다 — 프로세스 목록은 같은 머신의 누구나 읽는다.
 */
public final class MigratorCli {

	/** 성공. */
	public static final int EXIT_OK = 0;

	/** 실행 실패(접속·적용 중 오류). */
	public static final int EXIT_FAILURE = 1;

	/** 사용법 오류(모르는 커맨드·빠진 옵션·규약 밖 값). */
	public static final int EXIT_USAGE = 2;

	/** 아직 이 step 이 채우지 않은 커맨드. <b>0이 아니다.</b> */
	public static final int EXIT_UNIMPLEMENTED = 3;

	/** 커맨드 집합(순서까지 계약이다 — 사용법 출력이 이 순서로 나온다). */
	public static final List<String> COMMANDS =
			List.of("migrate", "verify", "export", "ephemeral-create", "ephemeral-drop", "help");

	/** 자격을 인자로 넘기려는 시도 — 형태만 보고 거부한다. */
	private static final List<String> FORBIDDEN_OPTIONS =
			List.of("--password", "--pass", "-p", "--username", "--user", "-u", "--url");

	private static final List<String> KNOWN_OPTIONS =
			List.of("--source", "--target", "--target-sqlite", "--out", "--name");

	/** 하네스가 {@code --target} 없이 부를 때 쓰는 임시 DB 자격의 키 집합. */
	private static final String DEFAULT_EPHEMERAL_KEY_SET = "NEWS_CT_MYSQL";

	private MigratorCli() {
	}

	public static void main(String[] args) {
		System.exit(run(args, System.out, System.err));
	}

	/**
	 * 커맨드 하나를 실행하고 종료코드를 돌려준다.
	 *
	 * @param args 커맨드라인 인자
	 * @param out 사람이 읽는 정상 출력
	 * @param err 실패 이유
	 * @return {@link #EXIT_OK} 또는 그 밖의 실패 코드 — <b>실패가 0을 내는 경로는 없다.</b>
	 */
	public static int run(String[] args, PrintStream out, PrintStream err) {
		if (args == null || args.length == 0) {
			usage(err);
			return EXIT_USAGE;
		}
		String command = args[0];
		if ("help".equals(command) || "--help".equals(command) || "-h".equals(command)) {
			usage(out);
			return EXIT_OK;
		}
		if (!COMMANDS.contains(command)) {
			err.println("모르는 커맨드입니다: " + command);
			usage(err);
			return EXIT_USAGE;
		}

		Map<String, String> options;
		try {
			options = parseOptions(args);
		}
		catch (IllegalArgumentException ex) {
			err.println(ex.getMessage());
			usage(err);
			return EXIT_USAGE;
		}

		try {
			return switch (command) {
				case "migrate" -> migrate(options, err);
				case "verify" -> verify(options, err);
				case "export" -> export(options, err);
				case "ephemeral-create" -> ephemeral(options, out, err, true);
				case "ephemeral-drop" -> ephemeral(options, out, err, false);
				default -> {
					usage(err);
					yield EXIT_USAGE;
				}
			};
		}
		catch (IllegalArgumentException ex) {
			err.println(ex.getMessage());
			return EXIT_USAGE;
		}
		catch (IllegalStateException ex) {
			err.println(ex.getMessage());
			return EXIT_FAILURE;
		}
	}

	// --- 커맨드 ---

	private static int migrate(Map<String, String> options, PrintStream err) {
		require(options, "--source", "--target");
		requireKeySet(options.get("--target"));
		err.println("migrate 는 아직 구현되지 않았습니다 — phase 75 step3(row-copy-verify)이 채웁니다.");
		return EXIT_UNIMPLEMENTED;
	}

	private static int verify(Map<String, String> options, PrintStream err) {
		require(options, "--source");
		boolean mysql = options.containsKey("--target");
		boolean sqlite = options.containsKey("--target-sqlite");
		if (mysql == sqlite) {
			throw new IllegalArgumentException(
					"verify 는 대상 하나만 받습니다: --target(환경변수 키 집합) 또는 --target-sqlite(파일)");
		}
		if (mysql) {
			requireKeySet(options.get("--target"));
		}
		err.println("verify 는 아직 구현되지 않았습니다 — MySQL 대조는 phase 75 step3, "
				+ "SQLite 왕복 대조는 step4(reverse-export)가 채웁니다.");
		return EXIT_UNIMPLEMENTED;
	}

	private static int export(Map<String, String> options, PrintStream err) {
		require(options, "--target", "--out");
		requireKeySet(options.get("--target"));
		err.println("export 는 아직 구현되지 않았습니다 — phase 75 step4(reverse-export)가 채웁니다.");
		return EXIT_UNIMPLEMENTED;
	}

	/**
	 * 임시 DB 를 만들거나 버린다. 이름 규약({@link EphemeralDatabase#EPHEMERAL_NAME})을 <b>접속 전에</b>
	 * 확인하므로, 환경변수가 없는 환경에서도 규약 밖 이름은 여기서 멈춘다.
	 */
	private static int ephemeral(Map<String, String> options, PrintStream out, PrintStream err, boolean create) {
		require(options, "--name");
		String name = EphemeralDatabase.requireEphemeralName(options.get("--name"));
		String keySet = options.getOrDefault("--target", DEFAULT_EPHEMERAL_KEY_SET);
		requireKeySet(keySet);
		TargetCredentials server = TargetCredentials.of(keySet, System::getenv);
		if (create) {
			EphemeralDatabase.create(server, name);
			out.println("created " + name);
		}
		else {
			EphemeralDatabase.drop(server, name);
			out.println("discarded " + name);
		}
		return EXIT_OK;
	}

	// --- 인자 처리 ---

	private static Map<String, String> parseOptions(String[] args) {
		Map<String, String> options = new LinkedHashMap<>();
		for (int i = 1; i < args.length; i++) {
			String key = args[i];
			if (FORBIDDEN_OPTIONS.contains(key)) {
				throw new IllegalArgumentException("자격은 인자로 받지 않습니다(" + key
						+ ") — 프로세스 목록에 그대로 남습니다. 값은 환경변수 키 집합으로만 전달합니다"
						+ "(docs/ops-mysql.md §3).");
			}
			if (!KNOWN_OPTIONS.contains(key)) {
				throw new IllegalArgumentException("모르는 옵션입니다: " + key);
			}
			if (i + 1 >= args.length) {
				throw new IllegalArgumentException("옵션에 값이 없습니다: " + key);
			}
			options.put(key, args[++i]);
		}
		return options;
	}

	private static void require(Map<String, String> options, String... required) {
		for (String option : required) {
			if (!options.containsKey(option) || options.get(option).isBlank()) {
				throw new IllegalArgumentException("필수 옵션이 없습니다: " + option);
			}
		}
	}

	private static void requireKeySet(String keySet) {
		if (keySet == null || !TargetCredentials.KEY_SET_NAME.matcher(keySet).matches()) {
			throw new IllegalArgumentException("--target 은 환경변수 키 집합 이름입니다"
					+ "(규약 " + TargetCredentials.KEY_SET_NAME.pattern() + "): " + keySet
					+ " — URL 이나 값이 아니라 NEWS_MIGRATOR 같은 이름을 줍니다.");
		}
	}

	private static void usage(PrintStream stream) {
		stream.println("news-migrator — news.db(SQLite) → MySQL 8.0 이관 도구 (phase 75 / P2)");
		stream.println();
		stream.println("  migrate          --source <sqlite-file> --target <env-key-set>");
		stream.println("  verify           --source <sqlite-file> --target <env-key-set>");
		stream.println("  verify           --source <sqlite-file> --target-sqlite <sqlite-file>");
		stream.println("  export           --target <env-key-set> --out <sqlite-file>");
		stream.println("  ephemeral-create --name <" + EphemeralDatabase.NAME_PREFIX + "…> [--target <env-key-set>]");
		stream.println("  ephemeral-drop   --name <" + EphemeralDatabase.NAME_PREFIX + "…> [--target <env-key-set>]");
		stream.println("  help");
		stream.println();
		stream.println("자격은 환경변수에서만 옵니다. <env-key-set> 은 키 이름의 앞부분입니다:");
		stream.println("  <env-key-set>_URL · <env-key-set>_USERNAME · <env-key-set>_PASSWORD");
		stream.println("값을 인자로 주는 방법은 없습니다 — 절차는 docs/ops-mysql.md §3 을 보세요.");
	}

}
