package harness.newsmigrator;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SQLite 측 스키마 <b>정본</b>({@code src/db/schema.js})을 기계로 읽는다.
 *
 * <p>왜 파싱하는가: 이 모듈의 Flyway 기반선({@code V1__baseline.sql})은 정본의 <b>번역</b>이지 새 결정이
 * 아니다. 두 파일을 사람이 눈으로 맞추면 컬럼 하나가 조용히 어긋나고, 그 어긋남은 step3 의 전 행 대조가
 * 아니라 <b>운영 데이터가 들어간 뒤</b>에 드러난다. 그래서 대조를 기계에 맡긴다 — 정본에 컬럼이 늘면
 * {@code BaselineMatchesCanonicalSchemaTest} 가 red 로 알린다.
 *
 * <p>정본은 Node 서버가 소유하고 이 모듈은 <b>읽기만</b> 한다(무접촉 목록: {@code src/**}).
 */
record CanonicalSchema(Map<String, List<CanonicalSchema.Column>> tables) {

	/** 정본의 한 컬럼 — 이름과 SQLite 정의 원문({@code "TEXT DEFAULT 'Y'"} 같은 것). */
	record Column(String name, String definition) {

		boolean isPrimaryKey() {
			return definition().toUpperCase(java.util.Locale.ROOT).contains("PRIMARY KEY");
		}

		boolean isInteger() {
			return definition().toUpperCase(java.util.Locale.ROOT).startsWith("INTEGER");
		}

		/** {@code DEFAULT 'Y'} 의 {@code Y} — 없으면 {@code null}. */
		String defaultValue() {
			Matcher matcher = DEFAULT_LITERAL.matcher(definition());
			return matcher.find() ? matcher.group(1) : null;
		}

	}

	/** 리포 루트 기준 정본 경로(이 모듈의 작업 디렉토리는 {@code tools/news-migrator} 다). */
	static final Path SCHEMA_JS = Path.of("..", "..", "src", "db", "schema.js");

	private static final Pattern DEFAULT_LITERAL = Pattern.compile("(?i)\\bDEFAULT\\s+'([^']*)'");

	/** 테이블 머리({@code User: [}) 또는 컬럼 항목({@code ['userId', 'TEXT PRIMARY KEY']}). */
	private static final Pattern ENTRY = Pattern.compile(
			"(?<table>[A-Za-z_]\\w*)\\s*:\\s*\\[" + "|"
					+ "\\[\\s*'(?<column>[A-Za-z_]\\w*)'\\s*,\\s*(?:'(?<single>[^']*)'|\"(?<double>[^\"]*)\")\\s*\\]");

	static CanonicalSchema load() {
		return parse(read(SCHEMA_JS));
	}

	static String read(Path path) {
		if (!Files.isRegularFile(path)) {
			throw new IllegalStateException(
					"스키마 정본을 찾지 못했다(경로가 깨졌다 — 조용히 건너뛰지 않는다): " + path.toAbsolutePath());
		}
		try {
			return Files.readString(path, StandardCharsets.UTF_8);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	/**
	 * {@code const SCHEMA = { ... };} 블록만 읽는다 — 그 아래 백필 함수의 SQL 은 스키마가 아니다.
	 */
	static CanonicalSchema parse(String source) {
		int start = source.indexOf("const SCHEMA = {");
		int end = source.indexOf("\n};", start);
		if (start < 0 || end < 0) {
			throw new IllegalStateException("정본에서 SCHEMA 선언을 찾지 못했다 — 파서가 낡았다");
		}
		String body = source.substring(start, end);

		Map<String, List<Column>> tables = new LinkedHashMap<>();
		List<Column> current = null;
		Matcher matcher = ENTRY.matcher(body);
		while (matcher.find()) {
			String table = matcher.group("table");
			if (table != null) {
				current = new ArrayList<>();
				tables.put(table, current);
				continue;
			}
			if (current == null) {
				throw new IllegalStateException("테이블 머리보다 컬럼이 먼저 나왔다: " + matcher.group("column"));
			}
			String definition = (matcher.group("single") != null) ? matcher.group("single") : matcher.group("double");
			current.add(new Column(matcher.group("column"), definition));
		}
		if (tables.isEmpty()) {
			throw new IllegalStateException("정본에서 테이블을 하나도 읽지 못했다 — 파서가 낡았다");
		}
		return new CanonicalSchema(tables);
	}

	List<String> columnNames(String table) {
		return tables().get(table).stream().map(Column::name).toList();
	}

}
