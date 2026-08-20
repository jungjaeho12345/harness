package harness.news.service;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 로그 한 줄 — 리포 루트 {@code src/services/logService.js}가 만드는 record와 1:1이다.
 *
 * <p><b>키 5개가 계약이다</b>({@code docs/api-contract/openapi.yaml} {@code LogRecord}:
 * {@code seq·ts·level·message·line}). 이 타입은 {@code GET /api/logs/digest}의 {@code items} 원소이고
 * (그리고 후속 phase의 로그 SSE 프레임 payload가 된다), 키를 빼거나 더하면 그 자리에서 계약 위반이다.
 *
 * <p>직렬화는 {@link #asMap()}을 <b>거쳐서만</b> 한다 — 이 타입을 Jackson에 그대로 넘기지 않는다.
 * step2 실측: Jackson 3은 record의 접근자를 전부 속성으로 보고 애노테이션으로 막기 어렵다.
 * 응답 조립을 명시 맵 한 곳으로 모으면 키 이름·순서·null 처리가 코드에 그대로 보인다
 * (index.json decisions (13) · step3의 {@code Identity.asMap()}과 같은 규율 — {@code non_null} 같은
 * 전역 포함 규칙을 걸지 않는다).
 *
 * @param seq 프로세스 수명 동안 단조 증가(evict돼도 재사용하지 않는다)
 * @param ts epoch ms — 주입 시계에서 읽은 값이다
 * @param level 4종 중 하나
 * @param message 마스킹된 메시지(비밀번호·세션 토큰·쿠키/Authorization 값·본문·쿼리스트링 금지)
 * @param line {@code [YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지} — 벽시계는 주입 오프셋 기준이다
 */
public record LogRecord(long seq, long ts, LogRecord.Level level, String message, String line) {

	/** log4j 스타일 서열(낮음→높음) — Node {@code LOG_LEVELS}와 같은 4종이다. */
	public enum Level {

		DEBUG, INFO, WARN, ERROR

	}

	/**
	 * 응답 조립용 순서 있는 맵 — 키 5개가 <b>항상</b> 있고 순서는 Node record의 속성 순서와 같다.
	 * {@code level}은 enum 이름 문자열로 나간다(openapi enum 4종).
	 */
	public Map<String, Object> asMap() {
		Map<String, Object> map = new LinkedHashMap<>();
		map.put("seq", this.seq);
		map.put("ts", this.ts);
		map.put("level", this.level.name());
		map.put("message", this.message);
		map.put("line", this.line);
		return map;
	}
}
