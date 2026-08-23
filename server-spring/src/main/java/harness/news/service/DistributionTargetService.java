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
 * 배부 수신처 서비스 — 리포 루트 {@code src/services/distributionTargetService.js}와 1:1(게이트·검증·soft
 * delete·투영). HTTP·파일시스템 비의존(ADR-006) — 서블릿 타입을 import하지 않고 디렉토리를 만들거나
 * 파일을 쓰지 않는다(스풀 쓰기는 배부 실행 phase · ADR-008). {@code spoolDir}는 저장만 하는 문자열이다.
 *
 * <h2>CRITICAL — 모든 op는 Z 전용, acting role은 검증된 세션에서만(ADR-004)</h2>
 * 각 op는 세션 토큰만 {@link Authorization#authorize(String, String)}에 넘긴다 — 클라이언트가 보낸
 * role/id/타임스탬프는 신뢰하지 않는다. 대상 제거 경로는 없다 — 비활성은 {@code active='N'} soft delete가
 * 유일하다(행을 지우지 않는다 · DB 비파괴).
 *
 * <h2>검증 순서가 계약이다(create): name → kind → spoolDir → active</h2>
 * 순서가 바뀌면 같은 입력이 다른 400 사유를 받는다. 사유는 전부 web 계층의 400 폴백을 탄다
 * ({@code ReasonStatus}에 새 행을 넣지 않는다 · decisions (3)).
 * <ul>
 *   <li>{@code invalid-name} — 비문자열·빈 문자열·trim 후 빈·100자 초과(비문자열은 강제변환 없이 즉시 거부).</li>
 *   <li>{@code invalid-kind} — {@code press}/{@code nonpress} 밖(<b>대소문자 보정 없음</b> — {@code PRESS} 거부).</li>
 *   <li>{@code invalid-spool-dir} — {@link SpoolDir#sanitize}가 빈 문자열을 낼 때.</li>
 *   <li>{@code duplicate-spool-dir} — <b>비활성 행 포함</b> 다른 행이 같은 slug를 쓸 때(self-exclusion 엄격 비교).</li>
 *   <li>{@code invalid-active} — {@code Y}/{@code N} 밖.</li>
 * </ul>
 *
 * <h2>stamp 정책 · 시각 출처</h2>
 * create는 {@code createdAt}·{@code updatedAt}을 둘 다 now()로, update/deactivate는 {@code updatedAt}만
 * now()로 stamp한다({@code createdAt}은 서버 소유라 수정으로 바뀌지 않는다 · 계약 {@code createdAtStable}).
 * id·createdAt·updatedAt은 서버가 정한다(entry의 동명 필드는 채택하지 않는다). 시각은 <b>주입된
 * {@link Clock} 빈</b>에서만 읽는다({@code System.currentTimeMillis()}·인자 없는 {@code Instant.now()} 금지 —
 * ADR-013). update와 deactivate는 {@link #applyPatch}라는 <b>단일 상태 변경 경로</b>로 수렴한다(감사 기록이
 * 진입점마다 갈라지지 않게).
 */
@Service
public class DistributionTargetService {

	/** 조회 응답에 노출 가능한 컬럼 — Node {@code SAFE_FIELDS}(7키, allowlist). */
	static final List<String> SAFE_FIELDS =
			List.of("id", "name", "kind", "spoolDir", "active", "createdAt", "updatedAt");

	/** query에서 모델로 넘길 수 있는 필터 키 — 그 외 키는 무시한다. */
	private static final List<String> FILTER_KEYS = List.of("id", "name", "kind", "spoolDir", "active");

	private static final Set<String> KINDS = Set.of("press", "nonpress");

	private static final Set<String> ACTIVE = Set.of("Y", "N");

	private static final int NAME_MAX = 100;

	private final DistributionTargetRepository targets;

	private final Authorization authorization;

	private final Clock clock;

	public DistributionTargetService(DistributionTargetRepository targets, Authorization authorization, Clock clock) {
		this.targets = targets;
		this.authorization = authorization;
		this.clock = clock;
	}

	/**
	 * 조회 — Z면 스칼라 필터만 모델로 넘겨(배열·객체 무시) SAFE_FIELDS 7키로 투영한 {@code items}.
	 * 검증은 write 경로에서만 강제한다(과거에 저장된 행은 규칙에 걸려도 숨기지 않는다 · 비파괴).
	 */
	public Map<String, Object> query(String sessionToken, Map<String, ?> filters) {
		Authorization.Decision gate = gate(sessionToken);
		if (!gate.ok()) {
			return fail(gate.reason());
		}
		List<Map<String, Object>> items = new ArrayList<>();
		for (Map<String, Object> row : this.targets.query(pickFilters(filters))) {
			items.add(sanitize(row));
		}
		return ok("items", items);
	}

	/** 생성 — 검증 순서 name→kind→spoolDir→active. 성공 → {@code {ok:true, id}} + 두 타임스탬프 stamp. */
	public Map<String, Object> create(String sessionToken, Map<String, ?> entry) {
		Authorization.Decision gate = gate(sessionToken);
		if (!gate.ok()) {
			return fail(gate.reason());
		}
		Map<String, ?> source = entry == null ? Map.of() : entry;

		String nameValue = checkName(source.get("name"));
		if (nameValue == null) {
			return fail("invalid-name");
		}
		if (!KINDS.contains(source.get("kind"))) {
			return fail("invalid-kind");
		}
		String kindValue = (String) source.get("kind");

		String spoolDir = SpoolDir.sanitize(source.get("spoolDir"));
		if (spoolDir.isEmpty()) {
			return fail("invalid-spool-dir");
		}
		if (spoolDirTaken(spoolDir, null)) {
			return fail("duplicate-spool-dir");
		}

		String activeValue;
		if (!source.containsKey("active")) {
			activeValue = "Y"; // 미지정 기본(Node entry.active === undefined).
		}
		else if (ACTIVE.contains(source.get("active"))) {
			activeValue = (String) source.get("active");
		}
		else {
			return fail("invalid-active");
		}

		String stamp = Iso8601.now(this.clock);
		Map<String, Object> insert = new LinkedHashMap<>();
		insert.put("name", nameValue);
		insert.put("kind", kindValue);
		insert.put("spoolDir", spoolDir);
		insert.put("active", activeValue);
		insert.put("createdAt", stamp);
		insert.put("updatedAt", stamp);
		return ok("id", this.targets.insert(insert));
	}

	/**
	 * 수정 — present-only. <b>존재 확인이 검증보다 먼저</b>(없는 id → {@code not-found}, 검증 사유로 둔갑
	 * 금지) · 전달된 필드가 하나라도 규칙을 어기면 아무것도 저장하지 않는다(부분 저장 금지) · {@code spoolDir}
	 * 중복 검사에서 자기 자신은 제외(엄격 비교).
	 */
	public Map<String, Object> update(String sessionToken, double id, Map<String, ?> fields) {
		Authorization.Decision gate = gate(sessionToken);
		if (!gate.ok()) {
			return fail(gate.reason());
		}
		double key = normalizeId(id);
		if (this.targets.findById(key) == null) {
			return fail("not-found");
		}
		Map<String, ?> source = fields == null ? Map.of() : fields;

		Map<String, Object> patch = new LinkedHashMap<>();
		if (source.containsKey("name")) {
			String nameValue = checkName(source.get("name"));
			if (nameValue == null) {
				return fail("invalid-name");
			}
			patch.put("name", nameValue);
		}
		if (source.containsKey("kind")) {
			if (!KINDS.contains(source.get("kind"))) {
				return fail("invalid-kind");
			}
			patch.put("kind", source.get("kind"));
		}
		if (source.containsKey("spoolDir")) {
			String spoolDir = SpoolDir.sanitize(source.get("spoolDir"));
			if (spoolDir.isEmpty()) {
				return fail("invalid-spool-dir");
			}
			if (spoolDirTaken(spoolDir, key)) { // 자기 자신은 중복에서 제외.
				return fail("duplicate-spool-dir");
			}
			patch.put("spoolDir", spoolDir);
		}
		if (source.containsKey("active")) {
			if (!ACTIVE.contains(source.get("active"))) {
				return fail("invalid-active");
			}
			patch.put("active", source.get("active"));
		}
		return applyPatch(key, patch);
	}

	/** 비활성(soft delete) — 행을 지우지 않고 update와 같은 헬퍼로 수렴한다. */
	public Map<String, Object> deactivate(String sessionToken, double id) {
		Authorization.Decision gate = gate(sessionToken);
		if (!gate.ok()) {
			return fail(gate.reason());
		}
		Map<String, Object> patch = new LinkedHashMap<>();
		patch.put("active", "N");
		return applyPatch(normalizeId(id), patch);
	}

	/**
	 * 상태 변경 단일 경로 — update와 deactivate가 모두 여기로 수렴한다(두 경로가 갈라지면 updatedAt stamp가
	 * 진입점에 따라 달라진다). 존재하지 않으면 {@code not-found}이고, 존재하면 patch에 {@code updatedAt=now()}를
	 * 더해 갱신한다.
	 */
	private Map<String, Object> applyPatch(double id, Map<String, Object> patch) {
		if (this.targets.findById(id) == null) {
			return fail("not-found");
		}
		Map<String, Object> withStamp = new LinkedHashMap<>(patch);
		withStamp.put("updatedAt", Iso8601.now(this.clock));
		return ok("changes", this.targets.update(id, withStamp));
	}

	private Authorization.Decision gate(String sessionToken) {
		return this.authorization.authorize(sessionToken, Authorization.MANAGE_DISTRIBUTION_TARGET);
	}

	/**
	 * 이름 검증 — 유효하면 <b>trim한 문자열</b>을, 무효면 {@code null}을 돌려준다(사유는 호출부가
	 * {@code invalid-name}으로 낸다). 비문자열은 강제변환 없이 즉시 거부한다({@code String(undefined)}가
	 * 검사를 통과해 name='undefined' 행을 만드는 결함 차단). {@code null}로 무효를 표현하므로 유효한 이름이
	 * 우연히 사유 토큰 문자열과 같아도(예: 이름이 "invalid-name") 충돌하지 않는다.
	 */
	private static String checkName(Object value) {
		if (!(value instanceof String text)) {
			return null;
		}
		String trimmed = text.trim();
		if (trimmed.isEmpty() || trimmed.length() > NAME_MAX) {
			return null;
		}
		return trimmed;
	}

	/**
	 * spoolDir 유일성 — 비활성 행까지 포함해 따진다(비활성 대상의 스풀 폴더가 그대로 남아 있기 때문).
	 * {@code selfId}가 주어지면(수정) 그 행은 <b>엄격 정수 비교</b>로 제외한다(자기 slug 재저장 허용).
	 * create는 {@code selfId=null}이라 같은 slug의 행이 하나라도 있으면 taken이다.
	 */
	private boolean spoolDirTaken(String spoolDir, Double selfId) {
		for (Map<String, Object> row : this.targets.query(Map.of("spoolDir", spoolDir))) {
			double rowId = ((Number) row.get("id")).doubleValue();
			if (selfId == null || rowId != selfId) {
				return true;
			}
		}
		return false;
	}

	/**
	 * id 정규화 — DB의 id는 INTEGER PK라 항상 정수다. 진입부에서 {@code double}로 맞춰
	 * findById/applyPatch/self-exclusion이 같은 타입을 보게 한다. 숫자로 변환되지 않는 id는 이미 라우트의
	 * {@code Number()}에서 NaN이고, findById가 매치 없이 {@code null}을 내 not-found로 수렴한다.
	 */
	private static double normalizeId(double id) {
		return id;
	}

	/** 허용 키의 원시값(문자열/숫자)만 통과 — 배열·객체는 무시한다(모델 바인딩 오류·필터 주입 차단). */
	private static Map<String, Object> pickFilters(Map<String, ?> filters) {
		Map<String, Object> out = new LinkedHashMap<>();
		if (filters == null) {
			return out;
		}
		for (String key : FILTER_KEYS) {
			Object value = filters.get(key);
			if (value instanceof String || value instanceof Number) {
				out.put(key, value);
			}
		}
		return out;
	}

	/** DB 행 → SAFE_FIELDS 7키 투영(allowlist). 행에 있는 키만 담되 모델이 전 컬럼을 항상 싣는다. */
	private static Map<String, Object> sanitize(Map<String, Object> row) {
		Map<String, Object> out = new LinkedHashMap<>();
		for (String field : SAFE_FIELDS) {
			if (row.containsKey(field)) {
				out.put(field, row.get(field));
			}
		}
		return out;
	}

	private static Map<String, Object> ok(String key, Object value) {
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", true);
		out.put(key, value);
		return out;
	}

	private static Map<String, Object> fail(String reason) {
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", false);
		out.put("reason", reason);
		return out;
	}
}
