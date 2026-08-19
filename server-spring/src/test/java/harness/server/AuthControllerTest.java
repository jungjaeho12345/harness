package harness.server;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * AuthController HTTP 계약 슬라이스 — 협력자(UserService·SessionStore·LoginRateLimiter·AppConfig) 를
 * 모킹해 상태코드·쿠키 속성·본문 shape 을 DB 없이 검증한다. 실제 종단 검증은 계약 하네스(step5).
 */
@WebMvcTest(AuthController.class)
class AuthControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private UserService userService;
    @MockitoBean
    private SessionStore sessions;
    @MockitoBean
    private LoginRateLimiter rateLimiter;
    @MockitoBean
    private AppConfig config;

    private static final String SID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String LOGIN_BODY = "{\"userId\":\"reporter\",\"password\":\"reporter123\"}";

    private static UserRow reporter() {
        return new UserRow("reporter", "김기자", "R", "사회부", "SOC", "Y", "HASH", "0", null, null);
    }

    @BeforeEach
    void defaults() {
        given(rateLimiter.allow(any())).willReturn(true);
        given(rateLimiter.limit()).willReturn(10);
        given(config.isProdCookie()).willReturn(false);
    }

    @Test
    void loginSuccessReturns6KeyUserAndLaxCookie() throws Exception {
        given(userService.login(any(), any()))
                .willReturn(new UserService.LoginResult(true, null, reporter()));
        given(sessions.issue("reporter")).willReturn(SID);

        mvc.perform(post("/api/login").contentType(MediaType.APPLICATION_JSON).content(LOGIN_BODY))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true))
                .andExpect(jsonPath("$.sessionId").value(SID))
                .andExpect(jsonPath("$.user.userId").value("reporter"))
                .andExpect(jsonPath("$.user.active").value("Y"))
                .andExpect(jsonPath("$.user.password").doesNotExist())
                .andExpect(jsonPath("$.user.length()").value(6))
                .andExpect(header().string("Set-Cookie", org.hamcrest.Matchers.allOf(
                        org.hamcrest.Matchers.containsString("sid=" + SID),
                        org.hamcrest.Matchers.containsString("Path=/"),
                        org.hamcrest.Matchers.containsString("Max-Age=3600"),
                        org.hamcrest.Matchers.containsString("HttpOnly"),
                        org.hamcrest.Matchers.containsString("SameSite=Lax"),
                        org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("Secure")))));
    }

    @Test
    void loginInvalidCredentials401() throws Exception {
        given(userService.login(any(), any()))
                .willReturn(new UserService.LoginResult(false, "invalid-credentials", null));
        mvc.perform(post("/api/login").contentType(MediaType.APPLICATION_JSON).content(LOGIN_BODY))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.ok").value(false))
                .andExpect(jsonPath("$.reason").value("invalid-credentials"));
    }

    @Test
    void loginInactive403() throws Exception {
        given(userService.login(any(), any()))
                .willReturn(new UserService.LoginResult(false, "inactive", null));
        mvc.perform(post("/api/login").contentType(MediaType.APPLICATION_JSON).content(LOGIN_BODY))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.reason").value("inactive"));
    }

    @Test
    void loginLocked423() throws Exception {
        given(userService.login(any(), any()))
                .willReturn(new UserService.LoginResult(false, "locked", null));
        mvc.perform(post("/api/login").contentType(MediaType.APPLICATION_JSON).content(LOGIN_BODY))
                .andExpect(status().isLocked())
                .andExpect(jsonPath("$.reason").value("locked"));
    }

    @Test
    void loginRateLimited429TextHtmlWithHeader() throws Exception {
        given(rateLimiter.allow(any())).willReturn(false);
        mvc.perform(post("/api/login").contentType(MediaType.APPLICATION_JSON).content(LOGIN_BODY))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().string("RateLimit-Limit", "10"))
                .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML))
                .andExpect(content().string(org.hamcrest.Matchers.containsString("Too many")));
    }

    @Test
    void loginProdCookieSecureAndSameSiteNone() throws Exception {
        given(config.isProdCookie()).willReturn(true);
        given(userService.login(any(), any()))
                .willReturn(new UserService.LoginResult(true, null, reporter()));
        given(sessions.issue("reporter")).willReturn(SID);

        mvc.perform(post("/api/login").contentType(MediaType.APPLICATION_JSON).content(LOGIN_BODY))
                .andExpect(status().isOk())
                .andExpect(header().string("Set-Cookie", org.hamcrest.Matchers.allOf(
                        org.hamcrest.Matchers.containsString("Secure"),
                        org.hamcrest.Matchers.containsString("SameSite=None"))));
    }

    @Test
    void logoutIdempotentClearsCookie() throws Exception {
        mvc.perform(post("/api/logout"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true))
                .andExpect(header().string("Set-Cookie", org.hamcrest.Matchers.allOf(
                        org.hamcrest.Matchers.containsString("sid=;"),
                        org.hamcrest.Matchers.containsString("Max-Age=0"))));
    }

    @Test
    void sessionUnauthenticated401() throws Exception {
        given(sessions.resolve(any())).willReturn(null);
        mvc.perform(get("/api/session"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.reason").value("unauthenticated"));
    }

    @Test
    void sessionValidReturns5KeyIdentity() throws Exception {
        given(sessions.resolve(any())).willReturn(reporter());
        mvc.perform(get("/api/session").header("x-session-id", SID))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true))
                .andExpect(jsonPath("$.user.role").value("R"))
                .andExpect(jsonPath("$.user.active").doesNotExist()) // 세션 투영은 5키(active 없음)
                .andExpect(jsonPath("$.user.password").doesNotExist())
                .andExpect(jsonPath("$.user.length()").value(5));
    }
}
