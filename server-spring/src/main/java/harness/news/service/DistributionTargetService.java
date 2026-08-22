package harness.news.service;

import harness.news.model.DistributionTargetRepository;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

/**
 * 배부 대상(수신처) 서비스 — 리포 루트 {@code src/services/distributionTargetService.js}와 1:1이다.
 * HTTP 비의존(ADR-006)이며 사유 토큰만 돌려준다.
 *
 * <h2>CRITICAL — 4 op 전부 Z 전용(ADR-004)</h2>
 * 조회·생성·수정·비활성 모두 {@link Authorization#MANAGE_DISTRIBUTION_TARGET} 게이트를 통과해야 한다
 * (R도 D도 안 된다). acting role은 검증된 세션에서만 도출한다 — 이 서비스는 세션 토큰만 받는다. 거부되면
 * 리포지토리를 부르지 않는다.
 *
 * <h2>대상 제거 경로는 없다 = soft delete뿐</h2>
 * {@code deactivate}와 {@code update}는 <b>같은 {@link #applyPatch}로 수렴</b>하고 둘 다 {@code updatedAt}을
 * stamp한다(감사 기록이 진입점에 따라 갈리지 않게). 비활성 행은 목록에서 사라지지 않는다.
 *
 * <h2>create 검증 순서가 계약이다: name → kind → spoolDir → active</h2>
 * <ul>
 *   <li>name: 비문자열·공백·&gt;100자 → {@code invalid-name}(강제변환 금지).</li>
 *   <li>kind: {@code press}|{@code nonpress} 아니면 {@code invalid-kind}.</li>
 *   <li>spoolDir: 슬러그 실패 → {@code invalid-spool-dir} · 사용 중이면 {@code duplicate-spool-dir}
 *       (유일성은 <b>비활성 행까지 포함</b>해 따진다).</li>
 *   <li>active: 미지정이면 {@code Y}, 그 외 Y/N 아니면 {@code invalid-active}.</li>
 * </ul>
 * 검증 5토큰은 전부 {@code ReasonStatus} 전역 표에 없어 폴백 400으로 나간다(추가 금지). update는
 * <b>present-only</b>: 전달 필드만 검증·반영하고 하나라도 위반이면 아무것도 저장하지 않는다. <b>존재 확인
 * (not-found)을 검증보다 먼저</b> 한다(없는 id가 검증 reason으로 둔갑하지 않게).
 *
 * <h2>id·시각은 서버가 정한다</h2>
 * id는 자동 증가, {@code createdAt}·{@code updatedAt}은 주입 {@link Clock}으로 stamp한다(entry의 동명 필드
 * 무시). 비수치 id는 {@code Number(id)=NaN}으로 정규화되어 어떤 행에도 매치되지 않는다 → not-found(500 아님).
 */
@Service
public class DistributionTargetService {

	/** 응답에 노출 가능한 필드 — Node {@code SAFE_FIELDS}의 순서 그대로다(정렬본이 아니다). */
	static final List<String> SAFE_FIELDS = List.of(
			"id", "name", "kind", "spoolDir", "active", "createdAt", "updatedAt");

	/** query에서 모델로 넘길 수 있는 필터 키 — 그 외 키는 무시한다(Node {@code FILTER_KEYS}). */
	private static final List<String> FILTER_KEYS = List.of("id", "name", "kind", "spoolDir", "active");

	private static final Set<String> KINDS = Set.of("press", "nonpress");

	private static final Set<String> ACTIVE = Set.of("Y", "N");

	private static final int NAME_MAX = 100;

	private final DistributionTargetRepository targets;

	private final Authorization authorization;

	private final Clock clock;

	public DistributionTargetService(DistributionTargetRepository targets, Authorization authorization,
			Clock clock) {
		this.targets = targets;
		this.authorization = authorization;
		this.clock = clock;
	}

	/**
	 * op 결과 — Node의 {@code {ok, ...}} 결과 객체와 동형. 성공이면 사유가 없고 payload 하나만 채운다.
	 */
	public record Result(boolean ok, String reason,
			List<Map<String, Object>> items, Integer id, Integer changes) {

		static Result deny(String reason) {
			return new Result(false, reason, null, null, null);
		}

		static Result listed(List<Map<String, Object>> items) {
			return new Result(true, null, items, null, null);
		}

		static Result created(int id) {
			return new Result(true, null, null, id, null);
		}

		static Result changed(int changes) {
			return new Result(true, null, null, null, changes);
		}
	}

