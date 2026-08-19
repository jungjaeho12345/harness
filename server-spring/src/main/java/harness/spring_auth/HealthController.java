package harness.spring_auth;

import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 공개 health 엔드포인트. 인증 불필요, DB 접근 없음. 200 {ok:true}.
 * content-type을 Node와 바이트 동일(application/json; charset=utf-8)하게 맞추려 JsonHttp로 응답한다.
 */
@RestController
public class HealthController {

	@GetMapping("/api/health")
	public void health(HttpServletResponse res) throws IOException {
		JsonHttp.write(res, 200, Map.of("ok", true));
	}

}
