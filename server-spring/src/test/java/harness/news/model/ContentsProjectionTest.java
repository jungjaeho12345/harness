package harness.news.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/**
 * Contents 행의 응답 투영 — 리포 루트 {@code src/services/contentsProjection.js}와 1:1.
 *
 * <p><b>이 클래스가 지키는 한 문장:</b> 세션 토큰({@code lockerSessionId})과 편집 탭 식별자
 * ({@code lockerClientId})는 어떤 응답에도 실리지 않는다. 그 값은 그 자체가 권한이라, 인증된 아무
 * 사용자나 목록을 한 번 조회하는 것만으로 데스크의 세션을 탈취할 수 있다.
 *
 * <p>강제 수단은 이름 스캔이 아니라 <b>타입 경계</b>다(decisions (4)①). 실제 누출 벡터는 "미투영 원본
 * 행을 응답에 그대로 싣는 코드"인데 그 코드에는 두 컬럼명 문자열이 등장하지 않는다. 그래서 원본 행은
 * 직렬화될 수 없는 불투명 타입({@link ContentsRow})이고, 응답에 들어갈 수 있는 것은
 * {@link ContentsProjection#toPublic(ContentsRow)}이 돌려주는 맵뿐이다.
 */
class ContentsProjectionTest {

	/** 스키마 29컬럼(리포 루트 {@code src/db/schema.js} Contents) — 순서까지 같다. */
	private static final List<String> ALL_COLUMNS = List.of(
			"articleId", "title", "content", "author", "modifier", "sender", "department", "departmentCode",
			"createdAt", "editedAt", "sentAt", "distributedAt", "embargoAt", "secondEmbargoAt", "status",
			"lockYN", "lockerUserId", "lockerSessionId", "lockerClientId", "lockedAt",
			"coAuthor", "category", "region", "attribute", "keyword",
			"internalComment", "externalComment", "attachmentFile", "referenceFile");

	private static final String TOKEN = "e6f0c1b2a3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e";

	// --- 제거 대상 2컬럼 ---------------------------------------------------------------------------

	@Test
	void exactlyTwoColumnsAreRemoved() {
		assertEquals(List.of("lockerSessionId", "lockerClientId"), ContentsProjection.PRIVATE_COLUMNS,
				"제거 목록은 상수 1곳이 소유한다 — 값이 곧 인증 자격이거나 위조 재료인 것만 담는다");

		Map<String, Object> publicRow = ContentsProjection.toPublic(sampleRow());

		assertFalse(publicRow.containsKey("lockerSessionId"), "세션 토큰 원문이 응답에 실리면 권한 상승이다");
		assertFalse(publicRow.containsKey("lockerClientId"), "편집 탭 식별자가 실리면 탭 사칭이 가능하다");
		assertFalse(publicRow.toString().contains(TOKEN), "값이 다른 키로 새어 나가지도 않는다");
	}

	@Test
	void theRemainingLockColumnsStay() {
		Map<String, Object> publicRow = ContentsProjection.toPublic(sampleRow());

		assertEquals("Y", publicRow.get("lockYN"), "잠금 표시 UI 계약이다 — 빼면 목록이 잠금 상태를 잃는다");
		assertEquals("desk1", publicRow.get("lockerUserId"));
		assertEquals("2026-08-20T12:34:56.789Z", publicRow.get("lockedAt"));
	}

	@Test
	void theProjectionKeepsColumnOrderAndYieldsTwentySevenKeys() {
		Map<String, Object> publicRow = ContentsProjection.toPublic(sampleRow());

		List<String> expected = new ArrayList<>(ALL_COLUMNS);
		expected.removeAll(ContentsProjection.PRIVATE_COLUMNS);
		assertEquals(expected, List.copyOf(publicRow.keySet()), "29컬럼 − 2 = 27키이고 순서는 그대로다");
		assertEquals(27, publicRow.size());
	}

	@Test
	void keysWhoseValueIsNullAreKept() {
		// decisions (5)(20) — '키 없음'과 'null'은 다르다. 값에 따라 키가 사라지면 27키 계약이 무너진다.
		Map<String, Object> publicRow = ContentsProjection.toPublic(sampleRow());

		assertTrue(publicRow.containsKey("sentAt"), "값이 NULL이어도 키는 남는다");
		assertNull(publicRow.get("sentAt"));
		assertTrue(publicRow.containsKey("distributedAt"));
		assertNull(publicRow.get("distributedAt"));
		assertTrue(publicRow.containsKey("embargoAt"));
		assertNull(publicRow.get("embargoAt"));
	}

	// --- 원본 불변 -------------------------------------------------------------------------------