	/** 게이트 → 허용 필터만 골라 조회 → 행마다 SAFE_FIELDS 투영. */
	public Result query(String sessionToken, Map<String, ?> filters) {
		Authorization.Decision gate = gate(sessionToken);
		if (!gate.ok()) {
			return Result.deny(gate.reason());
		}
		List<Map<String, Object>> items = new ArrayList<>();
		for (Map<String, Object> row : this.targets.query(pickFilters(filters))) {
			items.add(sanitize(row));
		}
		return Result.listed(items);
	}

	/** 게이트 → 검증(name→kind→spoolDir→active) → 삽입(서버가 id·시각 결정). */
	public Result create(String sessionToken, Map<String, ?> entry) {
		Authorization.Decision gate = gate(sessionToken);
		if (!gate.ok()) {
			return Result.deny(gate.reason());
		}
		Map<String, ?> input = entry == null ? Map.of() : entry;

		Field name = checkName(input.get("name"));
		if (!name.ok()) {
			return Result.deny(name.reason());
		}
		Field kind = checkKind(input.get("kind"));
		if (!kind.ok()) {
			return Result.deny(kind.reason());
		}
		Field spoolDir = checkSpoolDir(input.get("spoolDir"), null);
		if (!spoolDir.ok()) {
			return Result.deny(spoolDir.reason());
		}
		Field active = input.containsKey("active")
				? checkActive(input.get("active"))
				: Field.of("Y");
		if (!active.ok()) {
			return Result.deny(active.reason());
		}

		String stamp = Iso8601.now(this.clock);
		Map<String, Object> row = new LinkedHashMap<>();
		row.put("name", name.value());
		row.put("kind", kind.value());
		row.put("spoolDir", spoolDir.value());
		row.put("active", active.value());
		row.put("createdAt", stamp);
		row.put("updatedAt", stamp);
		return Result.created(this.targets.insert(row));
	}

	/**
	 * present-only 수정 — 게이트 → 존재 확인(검증보다 먼저) → 전달 필드만 검증·반영. 하나라도 위반이면
	 * 아무것도 저장하지 않는다.
	 */
	public Result update(String sessionToken, String id, Map<String, ?> fields) {
		Authorization.Decision gate = gate(sessionToken);
		if (!gate.ok()) {
			return Result.deny(gate.reason());
		}
		double key = normalizeId(id);
		// 존재 확인을 검증보다 먼저 — 없는 id가 검증 reason으로 둔갑하지 않도록.
		if (this.targets.findById(key).isEmpty()) {
			return Result.deny("not-found");
		}
		Map<String, ?> input = fields == null ? Map.of() : fields;

		Map<String, Object> patch = new LinkedHashMap<>();
		if (input.containsKey("name")) {
			Field name = checkName(input.get("name"));
			if (!name.ok()) {
				return Result.deny(name.reason());
			}
			patch.put("name", name.value());
		}
		if (input.containsKey("kind")) {
			Field kind = checkKind(input.get("kind"));
			if (!kind.ok()) {
				return Result.deny(kind.reason());
			}
			patch.put("kind", kind.value());
		}
		if (input.containsKey("spoolDir")) {
			Field spoolDir = checkSpoolDir(input.get("spoolDir"), key); // 자기 자신은 중복에서 제외.
			if (!spoolDir.ok()) {
				return Result.deny(spoolDir.reason());
			}
			patch.put("spoolDir", spoolDir.value());
		}
		if (input.containsKey("active")) {
			Field active = checkActive(input.get("active"));
			if (!active.ok()) {
				return Result.deny(active.reason());
			}
			patch.put("active", active.value());
		}
		return applyPatch(key, patch);
	}

	/** 비활성(soft delete) — 행을 지우지 않는다. update와 같은 헬퍼로 수렴한다. */
	public Result deactivate(String sessionToken, String id) {
		Authorization.Decision gate = gate(sessionToken);
		if (!gate.ok()) {
			return Result.deny(gate.reason());
		}
		Map<String, Object> patch = new LinkedHashMap<>();
		patch.put("active", "N");
		return applyPatch(normalizeId(id), patch);
	}

	/**
	 * 상태 변경 단일 경로 — update와 deactivate가 모두 여기로 수렴한다. 존재하면 patch + {@code updatedAt}
	 * stamp로 갱신하고, 없으면 not-found다(두 경로가 갈라지면 감사 기록이 진입점에 따라 달라진다).
	 */
	private Result applyPatch(double id, Map<String, Object> patch) {
		if (this.targets.findById(id).isEmpty()) {
			return Result.deny("not-found");
		}
		Map<String, Object> stamped = new LinkedHashMap<>(patch);
		stamped.put("updatedAt", Iso8601.now(this.clock));
		return Result.changed(this.targets.update(id, stamped));
	}

