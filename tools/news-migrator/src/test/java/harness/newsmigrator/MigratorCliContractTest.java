package harness.newsmigrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * CLI <b>계약</b> — 커맨드 이름 · 옵션 · 종료코드. 구현은 후속 step 이 채우지만 <b>계약은 지금 고정</b>한다.
 *
 * <p>지금 고정하는 이유: step4 의 AC 가 {@code verify --source <db> --target-sqlite <db>} 를 그대로
 * 호출하고, step7 의 계약 하네스가 {@code ephemeral-create}/{@code ephemeral-drop} 을 그대로 호출한다.
 * 그때 이름이 바뀌면 그 step 의 AC 문장이 거짓이 된다.
 *
 * <p><b>실패는 조용히 0을 내지 않는다.</b> 아직 구현되지 않은 커맨드도 <b>비-0</b>으로 끝난다 — 이
 * 게이트가 없으면 "골격만 있는 마이그레이터"가 런북에서 성공으로 읽힌다.
 */
class MigratorCliContractTest {

	@Test
	void theCommandSetIsFrozen() {
		assertEquals(List.of("migrate", "verify", "export", "ephemeral-create", "ephemeral-drop", "help"),
				MigratorCli.COMMANDS,
				"CLI 커맨드 집합이 계획서와 다르다(step4·step7 의 AC 문장이 이 이름을 그대로 부른다)");
	}

	@Test
	void helpSucceedsAndListsEveryCommand() {
		Output output = run("help");

		assertEquals(0, output.code(), "help 는 성공이다");
		for (String command : MigratorCli.COMMANDS) {
			assertTrue(output.out().contains(command), "사용법에 커맨드가 빠졌다: " + command);
		}
	}

	@Test
	void noArgumentsIsAUsageErrorNotASilentSuccess() {
		Output output = run();

		assertEquals(MigratorCli.EXIT_USAGE, output.code(), "인자 없이 부르면 사용법 오류다");
		assertTrue(output.err().contains("migrate"), "사용법을 표준오류로 알리지 않는다: " + output.err());
	}

	@Test
	void anUnknownCommandFails() {
		assertEquals(MigratorCli.EXIT_USAGE, run("wipe").code(), "모르는 커맨드가 성공으로 끝난다");
		assertEquals(MigratorCli.EXIT_USAGE, run("migrate", "--source").code(), "값 없는 옵션이 성공으로 끝난다");
		assertEquals(MigratorCli.EXIT_USAGE, run("migrate", "--unknown", "x").code(), "모르는 옵션이 성공으로 끝난다");
	}

	/**
	 * <b>비밀은 argv 로 흐르지 않는다</b>(decisions (7)) — 프로세스 목록은 같은 머신의 누구나 읽는다.
	 * 그래서 자격은 <b>환경변수 키 집합 이름</b>으로만 지목한다.
	 */
	@Test
	void credentialsCanNeverBePassedOnTheCommandLine() {
		for (String[] attempt : List.of(
				new String[] { "migrate", "--source", "news.db", "--target", "NEWS_MIGRATOR", "--password", "hunter2" },
				new String[] { "migrate", "--source", "news.db", "--target", "NEWS_MIGRATOR", "-p", "hunter2" },
				new String[] { "migrate", "--source", "news.db", "--target", "NEWS_MIGRATOR", "--username", "root" })) {
			Output output = run(attempt);
			assertEquals(MigratorCli.EXIT_USAGE, output.code(), "자격을 argv 로 받았다: " + String.join(" ", attempt));
			assertTrue(output.err().contains("환경변수"), "거부 이유가 자격 위생임을 밝히지 않는다: " + output.err());
		}
	}

	/** {@code --target} 은 <b>키 집합 이름</b>이다 — URL 이나 값이 오면 거부한다(자격이 argv 로 새는 첫 걸음이다). */
	@Test
	void theTargetOptionTakesAnEnvironmentKeySetNameNotAUrl() {
		assertEquals(MigratorCli.EXIT_USAGE,
				run("migrate", "--source", "news.db", "--target", "jdbc:mysql://127.0.0.1:3306/news").code(),
				"--target 이 URL 을 받아들인다");
		assertEquals(MigratorCli.EXIT_USAGE,
				run("migrate", "--source", "news.db", "--target", "news_migrator").code(),
				"--target 이 키 집합 이름 규약(대문자·숫자·밑줄)을 강제하지 않는다");
	}

