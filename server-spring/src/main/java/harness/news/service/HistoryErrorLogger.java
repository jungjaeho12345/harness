package harness.news.service;

import org.springframework.stereotype.Component;

/**
 * 이력 기록 실패의 <b>기본 통지 대상</b> — 경고 한 줄을 로그 링 버퍼에 남긴다.
 *
 * <p>Node는 콜백이 주입되지 않으면 실패를 <b>조용히</b> 삼킨다. 여기서는 삼키되 <b>반드시 남긴다</b>:
 * 이력 행은 감사 기록만이 아니라 판정 입력이라(버전 승계·사이클 경계) 무음으로 사라지면 조용한
 * 오표시·오판정이 된다. 관측 가능한 표면(응답 shape·DB 행)은 그대로이므로 계약은 흔들리지 않는다.
 *
 * <p><b>줄에 담는 것은 식별자와 사유뿐이다.</b> 이 버퍼는 {@code GET /api/logs/digest}로 밖으로 나간다 —
 * 여기 들어간 본문 한 조각은 곧 응답이다(LOGS.md · ADR-007).
 */
@Component
public class HistoryErrorLogger implements ArticleHistoryRecorder.HistoryErrorListener {

	private final LogService logs;

	public HistoryErrorLogger(LogService logs) {
		this.logs = logs;
	}

	@Override
	public void onHistoryError(ArticleHistoryRecorder.HistoryError error) {
		this.logs.warn("이력 기록 실패 articleId=" + error.articleId() + " eventType=" + error.eventType()
				+ " action=" + error.action() + " reason=" + error.reason());
	}

}
