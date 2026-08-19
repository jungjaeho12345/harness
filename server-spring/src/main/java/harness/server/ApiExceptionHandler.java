package harness.server;

import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * 전역 에러 핸들러 — 미처리 예외를 500 {@code {ok:false,reason:'internal-error'}} 로 매핑한다
 * (server/index.js 전역 핸들러·reason-tokens.md 표2 #15 동형: 본문 파서 오류·중복 키 등 모든 미처리 예외).
 *
 * <p><b>스택 트레이스·예외 메시지·내부 경로를 응답에 싣지 않는다</b>(정보 누출 금지 — LOGS.md 규율).
 * 고정 토큰만 반환한다.
 */
@RestControllerAdvice
public class ApiExceptionHandler {

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleAny(Exception e) {
        return Responses.reject("internal-error"); // 500, 원문 미노출.
    }
}