	@Test
	void theSourceRowIsNotMutated() {
		// 같은 행 객체가 잠금 판정(재로그인 takeover)에서 재사용된다 — 투영이 원본을 깎으면 그 판정이 깨진다.
		ContentsRow row = sampleRow();

		ContentsProjection.toPublic(row);

		assertEquals(TOKEN, row.column("lockerSessionId"), "내부 판정 경로는 투영되지 않은 원본을 계속 본다");
		assertEquals("tab-7", row.column("lockerClientId"));
	}

	@Test
	void eachProjectionIsANewMap() {
		ContentsRow row = sampleRow();

		Map<String, Object> first = ContentsProjection.toPublic(row);
		Map<String, Object> second = ContentsProjection.toPublic(row);

		assertNotSame(first, second);
		first.put("injected", "x");
		assertFalse(second.containsKey("injected"));
	}

	@Test
	void theRowCopiesItsColumnsSoLaterEditsToTheSourceMapDoNotLeakIn() {
		Map<String, Object> source = new LinkedHashMap<>();
		source.put("articleId", "AKR20260820000000001");
		ContentsRow row = ContentsRow.of(source);

		source.put("lockerSessionId", TOKEN);

		assertNull(row.column("lockerSessionId"), "행은 만들어진 시점의 컬럼만 안다");
	}

	// --- 컬렉션·방어 ----------------------------------------------------------------------------

	@Test
	void collectionsAreProjectedElementWise() {
		List<Map<String, Object>> projected = ContentsProjection.toPublicAll(List.of(sampleRow(), sampleRow()));

		assertEquals(2, projected.size());
		for (Map<String, Object> row : projected) {
			assertFalse(row.containsKey("lockerSessionId"));
			assertEquals(27, row.size());
		}
	}

	@Test
	void nullInputsDoNotBreakTheCaller() {
		assertNull(ContentsProjection.toPublic(null));
		assertEquals(List.of(), ContentsProjection.toPublicAll(null));
	}

	// --- 타입 경계(decisions (4)①) ----------------------------------------------------------------

	@Test
	void theProjectionSignatureSeparatesTheRawTypeFromTheResponseType() throws Exception {
		Method toPublic = ContentsProjection.class.getMethod("toPublic", ContentsRow.class);

		assertEquals(ContentsRow.class, toPublic.getParameterTypes()[0], "입력은 원본 명목 타입이다");
		assertEquals(Map.class, toPublic.getReturnType(), "출력은 맵이다 — 응답에 실릴 수 있는 형태는 이것뿐이다");
	}

	@Test
	void theRawRowExposesNoSerializableProperty() {
		for (Method method : ContentsRow.class.getMethods()) {
			if (method.getDeclaringClass() == Object.class || method.getParameterCount() != 0) {
				continue;
			}
			String name = method.getName();
			assertFalse(name.startsWith("get") || name.startsWith("is"),
					"원본 행에 getter를 두면 JSON 매퍼가 컬럼을 발견해 그대로 내보낸다: " + name);
		}
		for (Field field : ContentsRow.class.getFields()) {
			assertTrue(Modifier.isStatic(field.getModifiers()), "공개 인스턴스 필드도 직렬화 속성이다: " + field);
		}
	}

	@Test
	void theRawRowCannotBeWrittenAsAResponseBody() {
		// 투영 우회가 조용한 200이 아니라 예외(→ 500)로 드러난다.
		assertThrows(RuntimeException.class, () -> JsonMapper.builder().build().writeValueAsString(sampleRow()),
				"원본 행이 직렬화되면 세션 토큰이 그대로 나간다");
	}

	@Test
	void theRawRowDoesNotLeakColumnsThroughToString() {
		assertFalse(sampleRow().toString().contains(TOKEN), "로그 한 줄이 곧 토큰 유출이 되면 안 된다");
	}

	/** 29컬럼 전부를 담은 잠긴 기사 한 행. 값이 NULL인 컬럼도 <b>키는 있다</b>. */
	private static ContentsRow sampleRow() {
		Map<String, Object> row = new LinkedHashMap<>();
		for (String column : ALL_COLUMNS) {
			row.put(column, null);
		}
		row.put("articleId", "AKR20260820000000001");
		row.put("title", "제목");
		row.put("author", "김기자");
		row.put("status", "RDS");
		row.put("createdAt", "2026-08-20T12:00:00.000Z");
		row.put("lockYN", "Y");
		row.put("lockerUserId", "desk1");
		row.put("lockerSessionId", TOKEN);
		row.put("lockerClientId", "tab-7");
		row.put("lockedAt", "2026-08-20T12:34:56.789Z");
		return ContentsRow.of(row);
	}
}
