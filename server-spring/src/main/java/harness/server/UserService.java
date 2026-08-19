package harness.server;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

/**
 * 사용자 도메인 서비스 — 로그인/잠금 로직(HTTP 비의존, ADR-006). userService.js 1:1 이식.
 *
 * <p>규율:
 * <ul>
 *   <li>존재하지 않는 사용자도 더미 해시로 bcrypt 비교 1회 → 성공/실패 경로 타이밍 차이 완화(계정 열거 방지).</li>
 *   <li>비활성(active='N') 거부는 잠금 판정·카운트보다 <b>우선</b>(비활성 계정에 카운트 올리지 않음).</li>
 *   <li>잠긴 계정은 <b>올바른 비밀번호여도</b> locked(자격 판정보다 잠금 우선).</li>
 *   <li>실패 누적은 임계(기본 5) 도달 시 lockedUntil=now+windowMs 설정, 성공 시 리셋(행 삭제 없음 — 필드만).</li>
 *   <li>비밀번호(평문/해시)는 어떤 반환값에도 없다 — 반환은 {@link UserRow}(상위가 Projections 로 투영).</li>
 * </ul>
 * bcrypt 검증은 spring-security-crypto {@link BCryptPasswordEncoder}(bcryptjs $2a$ 해시 호환).
 */
public class UserService {

    public static final int LOCKOUT_THRESHOLD = 5;
    public static final long LOCKOUT_DURATION_MS = 15L * 60L * 1000L;

    private final BCryptPasswordEncoder bcrypt = new BCryptPasswordEncoder();
    // 사용자가 없을 때도 동일 비용의 bcrypt 비교를 하기 위한 더미 해시(타이밍 완화).
    private final String dummyHash = bcrypt.encode("*timing-equalizer*");

    private final UserRepository users;
    private final LongSupplier now;
    private final int threshold;
    private final long windowMs;

    public UserService(UserRepository users, LongSupplier now) {
        this(users, now, LOCKOUT_THRESHOLD, LOCKOUT_DURATION_MS);
    }

    public UserService(UserRepository users, LongSupplier now, int threshold, long windowMs) {
        this.users = users;
        this.now = now;
        this.threshold = threshold;
        this.windowMs = windowMs;
    }

    /** 로그인 결과 — 성공 시 row(안전 투영은 상위가 한다), 실패 시 reason 토큰. */
    public record LoginResult(boolean ok, String reason, UserRow row) {
        static LoginResult fail(String reason) {
            return new LoginResult(false, reason, null);
        }

        static LoginResult success(UserRow row) {
            return new LoginResult(true, null, row);
        }
    }

    public LoginResult login(String userId, String password) {
        UserRow row = (userId == null || userId.isEmpty()) ? null : users.findUser(userId);
        String hash = (row != null && row.password() != null) ? row.password() : dummyHash;
        // 잠긴/없는 경우에도 bcrypt 비교를 1회 수행(경로 간 소요 시간 차이 완화).
        boolean passwordOk = bcrypt.matches(password == null ? "" : password, hash);

        // 비활성 거부는 잠금·카운트보다 우선.
        if (row != null && "N".equals(row.active())) {
            return LoginResult.fail("inactive");
        }
        // 잠긴 계정은 올바른 비밀번호여도 거부(자격보다 잠금 우선).
        if (row != null && isLocked(row)) {
            return LoginResult.fail("locked");
        }
        // 자격 불일치 — 존재하는 계정이면 실패 누적. 응답은 존재/부재 구분 없이 동일.
        if (row == null || !passwordOk) {
            if (row != null) {
                registerFailure(row);
            }
            return LoginResult.fail("invalid-credentials");
        }
        // 성공 — 잠금 카운트/시각 리셋.
        resetLockout(row);
        return LoginResult.success(row);
    }

    private boolean isLocked(UserRow row) {
        Long until = parseLong(row.lockedUntil());
        return until != null && until > now.getAsLong();
    }

    private void registerFailure(UserRow row) {
        long current = parseLongOrZero(row.failedLoginCount());
        long next = current + 1;
        Map<String, Object> patch = new LinkedHashMap<>();
        patch.put("failedLoginCount", String.valueOf(next));
        patch.put("lastFailedLoginAt", String.valueOf(now.getAsLong()));
        if (next >= threshold) {
            patch.put("lockedUntil", String.valueOf(now.getAsLong() + windowMs));
        }
        users.updateUser(row.userId(), patch);
    }

    private void resetLockout(UserRow row) {
        Map<String, Object> patch = new LinkedHashMap<>();
        patch.put("failedLoginCount", "0");
        patch.put("lockedUntil", null); // SQL NULL — "잠금 없음"이 명확.
        patch.put("lastFailedLoginAt", null);
        users.updateUser(row.userId(), patch);
    }

    /**
     * 사용자 생성 — password 는 bcrypt 해시로 저장(미지정 시 빈 문자열 해시, userService.js 동형).
     * 반환은 안전 투영(SAFE_FIELDS, null 제외 — 비밀번호 없음). 중복 userId·미지 컬럼은 예외를 전파한다
     * (상위 전역 핸들러가 500 internal-error 로 매핑 — 400/409 아님, 계약).
     */
    public Map<String, Object> create(Map<String, Object> dto) {
        Map<String, Object> row = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : dto.entrySet()) {
            if ("password".equals(e.getKey())) {
                continue; // 해시로 대체(아래).
            }
            row.put(e.getKey(), e.getValue());
        }
        Object pw = dto.get("password");
        row.put("password", bcrypt.encode(pw == null ? "" : String.valueOf(pw)));
        users.insertUser(row); // 중복/미지 컬럼 → 예외 전파(전역 500). active 미지정 시 DB DEFAULT 'Y'.
        UserRow saved = users.findUser(String.valueOf(dto.get("userId")));
        return Projections.safe(saved);
    }

    /**
     * 사용자 수정 — password 가 오면 해시로 저장(없으면 그대로). 변경 행 수 반환(없는 userId 는 0 — 존재 판정 안 함).
     * 행을 삭제하지 않는다(비활성화는 active='N' UPDATE).
     */
    public int update(String userId, Map<String, Object> fields) {
        Map<String, Object> patch = new LinkedHashMap<>(fields);
        if (patch.containsKey("password")) {
            Object pw = patch.get("password");
            patch.put("password", bcrypt.encode(pw == null ? "" : String.valueOf(pw)));
        }
        return users.updateUser(userId, patch);
    }

    private static Long parseLong(String s) {
        if (s == null || s.isEmpty()) {
            return null;
        }
        try {
            return Long.valueOf(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static long parseLongOrZero(String s) {
        Long v = parseLong(s);
        return v == null ? 0L : v;
    }
}
