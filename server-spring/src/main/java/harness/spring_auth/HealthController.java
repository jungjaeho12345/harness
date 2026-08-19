package harness.spring_auth;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 공개 health 엔드포인트. 인증 불필요, DB 접근 없음.
 */
@RestController
public class HealthController {

	@GetMapping("/api/health")
	public Map<String, Object> health() {
		return Map.of("ok", true);
	}

}
