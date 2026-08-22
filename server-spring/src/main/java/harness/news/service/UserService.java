package harness.news.service;

import harness.news.model.UserRepository;
import harness.news.model.UserRow;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.security.crypto.bcrypt.BCrypt;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

/**
 * 사용자 도메인 서비스 — 로그인 판정·계정 잠금·생성/수정. HTTP 비의존이다(ADR-006).
 * 리포 루트 {@code src/services/userService.js}와 1:1 이식이며, <b>HTTP 상태코드는 여기서 정하지 않는다</b>
 * (사유 토큰 → 상태 매핑은 web 계층 책임: {@code invalid-credentials} 401 · {@code inactive} 403 ·
 * {@code locked} <b>423</b>(로그인 라우트 로컬 매핑)).
 *
 * <h2>판정 순서가 계약이다</h2>
 * <ol>
 *   <li>{@code active='N'} → {@code inactive} (잠금·카운트보다 <b>먼저</b> — 비활성 계정에는 실패를 누적하지 않는다)</li>
 *   <li>잠금 중 → {@code locked} (<b>올바른 비밀번호여도</b> 거부 — 자격 판정보다 우선)</li>
 *   <li>그 외 자격 불일치 → {@code invalid-credentials} (존재/미존재 계정이 <b>완전히 같은 결과</b>다)</li>
 * </ol>
 *
 * <h2>타이밍 완화</h2>
 * 사용자가 없거나 잠겨 있어도 bcrypt 비교를 <b>정확히 1회</b> 수행한다(더미 해시 1개를 서비스 초기화 시 만든다).
 * 이 축은 단위 테스트로 관측하지 않으며 계약 스위트도 동결하지 않는다 — <b>규율로 지킨다</b>.
 *
 * <h2>잠금 상태의 저장 표현(Node와 바이트 동형 — index.json decisions (11))</h2>
 * {@code failedLoginCount}는 문자열 정수({@code '0'},{@code '1'}…), {@code lockedUntil}·
 * {@code lastFailedLoginAt}은 <b>epoch ms 문자열</b>이다({@code src/db/schema.js} 주석의 'ISO-8601'은
 * 드리프트이고 {@code userService.js} 코드가 정본이다). 성공 시 리셋은 {@code '0'} + SQL NULL이며
 * <b>행을 지우지 않는다</b>(DB 비파괴 — 잠금 해제도 UPDATE다).
 *
 * <h2>알려진 결함의 의도적 재현(decisions (12) — 여기서 고치지 않는다)</h2>
 * <ul>
 *   <li><b>#2</b> {@link #create}는 입력을 검증하지 않는다: 비밀번호가 없으면 <b>빈 문자열을 해시</b>하고
 *       (= 빈 비밀번호가 유효 자격증명이 된다), {@code role} 값도 검증하지 않는다.</li>
 *   <li><b>#1</b> 중복 {@code userId}의 제약 위반 예외를 <b>삼키지 않는다</b> — 현행 계약은 전역 에러
 *       핸들러가 만드는 {@code 500 internal-error}다. 여기서 4xx로 바꾸면 패리티 측정이 불가능해진다.</li>
 * </ul>
 * 고치는 시점은 Node·Spring·명세·계약 케이스를 한 번에 바꾸는 별도 판단이다(forward_notes (6)).
 */
@Service
public class UserService {

	/**
	 * 응답에 노출 가능한 사용자 필드 — Node {@code SAFE_FIELDS}. 비밀번호와 잠금 메타
	 * ({@code failedLoginCount}·{@code lockedUntil}·{@code lastFailedLoginAt})는 계정 열거 단서라 제외한다.
	 *
	 * <p>세션 신원({@link Identity})의 5키와 <b>다른 shape</b>이다({@code active}가 있고 순서도 다르다) —
	 * {@code auth.contract.js}가 두 키 집합을 각각 동결한다. 두 투영을 하나로 합치지 마라.
	 */
	static final List<String> SAFE_FIELDS =
			List.of("userId", "name", "role", "department", "departmentCode", "active");

