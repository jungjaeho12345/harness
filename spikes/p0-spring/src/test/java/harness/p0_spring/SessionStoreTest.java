package harness.p0_spring;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 세션 저장소 — ConcurrentHashMap + SecureRandom 64-hex (CONTRACT.md 쿠키 절).
 * 비밀번호는 세션 사용자 스냅샷에 싣지 않는다(신뢰 경계 — 응답 직렬화 원천 차단).
 */
class SessionStoreTest {

    private static NewsDb.User user(String id) {
        return new NewsDb.User(id, "이름", "Z", "운영부", "ADM", "Y", "$2a$10$hash");
    }

    @Test
    void issueReturns64LowercaseHex() {
        SessionStore store = new SessionStore();
        String sid = store.issue(user("admin"));
        assertThat(sid).matches("[0-9a-f]{64}");
    }

    @Test
    void issueIsUniquePerCall() {
        SessionStore store = new SessionStore();
        assertThat(store.issue(user("a"))).isNotEqualTo(store.issue(user("a")));
    }

    @Test
    void resolveReturnsIssuedUser() {
        SessionStore store = new SessionStore();
        String sid = store.issue(user("reporter"));
        assertThat(store.resolve(sid).userId()).isEqualTo("reporter");
    }

    @Test
    void resolveUnknownOrNullIsNull() {
        SessionStore store = new SessionStore();
        assertThat(store.resolve("deadbeef")).isNull();
        assertThat(store.resolve(null)).isNull();
    }

    @Test
    void removeInvalidatesSession() {
        SessionStore store = new SessionStore();
        String sid = store.issue(user("desk"));
        store.remove(sid);
        assertThat(store.resolve(sid)).isNull();
        store.remove(null); // 무해해야 한다(로그아웃은 항상 200).
    }
}
