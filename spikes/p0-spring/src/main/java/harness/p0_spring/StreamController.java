package harness.p0_spring;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * SSE (CONTRACT.md SSE 절) — 구독자 목록(CopyOnWriteArrayList) + ready 즉시 송신.
 * 미인증은 스트림을 열기 전에 401 JSON. 프레임 종결 빈 줄은 SseEmitter 가 보장한다
 * (실프레임은 curl 로 검증 — 검증 절 ⑨⑩).
 * 스파이크 전용 트리거: POST /spike/notify → 전 구독자에 change {"kind":"update"}.
 */
@RestController
public class StreamController {

    static final String READY_DATA = "{\"ok\":true}";
    static final String CHANGE_DATA = "{\"kind\":\"update\"}";

    private final SessionStore sessions;
    private final CopyOnWriteArrayList<SseEmitter> subscribers = new CopyOnWriteArrayList<>();

    public StreamController(SessionStore sessions) {
        this.sessions = sessions;
    }

    @GetMapping("/api/stream")
    public SseEmitter stream(HttpServletRequest req, HttpServletResponse res) throws IOException {
        if (sessions.resolve(Sessions.sessionId(req)) == null) {
            // 스트림 열기 전 401 JSON — httpModel 은 본문만 읽으므로 JSON 바디 필수.
            res.setStatus(401);
            res.setContentType("application/json;charset=UTF-8");
            res.getWriter().write("{\"ok\":false,\"reason\":\"unauthenticated\"}");
            return null; // null 반환 = 응답을 직접 끝냈다(ResponseBodyEmitter 핸들러 규약).
        }
        res.setHeader("Cache-Control", "no-cache");
        SseEmitter emitter = new SseEmitter(0L); // 타임아웃 없음 — 목록/작성기 동시 2연결을 견딘다.
        subscribers.add(emitter);
        emitter.onCompletion(() -> subscribers.remove(emitter));
        emitter.onTimeout(() -> subscribers.remove(emitter));
        emitter.onError((e) -> subscribers.remove(emitter));
        // ready 즉시 송신 — 핸들러 반환 전 send 는 SseEmitter 가 버퍼링 후 초기화 시 flush 한다.
        emitter.send(SseEmitter.event().name("ready").data(READY_DATA));
        return emitter;
    }

    /** 스파이크 전용 브로드캐스트 트리거 — 실서버의 DB 변경 알림을 손으로 대신한다. */
    @PostMapping("/spike/notify")
    public Map<String, Object> notifyAll_() {
        int delivered = 0;
        for (SseEmitter emitter : subscribers) {
            try {
                emitter.send(SseEmitter.event().name("change").data(CHANGE_DATA));
                delivered++;
            } catch (Exception e) {
                subscribers.remove(emitter); // 끊긴 구독자 정리 — 클라는 자동 재연결(ADR-005 동형).
                try {
                    emitter.completeWithError(e);
                } catch (Exception ignored) {
                    // 이미 완료된 emitter — 무해.
                }
            }
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("delivered", delivered);
        return body;
    }
}