	/**
	 * 계정 잠금 정책 — 5회 실패 / 15분. <b>계약값이라 설정으로 덮지 않는다</b>(환경마다 다른 판정이 나오면
	 * 계약 스위트가 무의미해진다). 근거: {@code userService.js}의 {@code LOCKOUT_THRESHOLD}는 무옵션
	 * 기본값이고 {@code src/controllers/index.js}는 잠금 정책을 주입하지 않는다.
	 */
	static final int LOCKOUT_THRESHOLD = 5;

	static final long LOCKOUT_DURATION_MS = 15L * 60L * 1000L;

	/**
	 * 해싱 전용 — cost 10, {@code $2a$} 판본이라 bcryptjs가 만든 해시와 호환된다(P0 스파이크 실측).
	 * <b>대조는 이 객체로 하지 않는다</b> — 이유는 {@link #matches(String, String)}에 적었다.
	 */
	private final BCryptPasswordEncoder bcrypt = new BCryptPasswordEncoder();

	/** 사용자가 없을 때도 같은 비용의 비교를 하기 위한 더미 해시(타이밍 완화). 초기화 시 1회만 만든다. */
	private final String dummyHash = this.bcrypt.encode("*timing-equalizer*");

	private final UserRepository users;

	private final Clock clock;

	public UserService(UserRepository users, Clock clock) {
		this.users = users;
		this.clock = clock;
	}

	/**
	 * 로그인 판정 결과. 성공이면 {@link #user()}가 SAFE_FIELDS 6키 투영이고, 실패면 사유 토큰만 있다.
	 * 비밀번호·잠금 메타는 어느 경로에도 담지 않는다(잠금까지 남은 횟수도 알려주지 않는다 — 열거 단서다).
	 */
	public record LoginResult(boolean ok, String reason, Map<String, Object> user) {

		static LoginResult fail(String reason) {
			return new LoginResult(false, reason, null);
		}

		static LoginResult success(Map<String, Object> user) {
			return new LoginResult(true, null, user);
		}
	}

	/**
	 * 아이디/비밀번호 대조 로그인.
	 *
	 * <p>비교는 판정보다 <b>먼저</b> 1회 수행한다 — 사용자 부재·비활성·잠금 어느 경로로 빠지든 bcrypt 비용이
	 * 똑같이 들게 하기 위해서다(계정 열거·상태 추정 완화). 판정 순서는 클래스 주석의 계약을 따른다.
	 */
	public LoginResult login(String userId, String password) {
		UserRow row = this.users.findById(userId);
		String hash = storedHashOrDummy(row);
		boolean passwordOk = matches(password == null ? "" : password, hash);

		// 비활성 거부가 최우선 — 잠금 판정도 실패 누적도 하지 않는다.
		if (row != null && "N".equals(row.active())) {
			return LoginResult.fail("inactive");
		}
		// 잠긴 계정은 올바른 비밀번호여도 거부한다(자격 판정보다 잠금이 먼저다).
		if (row != null && isLocked(row)) {
			return LoginResult.fail("locked");
		}
		// 자격 불일치 — 존재하는 계정이면 실패를 누적한다. 결과는 미존재 계정과 완전히 같다.
		if (row == null || !passwordOk) {
			if (row != null) {
				registerFailure(row);
			}
			return LoginResult.fail("invalid-credentials");
		}

		resetLockout(row);
		return LoginResult.success(project(row));
	}

	/**
	 * 사용자 생성 — 비밀번호는 bcrypt 해시로 저장하고 {@code active} 미지정이면 {@code 'Y'}다.
	 *
	 * <p><b>입력 검증이 없다</b>(결함 후보 #2의 의도적 재현 — 클래스 주석). 중복 {@code userId}는
	 * 제약 위반 예외가 그대로 올라간다(결함 후보 #1).
	 *
	 * @return SAFE_FIELDS 투영. <b>요청에 없던 키는 담기지 않는다</b> — Node {@code sanitize}가
	 *     {@code undefined}인 필드를 건너뛰는 동작이며, DB 기본값을 되읽지도 않는다.
	 *     (로그인·세션 응답은 반대로 키를 항상 남기고 NULL을 {@code null}로 싣는다.)
	 */
	public Map<String, Object> create(Map<String, Object> dto) {
		Map<String, Object> row = new LinkedHashMap<>();
		if (dto != null) {
			row.putAll(dto);
		}
		row.put("password", this.bcrypt.encode(asText(row.get("password"))));
		row.put("active", row.get("active") == null ? "Y" : row.get("active"));
		this.users.insert(row); // 화이트리스트 밖 키는 리포지토리가 조용히 무시한다(Node 동형).
		return projectDefined(row);
	}

