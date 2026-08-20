package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.model.UserRow;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/**
 * 세션 신원의 shape — Node {@code sessionService.identityOf}의 {@code IDENTITY_FIELDS} 투영과 1:1이다.
 *
 * <p>두 가지를 잠근다.
 * <ol>
 *   <li><b>정확히 5키</b>({@code userId·role·department·departmentCode·name}) — 비밀번호·잠금 메타·
 *       {@code active}는 없다. 계약이 {@code GET /api/session}의 user 키 집합을 이 5개로 동결했다.</li>
 *   <li><b>SQL NULL은 키를 지우지 않는다.</b> Node의 {@code identityOf}는 5필드를 무조건 채우므로 부서가
 *       비어 있는 계정도 {@code "department":null}을 응답에 남긴다. "값이 없으면 키를 뺀다"는 규칙으로
 *       뭉개면 키 집합 단언이 깨진다(흡수한 클라우드 구현의 실제 결함 — decisions (18)(c)).
 *       그래서 응답 조립은 이 {@code asMap()} 하나에서만 시작한다.</li>
 * </ol>
 */
class IdentityTest {

	/** Node IDENTITY_FIELDS와 같은 순서. */
	private static final List<String> IDENTITY_KEYS =
			List.of("userId", "role", "department", "departmentCode", "name");

	private static final UserRow FULL_ROW = new UserRow(
			"desk", "김데스크", "$2a$10$abcdefghijklmnopqrstuv", "Z", "편집국", "EDT", "Y",
			"3", "1787126400000", "1787125500000");

	private static final UserRow ROW_WITHOUT_DEPARTMENT = new UserRow(
			"nodept", "무부서", "$2a$10$abcdefghijklmnopqrstuv", "R", null, null, "Y",
			"0", null, null);

	@Test
	void projectsExactlyTheFiveWhitelistedFields() {
		Identity identity = Identity.of(FULL_ROW);

		assertEquals("desk", identity.userId());
		assertEquals("Z", identity.role());
		assertEquals("편집국", identity.department());
		assertEquals("EDT", identity.departmentCode());
		assertEquals("김데스크", identity.name());
		assertEquals(IDENTITY_KEYS, List.copyOf(identity.asMap().keySet()));
	}

	@Test
	void neverCarriesPasswordOrLockMetadata() {
		String rendered = Identity.of(FULL_ROW).asMap().toString() + Identity.of(FULL_ROW);

		assertFalse(rendered.contains("$2a$10$"), "비밀번호 해시가 신원에 실리면 안 된다: " + rendered);
		assertFalse(rendered.contains("1787126400000"), "잠금 상태(lockedUntil)가 실리면 안 된다: " + rendered);
		assertFalse(rendered.contains("1787125500000"), "잠금 상태(lastFailedLoginAt)가 실리면 안 된다: " + rendered);
		assertFalse(rendered.contains("failedLoginCount"), "잠금 카운터는 신원 키가 아니다: " + rendered);
	}

	@Test
	void keepsNullColumnsAsExplicitNullValuedKeys() {
		Map<String, Object> identity = Identity.of(ROW_WITHOUT_DEPARTMENT).asMap();

		assertEquals(IDENTITY_KEYS, List.copyOf(identity.keySet()), "NULL 컬럼도 키는 남는다(정확 5키)");
		assertTrue(identity.containsKey("department"));
		assertNull(identity.get("department"));
		assertNull(identity.get("departmentCode"));
	}

	@Test
	void nullColumnsSerializeAsJsonNullNotAsAMissingKey() {
		String json = JsonMapper.builder().build()
				.writeValueAsString(Identity.of(ROW_WITHOUT_DEPARTMENT).asMap());

		assertTrue(json.contains("\"department\":null"),
				"Node는 부서가 비어도 키를 남긴다 — 키를 지우면 user 키 집합 계약이 깨진다: " + json);
		assertTrue(json.contains("\"departmentCode\":null"), json);
	}

	@Test
	void asMapIsAFreshCopy() {
		Identity identity = Identity.of(FULL_ROW);

		identity.asMap().put("role", "Z-tampered");

		assertEquals("R", Identity.of(ROW_WITHOUT_DEPARTMENT).role());
		assertEquals("Z", identity.asMap().get("role"), "호출자가 바꾼 map이 신원에 되먹임되면 안 된다");
	}
}