	private Authorization.Decision gate(String sessionToken) {
		return this.authorization.authorize(sessionToken, Authorization.MANAGE_DISTRIBUTION_TARGET);
	}

	// --- 검증(서비스 소유 · 순서가 계약) --------------------------------------------------------

	/** 이름 검증 — 비문자열은 강제변환 없이 즉시 거부한다(String.valueOf가 검증을 통과하는 결함 차단). */
	private static Field checkName(Object value) {
		if (!(value instanceof String text)) {
			return Field.fail("invalid-name");
		}
		String trimmed = text.trim();
		if (trimmed.isEmpty() || trimmed.length() > NAME_MAX) {
			return Field.fail("invalid-name");
		}
		return Field.of(trimmed);
	}

	/** 집합 검사 — 비문자열은 자연 거부된다(대소문자 보정 없음). */
	private static Field checkKind(Object value) {
		return KINDS.contains(value) ? Field.of((String) value) : Field.fail("invalid-kind");
	}

	private static Field checkActive(Object value) {
		return ACTIVE.contains(value) ? Field.of((String) value) : Field.fail("invalid-active");
	}

	/**
	 * spoolDir 검증 — 규칙 단일 출처는 {@link SpoolDir#sanitizeSpoolDir}(타입 게이트 포함)다. 유일성은
	 * <b>비활성 행까지 포함</b>해 따진다(비활성 대상의 스풀 폴더가 남아 있기 때문). {@code selfId}는 정규화된
	 * id(update)이거나 {@code null}(create)이다 — self는 중복에서 제외한다.
	 */
	private Field checkSpoolDir(Object value, Double selfId) {
		String dir = SpoolDir.sanitizeSpoolDir(value);
		if (dir.isEmpty()) {
			return Field.fail("invalid-spool-dir");
		}
		Map<String, Object> filter = new LinkedHashMap<>();
		filter.put("spoolDir", dir);
		for (Map<String, Object> row : this.targets.query(filter)) {
			if (!isSelf(row.get("id"), selfId)) {
				return Field.fail("duplicate-spool-dir");
			}
		}
		return Field.of(dir);
	}

	/** 행 id(Long)가 self(정규화된 double)와 같은가 — selfId가 null(create)이면 항상 false(전부 중복 후보). */
	private static boolean isSelf(Object rowId, Double selfId) {
		return selfId != null && rowId instanceof Number number && number.doubleValue() == selfId;
	}

	/**
	 * id 정규화 — Node {@code normalizeId(id)=Number(id)}. DB의 id는 INTEGER PK라 double로 맞춰
	 * findById/update가 같은 타입을 보게 한다. 숫자로 변환되지 않는 id는 NaN이 되어 어떤 행에도 매치되지
	 * 않는다 → not-found로 수렴(500 아님).
	 */
	private static double normalizeId(String id) {
		if (id == null) {
			return Double.NaN;
		}
		String trimmed = id.trim();
		if (trimmed.isEmpty()) {
			return 0.0; // JS Number('')===0
		}
		try {
			return Double.parseDouble(trimmed);
		}
		catch (NumberFormatException ex) {
			return Double.NaN; // JS Number('abc')===NaN
		}
	}

	/** 허용 키의 원시값(문자열/숫자)만 통과 — 배열·객체는 무시한다(필터 주입·바인딩 오류 차단). */
	private static Map<String, Object> pickFilters(Map<String, ?> filters) {
		Map<String, Object> out = new LinkedHashMap<>();
		if (filters != null) {
			for (String key : FILTER_KEYS) {
				Object value = filters.get(key);
				if (value instanceof String || value instanceof Number) {
					out.put(key, value);
				}
			}
		}
		return out;
	}

	/**
	 * DB 행 → SAFE_FIELDS 투영(allowlist). 키를 항상 남긴다(값이 없으면 {@code null}).
	 */
	private static Map<String, Object> sanitize(Map<String, Object> row) {
		Map<String, Object> out = new LinkedHashMap<>();
		for (String field : SAFE_FIELDS) {
			if (row != null && row.containsKey(field)) {
				out.put(field, row.get(field));
			}
		}
		return out;
	}

	/** 검증 결과 — 성공이면 정규화된 값, 실패면 사유 토큰. */
	private record Field(boolean ok, String value, String reason) {

		static Field of(String value) {
			return new Field(true, value, null);
		}

		static Field fail(String reason) {
			return new Field(false, null, reason);
		}
	}
}