	/**
	 * 전체 사용자 명단 — 행마다 SAFE_FIELDS 6키로 투영한다(Node {@code query({})} = {@code map(sanitize)}).
	 *
	 * <p>비밀번호 해시와 잠금 메타({@code failedLoginCount}·{@code lockedUntil}·{@code lastFailedLoginAt})는
	 * 투영을 통과하지 못하므로 <b>어떤 경로로도</b> 나가지 않는다. 키는 항상 6개이고 값이 SQL NULL이면
	 * {@code null}이다(키를 빼면 "정확 6키" 계약이 값에 따라 무너진다 — index.json decisions (5)·(20)).
	 *
	 * <p><b>이 서비스는 role을 모른다.</b> 역할별 투영 축소(비-Z 4키)는 컨트롤러가 세션에서 재도출한
	 * 신원으로 판단한다(Node 동형: 라우트가 재투영한다). 여기에 role 파라미터를 만들면 acting role이
	 * 서비스 호출자의 규율로 내려앉는다(ADR-004).
	 *
	 * @return 새 리스트(호출자가 바꿔도 DB·서비스에 되먹임되지 않는다)
	 */
	public List<Map<String, Object>> list() {
		List<Map<String, Object>> items = new ArrayList<>();
		for (UserRow row : this.users.query(Map.of())) {
			items.add(project(row));
		}
		return items;
	}

	/**
	 * 사용자 수정 — {@code password}가 오면 해시로 치환하고 나머지는 그대로 패치한다.
	 *
	 * @return 영향 받은 행 수. 존재 판정을 하지 않으므로 <b>없는 id도 예외가 아니라 0</b>이다(계약).
	 */
	public int update(String userId, Map<String, Object> fields) {
		Map<String, Object> patch = new LinkedHashMap<>();
		if (fields != null) {
			patch.putAll(fields);
		}
		if (patch.containsKey("password")) {
			// Node는 create와 달리 update에서 String(value)를 쓴다 — null이면 문자열 "null"이 해시된다.
			patch.put("password", this.bcrypt.encode(String.valueOf(patch.get("password"))));
		}
		return this.users.update(userId, patch);
	}

	/**
	 * bcrypt 대조 — {@link BCrypt#checkpw}를 <b>직접</b> 부른다(알고리즘 구현은 인코더가 쓰는 것과 같은 클래스다).
	 *
	 * <p><b>{@code BCryptPasswordEncoder.matches}를 쓰면 안 된다(실측).</b> spring-security 7의 인코더는
	 * 상위 {@code AbstractValidatingPasswordEncoder}가 <b>빈 raw 비밀번호를 검증에서 탈락</b>시켜 해시가
	 * 일치해도 {@code false}를 돌려준다({@code checkpw("", hash)}는 {@code true}인데 말이다).
	 * Node의 bcryptjs {@code compare('', hash)}는 {@code true}이므로, 인코더를 쓰면 결함 후보 #2로 만들어진
	 * "빈 비밀번호 계정"이 Node에서는 로그인되고 Spring에서는 안 되는 <b>조용한 패리티 파괴</b>가 된다.
	 * 이 규율은 {@code UserServiceAdminTest}의 결함 후보 #2 테스트가 잠근다.
	 *
	 * <p>저장된 해시가 bcrypt 형식이 아니면 예외 대신 불일치로 본다 — 데이터 이상이 500으로 번지지 않게 한다.
	 */
	private static boolean matches(String password, String hash) {
		try {
			return BCrypt.checkpw(password, hash);
		}
		catch (IllegalArgumentException ex) {
			return false;
		}
	}

