package harness.server;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/** GET /api/articles 세션 게이트 슬라이스 — 죽은/없는 세션 401, 유효 세션 200 최소 응답. */
@WebMvcTest(ArticlesController.class)
class ArticlesControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private SessionStore sessions;

    private static final String SID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Test
    void unauthenticatedReturns401() throws Exception {
        given(sessions.resolve(any())).willReturn(null); // 죽은/없는 토큰
        mvc.perform(get("/api/articles").header("x-session-id", SID))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.ok").value(false))
                .andExpect(jsonPath("$.reason").value("unauthenticated"));
    }

    @Test
    void validSessionReturnsOkItems() throws Exception {
        given(sessions.resolve(any())).willReturn(
                new UserRow("reporter", "김기자", "R", "사회부", "SOC", "Y", "H", "0", null, null));
        mvc.perform(get("/api/articles").header("x-session-id", SID))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true))
                .andExpect(jsonPath("$.items").isArray());
    }
}