	/**
	 * 아직 구현되지 않은 커맨드는 <b>비-0</b>으로 끝나고 어느 step 이 채우는지 밝힌다.
	 *
	 * <p>이 단언이 이 step 의 정직성 장치다 — 골격이 성공을 흉내 내면 그 순간부터 "이관이 됐다"는
	 * 거짓 신호가 런북과 다음 step 의 전제로 흘러 들어간다.
	 */
	@Test
	void theUnimplementedCommandsFailLoudlyAndNameTheirOwningStep() {
		for (String[] attempt : List.of(
				new String[] { "migrate", "--source", "news.db", "--target", "NEWS_MIGRATOR" },
				new String[] { "verify", "--source", "news.db", "--target", "NEWS_MIGRATOR" },
				new String[] { "verify", "--source", "news.db", "--target-sqlite", "export.db" },
				new String[] { "export", "--target", "NEWS_MIGRATOR", "--out", "export.db" })) {
			Output output = run(attempt);
			assertEquals(MigratorCli.EXIT_UNIMPLEMENTED, output.code(),
					"미구현 커맨드가 성공하거나 다른 코드로 끝난다: " + String.join(" ", attempt));
			assertTrue(output.err().contains("step"), "어느 step 이 채우는지 밝히지 않는다: " + output.err());
			assertNotEquals(0, output.code(), "미구현이 조용한 성공이 됐다");
		}
	}

	/** 각 커맨드의 <b>필수 옵션</b>이 빠지면 사용법 오류다(옵션을 조용히 기본값으로 채우지 않는다). */
	@Test
	void everyCommandRequiresItsMandatoryOptions() {
		assertEquals(MigratorCli.EXIT_USAGE, run("migrate", "--target", "NEWS_MIGRATOR").code(), "migrate 에 --source 가 없다");
		assertEquals(MigratorCli.EXIT_USAGE, run("migrate", "--source", "news.db").code(), "migrate 에 --target 이 없다");
		assertEquals(MigratorCli.EXIT_USAGE, run("verify", "--source", "news.db").code(),
				"verify 에 대상(--target · --target-sqlite)이 없다");
		assertEquals(MigratorCli.EXIT_USAGE,
				run("verify", "--source", "a.db", "--target", "NEWS_MIGRATOR", "--target-sqlite", "b.db").code(),
				"verify 가 두 대상을 동시에 받아들인다(어느 쪽과 대조했는지 알 수 없어진다)");
		assertEquals(MigratorCli.EXIT_USAGE, run("export", "--target", "NEWS_MIGRATOR").code(), "export 에 --out 이 없다");
		assertEquals(MigratorCli.EXIT_USAGE, run("ephemeral-create").code(), "ephemeral-create 에 --name 이 없다");
		assertEquals(MigratorCli.EXIT_USAGE, run("ephemeral-drop").code(), "ephemeral-drop 에 --name 이 없다");
	}

	/**
	 * <b>M6 의 CLI 쪽 절반</b> — 임시 DB 규약을 벗어난 이름은 <b>접속조차 하기 전에</b> 거부된다.
	 *
	 * <p>여기서 거부되므로 환경변수가 없는 환경에서도 이 단언이 성립한다(=거부가 "설정이 없어서"가 아니다).
	 */
	@Test
	void ephemeralCommandsRefuseAnyNameOutsideTheReservedShape() {
		for (String name : List.of("news", "news_stage", "harness_ct_", "harness_ct_0123456789abcde",
				"harness_ct_0123456789ABCDEF", "harness_ct_0123456789abcdef0", "mysql", "*")) {
			for (String command : List.of("ephemeral-create", "ephemeral-drop")) {
				Output output = run(command, "--name", name);
				assertEquals(MigratorCli.EXIT_USAGE, output.code(), command + " 가 규약 밖 이름을 받아들였다: " + name);
				assertTrue(output.err().contains("harness_ct_"), "거부 이유에 규약을 밝히지 않는다: " + output.err());
			}
		}
	}

	/** 표준출력·표준오류 어디에도 비밀이 흐르지 않는다(사용법 문구는 <b>키 이름</b>만 말한다). */
	@Test
	void theUsageTextNamesKeysNeverValues() {
		String usage = run("help").out();

		assertTrue(usage.contains("_URL") && usage.contains("_USERNAME") && usage.contains("_PASSWORD"),
				"사용법이 환경변수 키 규약을 설명하지 않는다");
		assertFalse(usage.contains("--password"), "사용법이 비밀번호 옵션을 광고한다");
	}

	private static Output run(String... args) {
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		ByteArrayOutputStream err = new ByteArrayOutputStream();
		int code;
		try (PrintStream outStream = new PrintStream(out, true, StandardCharsets.UTF_8);
				PrintStream errStream = new PrintStream(err, true, StandardCharsets.UTF_8)) {
			code = MigratorCli.run(args, outStream, errStream);
		}
		return new Output(code, out.toString(StandardCharsets.UTF_8), err.toString(StandardCharsets.UTF_8));
	}

	private record Output(int code, String out, String err) {
	}

}
