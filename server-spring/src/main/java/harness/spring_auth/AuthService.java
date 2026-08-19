package harness.spring_auth;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

/**
 * 로그인 정책 — 자격 검증(bcrypt)·계정잠금(5회/15분)·사용자 열거 방지. src/services/userService.js와 동형.
 *
 * 판정 순서(계약): (1) 비활성(active='N') → inactive, (2) 잠금 → locked(올바른 비번도 거부),
 *   (3) 자격 불일치 → invalid-credentials(실패 카운트 누적, 임계 도달 시 잠금 설정), (4) 성공 → 잠금 리셋.
 *   존재/미존재 계정 모두 bcrypt 비교를 1회 수행해(더미 해시) 타이밍·열거 단서를 줄인다.
 *   잠금 시각(lockedUntil)은 epoch-millis 문자열로 저장한다(Node userService와 동형).
 */
public class AuthService {

	static final int LOCKOUT_THRESHOLD = 5;
	static final long LOCKOUT_DURATION_MS = 15L * 60L * 1000L;

	private static final BCryptPasswordEncoder BCRYPT = new BCryptPasswordEncoder();
	// 미존재/무해시 계정도 동일 비용의 비교를 수행하기 위한 더미 해시(타이밍 완화).
	private static final String DUMMY_HASH = BCRYPT.encode("*timing-equalizer*");

	private final NewsDb db;
	private final LongSupplier clock;

	public AuthService(NewsDb db) {
		this(db, System::currentTimeMillis);
	}

	public AuthService(NewsDb db, LongSupplier clock) {
		this.db = db;
		this.clock = clock;
	}

	/** 로그인 결과 — ok면 userId·user(6키), 아니면 reason(inactive|locked|invalid-credentials). */
	public record Result(boolean ok, String reason, String userId, Map<String, Object> user) {
		static Result fail(String reason) {
			return new Result(false, reason, null, null);
		}

		static Result success(String userId, Map<String, Object> user) {
			return new Result(true, null, userId, user);
		}
	}

	public Result login(String userId, String password) {
		NewsDb.User row = (userId == null || userId.isBlank()) ? null : db.findUser(userId);
		String hash = (row != null && row.password() != null) ? row.password() : DUMMY_HASH;
		boolean passwordOk = BCRYPT.matches(password == null ? "" : password, hash);

		// 비활성 거부는 잠금·카운트보다 우선(비활성 계정에 카운트를 올리지 않는다).
		if (row != null && "N".equals(row.active())) {
			return Result.fail("inactive");
		}
		// 잠긴 계정은 올바른 비밀번호여도 거부 — 자격 판정보다 먼저(잠금 우선).
		if (row != null && isLocked(row)) {
			return Result.fail("locked");
		}
		// 자격 불일치 — 실패 카운트 누적, 임계 도달 시 잠금 설정. 미존재/존재 모두 같은 응답(열거 방지).
		if (row == null || !passwordOk) {
			if (row != null) {
				registerFailure(row);
			}
			return Result.fail("invalid-credentials");
		}
		resetLockout(row);
		return Result.success(row.userId(), safeUser(row));
	}

	private boolean isLocked(NewsDb.User row) {
		String until = row.lockedUntil();
		if (until == null || until.isBlank()) {
			return false;
		}
		try {
			return Long.parseLong(until.trim()) > clock.getAsLong();
		} catch (NumberFormatException e) {
			return false;
		}
	}

	private void registerFailure(NewsDb.User row) {
		long next = parseCount(row.failedLoginCount()) + 1;
		Map<String, String> patch = new HashMap<>();
		patch.put("failedLoginCount", String.valueOf(next));
		patch.put("lastFailedLoginAt", String.valueOf(clock.getAsLong()));
		if (next >= LOCKOUT_THRESHOLD) {
			patch.put("lockedUntil", String.valueOf(clock.getAsLong() + LOCKOUT_DURATION_MS));
		}
		db.updateUser(row.userId(), patch);
	}

	private void resetLockout(NewsDb.User row) {
		Map<String, String> patch = new HashMap<>();
		patch.put("failedLoginCount", "0");
		patch.put("lockedUntil", null); // SQL NULL로 비운다(잠금 없음이 명확).
		patch.put("lastFailedLoginAt", null);
		db.updateUser(row.userId(), patch);
	}

	private static long parseCount(String s) {
		if (s == null || s.isBlank()) {
			return 0;
		}
		try {
			return Long.parseLong(s.trim());
		} catch (NumberFormatException e) {
			return 0;
		}
	}

	/** 로그인 응답 user — SAFE_FIELDS 6키(password·잠금 메타 제외). */
	static Map<String, Object> safeUser(NewsDb.User u) {
		Map<String, Object> user = new LinkedHashMap<>();
		user.put("userId", u.userId());
		user.put("name", u.name());
		user.put("role", u.role());
		user.put("department", u.department());
		user.put("departmentCode", u.departmentCode());
		user.put("active", u.active());
		return user;
	}
}
