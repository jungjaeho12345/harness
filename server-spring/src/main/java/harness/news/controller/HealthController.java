package harness.news.controller;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 헬스체크 — 인증 불요, 항상 200 {@code {"ok":true}}.
 *
 * <p>본문 shape이 계약이다: 계약 러너와 Electron 셸 프로브가 상태코드가 아니라 본문까지 판정한다
 * (docs/api-contract/endpoints.json `health`). 키를 추가하는 것도 계약 위반이라 응답을 단일 키로 고정한다.
 */
@RestController
public class HealthController {

	@GetMapping("/api/health")
	public Map<String, Boolean> health() {
		return Map.of("ok", true);
	}
}
