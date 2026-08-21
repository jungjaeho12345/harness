package harness.news.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.ContentsRow;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Method;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * <b>투영 타입 경계</b>(index.json decisions (4)① · step11 D-10(i)) — 컨트롤러는 원본 행을 알지 못한다.
 *
 * <h2>왜 컬럼명 문자열 스캔이 아닌가(교체 근거)</h2>
 * 실제 누출 벡터는 "미투영 원본 행을 응답에 그대로 싣는 코드"인데 <b>그 코드에는
 * {@code lockerSessionId}·{@code lockerClientId} 문자열이 등장하지 않는다</b>(이름은 컬럼 목록 상수와 잠금
 * SQL에만 나오고 둘 다 화이트리스트다). 즉 이름 스캔은 이 벡터에서 green이라 "덮고 있다"는 착시만 준다.
 * 그래서 여기서는 <b>타입</b>을 본다: 리포지토리가 주는 {@link ContentsRow}가 컨트롤러 패키지의
 * <b>소스</b>와 <b>선언 시그니처</b>(필드·파라미터·반환 타입, 제네릭 실인자 포함) 어디에도 없어야 한다.
 * 컨트롤러가 손에 넣을 수 있는 것은 투영을 통과한 27키 맵뿐이다.
 *
 * <h2>이 층이 덮지 <b>못하는</b> 것</h2>
 * 지역 변수로만 원본 행을 다루는 우회는 시그니처에 나타나지 않는다(소스 스캔이 그 구멍을 좁히지만,
 * 서비스가 원본을 돌려주도록 바꾸면 컨트롤러 소스에도 타입 이름이 없을 수 있다). 그 벡터는
 * <b>직렬화 안전망</b>({@code harness.news.web.ResponseBodyProjectionGuardTest})과 와이어 테스트가 덮는다.
 * 두 층이 덮는 벡터는 <b>겹치지 않는다</b> — 같은 변이에 둘 다 red가 되기를 기대하지 마라(decisions (4)).
 *
 * <p>스캐너 자체가 아무것도 찾지 못하는 상태로 green이 되는 것을 막기 위해, 두 스캐너 모두
 * <b>심어 둔 위반</b>에서 반드시 red를 내는지 같은 테스트에서 확인한다(동어반복 방지).
 */
class ControllerProjectionBoundaryTest {

	/** 모듈 루트 기준 컨트롤러 패키지 소스 디렉토리(테스트 작업 디렉토리 = 모듈 루트). */
	private static final Path CONTROLLER_SOURCES = Path.of("src", "main", "java", "harness", "news", "controller");

	/** 스캐너가 정말로 탐지 능력을 갖는지 확인할 때 쓰는 <b>양성 대조</b> 파일(원본 타입을 실제로 다룬다). */
	private static final Path POSITIVE_CONTROL = Path.of("src", "main", "java", "harness", "news", "model",
			"ContentsProjection.java");

	/** 원본 행 명목 타입의 단순 이름 — 낱말 경계로 찾는다(주석·문자열도 포함해 본다). */
	private static final Pattern RAW_ROW = Pattern.compile("\\b" + ContentsRow.class.getSimpleName() + "\\b");

	@Test
	void noControllerSourceMentionsTheRawRowType() {
		List<Path> sources = controllerSources();
		assertFalse(sources.isEmpty(), "스캔 대상이 없다 — 작업 디렉토리가 모듈 루트가 아니다: "
				+ CONTROLLER_SOURCES.toAbsolutePath());

		List<String> hits = new ArrayList<>();
		for (Path source : sources) {
			hits.addAll(mentionsIn(source));
		}

		assertEquals(List.of(), hits,
				"컨트롤러 소스에 원본 행 타입이 등장한다 — 컨트롤러는 ContentsProjection.toPublic(row)이 돌려주는 "
						+ "27키 맵만 알아야 한다(잠금 비밀 2컬럼이 응답으로 새는 경로가 여기서 열린다)");
	}

	@Test
	void theSourceScannerDetectsAPlantedMention() {
		// 양성 대조 — 스캐너가 늘 빈 목록을 돌려주는 상태로 green이 되지 않는다.
		assertFalse(mentionsIn(POSITIVE_CONTROL).isEmpty(),
				"소스 스캐너가 원본 타입을 다루는 파일에서도 아무것도 찾지 못한다 — 스캐너가 고장났다: "
						+ POSITIVE_CONTROL.toAbsolutePath());
	}

	@Test
	void noDeclaredSignatureInTheControllerPackageMentionsTheRawRowType() {
		List<Class<?>> classes = controllerClasses();
		assertTrue(classes.contains(ArticlesController.class), "기사 컨트롤러가 스캔 대상에 없다: " + classes);

		List<String> hits = new ArrayList<>();
		for (Class<?> type : classes) {
			hits.addAll(signatureHits(type));
		}

		assertEquals(List.of(), hits,
				"컨트롤러 패키지의 선언 시그니처에 원본 행 타입이 있다 — 계층 경계가 무너졌다");
	}