	/** 저장된 해시가 없으면(미존재 계정·빈 비밀번호 컬럼) 더미 해시로 같은 비용의 비교를 만든다. */
	private String storedHashOrDummy(UserRow row) {
		if (row == null || row.password() == null || row.password().isEmpty()) {
			return this.dummyHash;
		}
		return row.password();
	}

	/** {@code lockedUntil}이 현재 시각보다 <b>미래</b>이면 잠긴 것으로 본다(정각에는 풀린다). */
	private boolean isLocked(UserRow row) {
		Long until = epochMs(row.lockedUntil());
		return until != null && until > this.clock.millis();
	}

	/** 실패 1회 누적 — 임계값 이상이면 같은 UPDATE에서 {@code lockedUntil}까지 설정한다. */
	private void registerFailure(UserRow row) {
		long now = this.clock.millis();
		long next = counter(row.failedLoginCount()) + 1;
		Map<String, Object> patch = new LinkedHashMap<>();
		patch.put("failedLoginCount", String.valueOf(next));
		patch.put("lastFailedLoginAt", String.valueOf(now));
		if (next >= LOCKOUT_THRESHOLD) {
			patch.put("lockedUntil", String.valueOf(now + LOCKOUT_DURATION_MS));
		}
		this.users.update(row.userId(), patch);
	}

	/**
	 * 성공 시 잠금 상태 초기화 — 카운트는 {@code '0'}, 시각 두 개는 SQL NULL이다.
	 * <b>행을 지우지 않는다</b>(비파괴: 필드만 비운다).
	 */
	private void resetLockout(UserRow row) {
		Map<String, Object> patch = new LinkedHashMap<>();
		patch.put("failedLoginCount", "0");
		patch.put("lockedUntil", null);
		patch.put("lastFailedLoginAt", null);
		this.users.update(row.userId(), patch);
	}

	/** DB 행 → SAFE_FIELDS 6키. 키는 <b>항상</b> 있고 값이 없으면 {@code null}이다. */
	private static Map<String, Object> project(UserRow row) {
		Map<String, Object> user = new LinkedHashMap<>();
		for (String field : SAFE_FIELDS) {
			user.put(field, valueOf(row, field));
		}
		return user;
	}

	/** 생성 입력 → SAFE_FIELDS 투영. 입력에 <b>있던 키만</b> 싣는다(Node sanitize 동형). */
	private static Map<String, Object> projectDefined(Map<String, Object> row) {
		Map<String, Object> user = new LinkedHashMap<>();
		for (String field : SAFE_FIELDS) {
			if (row.containsKey(field)) {
				user.put(field, row.get(field));
			}
		}
		return user;
	}

	private static Object valueOf(UserRow row, String field) {
		return switch (field) {
			case "userId" -> row.userId();
			case "name" -> row.name();
			case "role" -> row.role();
			case "department" -> row.department();
			case "departmentCode" -> row.departmentCode();
			case "active" -> row.active();
			default -> throw new IllegalStateException("SAFE_FIELDS에 없는 필드: " + field);
		};
	}

	/** 생성 시 비밀번호 표현 — Node {@code String(password ?? '')}. 값이 없으면 빈 문자열이다(결함 후보 #2). */
	private static String asText(Object value) {
		return value == null ? "" : String.valueOf(value);
	}

	/** epoch ms 문자열 파싱. 비어 있거나 숫자가 아니면 "잠금 없음"으로 본다(Node {@code Number.isFinite}). */
	private static Long epochMs(String value) {
		if (value == null || value.isBlank()) {
			return null;
		}
		try {
			return Long.valueOf(value.trim());
		}
		catch (NumberFormatException ex) {
			return null;
		}
	}

	/** 실패 카운터 파싱 — Node {@code Number(x) || 0}과 같이 해석 불가는 0이다. */
	private static long counter(String value) {
		Long parsed = epochMs(value);
		return parsed == null ? 0L : parsed;
	}
}
