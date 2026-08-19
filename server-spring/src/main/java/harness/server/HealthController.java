package harness.server;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/health — 공개 헬스체크(Electron 클라 프로브·계약 하네스 기동 대기용).
 *
 * <p>정확 1키 {@code {"ok":true}} 를 application/json 으로 반환한다. httpModel 은 상태코드가 아니라
 * JSON 본문만 읽으므로 이 서버의 모든 응답은 JSON 바디 필수라는 원칙을 이 라우트부터 잠근다.
 */
@RestController
public class HealthController {

    @GetMapping("/api/health")
    public Map<String, Object> health() {
        return Map.of("ok", true);
    }
}