	@Test
	void theSignatureScannerDetectsAPlantedViolation() {
		List<String> hits = signatureHits(PlantedViolation.class);

		assertEquals(4, hits.size(), "시그니처 스캐너가 심어 둔 위반을 전부 찾지 못했다: " + hits);
		assertTrue(hits.toString().contains("row"), "필드 위반을 놓쳤다: " + hits);
		assertTrue(hits.toString().contains("nested"), "제네릭 실인자 위반을 놓쳤다: " + hits);
		assertTrue(hits.toString().contains("leak"), "파라미터·반환 타입 위반을 놓쳤다: " + hits);
	}

	// --- 스캐너 -------------------------------------------------------------------------------------

	/** 컨트롤러 패키지의 main 소스 파일 전부. */
	private static List<Path> controllerSources() {
		if (!Files.isDirectory(CONTROLLER_SOURCES)) {
			return List.of();
		}
		try (Stream<Path> files = Files.walk(CONTROLLER_SOURCES)) {
			return files.filter(Files::isRegularFile)
				.filter((path) -> path.getFileName().toString().endsWith(".java"))
				.sorted()
				.toList();
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	/** {@code 파일:줄} 목록 — 원본 타입 이름이 등장하는 자리를 진단에 그대로 싣는다. */
	private static List<String> mentionsIn(Path source) {
		List<String> hits = new ArrayList<>();
		List<String> lines;
		try {
			lines = Files.readAllLines(source, StandardCharsets.UTF_8);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
		for (int i = 0; i < lines.size(); i++) {
			if (RAW_ROW.matcher(lines.get(i)).find()) {
				hits.add(source + ":" + (i + 1));
			}
		}
		return hits;
	}

	/** 컨트롤러 패키지의 main 클래스 — 소스 파일 이름에서 얻는다(테스트 클래스는 대상이 아니다). */
	private static List<Class<?>> controllerClasses() {
		List<Class<?>> classes = new ArrayList<>();
		for (Path source : controllerSources()) {
			String simpleName = source.getFileName().toString().replace(".java", "");
			try {
				classes.add(Class.forName(ArticlesController.class.getPackageName() + "." + simpleName));
			}
			catch (ClassNotFoundException ex) {
				throw new AssertionError("컨트롤러 소스에 대응하는 클래스가 없다: " + source, ex);
			}
		}
		return classes;
	}

	/** 선언된 필드·메서드·생성자·중첩 클래스의 시그니처에서 원본 타입이 등장하는 자리. */
	private static List<String> signatureHits(Class<?> type) {
		List<String> hits = new ArrayList<>();
		for (Field field : type.getDeclaredFields()) {
			record(field.getGenericType(), type.getSimpleName() + "#" + field.getName(), hits);
		}
		for (Method method : type.getDeclaredMethods()) {
			String where = type.getSimpleName() + "#" + method.getName();
			record(method.getGenericReturnType(), where + "(반환)", hits);
			for (Type parameter : method.getGenericParameterTypes()) {
				record(parameter, where + "(파라미터)", hits);
			}
		}
		for (Constructor<?> constructor : type.getDeclaredConstructors()) {
			for (Type parameter : constructor.getGenericParameterTypes()) {
				record(parameter, type.getSimpleName() + "#<생성자>(파라미터)", hits);
			}
		}
		for (Class<?> nested : type.getDeclaredClasses()) {
			hits.addAll(signatureHits(nested));
		}
		return hits;
	}

	private static void record(Type type, String where, List<String> hits) {
		if (mentionsRawRow(type)) {
			hits.add(where + " : " + type.getTypeName());
		}
	}

	/** 제네릭 실인자·배열·와일드카드·타입 변수 경계까지 파고들어 원본 타입을 찾는다. */
	private static boolean mentionsRawRow(Type type) {
		if (type instanceof Class<?> raw) {
			return raw == ContentsRow.class || (raw.isArray() && mentionsRawRow(raw.getComponentType()));
		}
		if (type instanceof ParameterizedType parameterized) {
			if (mentionsRawRow(parameterized.getRawType())) {
				return true;
			}
			return anyMentions(parameterized.getActualTypeArguments());
		}
		if (type instanceof GenericArrayType array) {
			return mentionsRawRow(array.getGenericComponentType());
		}
		if (type instanceof WildcardType wildcard) {
			return anyMentions(wildcard.getUpperBounds()) || anyMentions(wildcard.getLowerBounds());
		}
		if (type instanceof TypeVariable<?> variable) {
			return anyMentions(variable.getBounds());
		}
		return false;
	}

	private static boolean anyMentions(Type[] types) {
		for (Type type : types) {
			if (mentionsRawRow(type)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 심어 둔 위반 — 스캐너가 <b>정말로</b> 탐지한다는 증거다(필드 1 · 제네릭 실인자 1 ·
	 * 메서드 반환/파라미터 2 = 4건).
	 */
	@SuppressWarnings("unused")
	private static final class PlantedViolation {

		private ContentsRow row;

		private Map<String, List<ContentsRow>> nested;

		private ContentsRow leak(List<ContentsRow> rows) {
			return rows.isEmpty() ? this.row : rows.get(0);
		}

	}

}
