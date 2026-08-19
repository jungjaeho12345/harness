package harness.server;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/** AdminController HTTP 계약 슬라이스 — Z 게이트·역할별 투영·중복 500·changes:0. 협력자 모킹, DB 없음. */
@WebMvcTest(AdminController.class)
class AdminControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private SessionStore sessions;
    @MockitoBean
    private UserService userService;
    @MockitoBean
    private UserRepository users;

    private static final String SID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static UserRow z() {
        return new UserRow("admin", "관리자", "Z", "운영부", "ADM", "Y", "H", "0", null, null);
    }

    private static UserRow r() {
        return new UserRow("reporter", "김기자", "R", "사회부", "SOC", "Y", "H", "0", null, null);
    }

    private static Map<String, Object> sixKeyRow() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("userId", "reporter");
        m.put("name", "김기자");
        m.put("role", "R");
        m.put("department", "사회부");
        m.put("departmentCode", "SOC");
        m.put("active", "Y");
        return m;
    }

    // --- GET /api/users ---

    @Test
    void listUnauthenticated401() throws Exception {
        given(sessions.resolve(any())).willReturn(null);
        mvc.perform(get("/api/users"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.reason").value("unauthenticated"));
    }

    @Test
    void listAsZReturnsSixKeys() throws Exception {
        given(sessions.resolve(any())).willReturn(z());
        given(users.listUsers()).willReturn(List.of(sixKeyRow()));
        mvc.perform(get("/api/users").header("x-session-id", SID))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].role").value("R"))
                .andExpect(jsonPath("$.items[0].active").value("Y"))
                .andExpect(jsonPath("$.items[0].length()").value(6));
    }

    @Test
    void listAsNonZReturnsFourKeysNoRoleNoActive() throws Exception {
        given(sessions.resolve(any())).willReturn(r());
        given(users.listUsers()).willReturn(List.of(sixKeyRow()));
        mvc.perform(get("/api/users").header("x-session-id", SID))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].userId").value("reporter"))
                .andExpect(jsonPath("$.items[0].role").doesNotExist())
                .andExpect(jsonPath("$.items[0].active").doesNotExist())
                .andExpect(jsonPath("$.items[0].length()").value(4));
    }

    // --- POST /api/users ---

    @Test
    void createUnauthenticated401NoModelCall() throws Exception {
        given(sessions.resolve(any())).willReturn(null);
        mvc.perform(post("/api/users").contentType(MediaType.APPLICATION_JSON).content("{\"userId\":\"x\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.reason").value("unauthenticated"));
        verify(userService, never()).create(any());
    }

    @Test
    void createNonZForbidden403NoModelCall() throws Exception {
        given(sessions.resolve(any())).willReturn(r());
        mvc.perform(post("/api/users").header("x-session-id", SID)
                .contentType(MediaType.APPLICATION_JSON).content("{\"userId\":\"x\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.reason").value("forbidden"));
        verify(userService, never()).create(any());
    }

    @Test
    void createAsZReturnsUser() throws Exception {
        given(sessions.resolve(any())).willReturn(z());
        Map<String, Object> created = new LinkedHashMap<>();
        created.put("userId", "newbie");
        created.put("role", "R");
        created.put("active", "Y");
        given(userService.create(any())).willReturn(created);
        mvc.perform(post("/api/users").header("x-session-id", SID)
                .contentType(MediaType.APPLICATION_JSON).content("{\"userId\":\"newbie\",\"role\":\"R\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true))
                .andExpect(jsonPath("$.user.userId").value("newbie"))
                .andExpect(jsonPath("$.user.password").doesNotExist());
    }

    @Test
    void createDuplicateBecomes500InternalError() throws Exception {
        given(sessions.resolve(any())).willReturn(z());
        given(userService.create(any())).willThrow(new RuntimeException("UNIQUE constraint failed"));
        mvc.perform(post("/api/users").header("x-session-id", SID)
                .contentType(MediaType.APPLICATION_JSON).content("{\"userId\":\"dup\"}"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.reason").value("internal-error"))
                .andExpect(jsonPath("$.stack").doesNotExist()); // 내부 정보 미노출
    }

    // --- PUT /api/users/:id ---

    @Test
    void updateNonZForbidden403() throws Exception {
        given(sessions.resolve(any())).willReturn(r());
        mvc.perform(put("/api/users/reporter").header("x-session-id", SID)
                .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"x\"}"))
                .andExpect(status().isForbidden());
        verify(userService, never()).update(any(), any());
    }

    @Test
    void updateAsZReturnsChanges() throws Exception {
        given(sessions.resolve(any())).willReturn(z());
        given(userService.update(eq("reporter"), any())).willReturn(1);
        mvc.perform(put("/api/users/reporter").header("x-session-id", SID)
                .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"새이름\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true))
                .andExpect(jsonPath("$.changes").value(1));
    }

    @Test
    void updateMissingUserIdReturnsChangesZeroNot404() throws Exception {
        given(sessions.resolve(any())).willReturn(z());
        given(userService.update(any(), any())).willReturn(0);
        mvc.perform(put("/api/users/ghost").header("x-session-id", SID)
                .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"x\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.changes").value(0));
    }

    // --- GET /api/logs/digest (Z 게이트만) ---

    @Test
    void logsDigestZ200() throws Exception {
        given(sessions.resolve(any())).willReturn(z());
        mvc.perform(get("/api/logs/digest").header("x-session-id", SID))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true));
    }

    @Test
    void logsDigestNonZ403() throws Exception {
        given(sessions.resolve(any())).willReturn(r());
        mvc.perform(get("/api/logs/digest").header("x-session-id", SID))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.reason").value("forbidden"));
    }

    @Test
    void logsDigestUnauthenticated401() throws Exception {
        given(sessions.resolve(any())).willReturn(null);
        mvc.perform(get("/api/logs/digest"))
                .andExpect(status().isUnauthorized());
    }
}
