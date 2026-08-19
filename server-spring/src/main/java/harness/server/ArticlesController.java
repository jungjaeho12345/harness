package harness.server;

import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/articles — 세션 게이트 최소 라우트(phase 68 범위). 세션 없으면 401 unauthenticated,
 * 있으면 200 {ok:true, items:[]}.
 *
 * <p>이 phase 는 <b>세션 게이트 통과/차단만</b> 계약에 걸린다(session-guard 계약: 비활성화된 세션의 죽은
 * 토큰이 이 라우트에서도 401 로 영구 무효임을 실증). 기사 조회 도메인 로직(필터 화이트리스트·Contents
 * 투영·수집/생애주기)은 후속 phase(69+) 범위이며 여기에 넣지 않는다 — 유효 세션 응답은 최소 {items:[]} 스텁이다.
 */
@RestController
public class ArticlesController {

    private final SessionStore sessions;

    public ArticlesController(SessionStore sessions) {
        this.sessions = sessions;
    }

    @GetMapping("/api/articles")
    public ResponseEntity<Map<String, Object>> listArticles(HttpServletRequest req) {
        UserRow me = sessions.resolve(Sessions.sessionId(req)); // 매 요청 재도출(ADR-004).
        if (me == null) {
            return Responses.reject("unauthenticated");
        }
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("ok", true);
        resp.put("items", List.of()); // 후속 phase 스텁 — subset 은 유효 세션 items 를 단언하지 않는다.
        return ResponseEntity.ok(resp);
    }
}
