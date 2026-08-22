package harness.news.service;

import harness.news.model.ArticleHistoryRepository;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * 이력 원장에 한 행을 남기는 <b>부가 기록</b> 헬퍼 — 리포 루트 {@code src/services/articleService.js}의
 * {@code record}/{@code notifyHistoryError} 두 함수와 1:1이다. HTTP 비의존이며(ADR-006) 서블릿 타입을
 * 알지 못한다.
 *
 * <h2>한 곳에 둔다</h2>
 * 편집({@code edit})·전이({@code status})·파생 기록이 <b>같은 규칙</b>으로 남아야 한다:
 * {@code createdAt} stamp, 스냅샷 제목 파생, 실패 격리. 호출 지점마다 다시 쓰면 그중 하나가 조용히
 * 어긋나고, 이력 행은 감사 기록만이 아니라 <b>판정 입력</b>이라(버전 승계·사이클 경계) 그 어긋남이
 * 표시와 판정을 함께 틀리게 만든다.
 *
 * <h2>실패는 삼키되 반드시 남긴다</h2>
 * 이 기록은 본 기능(편집·전이)이 <b>이미 커밋된 뒤</b>에 일어난다. 여기서 예외를 던지면 되돌릴 수 없는
 * 상태에서 호출자가 깨지므로 삽입 실패는 격리한다. 그렇다고 무음으로 사라지게 두지 않는다 — 실패는
 * {@link HistoryErrorListener}로 통지되고 기본 구현({@link HistoryErrorLogger})이 경고 한 줄을 남긴다.
 * <b>통지 자체의 실패도</b> 본 기능을 막지 않는다.
 *
 * <h2>통지에는 본문·토큰이 없다</h2>
 * 페이로드는 식별자 3개와 사유 하나뿐이다({@link HistoryError}). 본문 스냅샷·세션 토큰·비밀번호는
 * 담지 않는다(LOGS.md 마스킹 규율) — 로그 버퍼는 {@code GET /api/logs/digest}로 <b>밖으로 나간다</b>.
 * 사유는 원인 예외의 메시지인데, 이 경로가 던지는 예외(바인딩 정책 위반)는 메시지에 값을 담지 않는다
 * (그것이 {@code ColumnValues}의 계약이다).
 */
@Component
public class ArticleHistoryRecorder {

	private static final String ARTICLE_ID = "articleId";

	private static final String EVENT_TYPE = "eventType";

	private static final String ACTION = "action";

	private static final String MARKUP_VERSION = "markupVersion";

	private static final String SNAPSHOT_TITLE = "snapshotTitle";

	private static final String CREATED_AT = "createdAt";

	private final ArticleHistoryRepository history;

	private final Clock clock;

	private final HistoryErrorListener listener;

	public ArticleHistoryRecorder(ArticleHistoryRepository history, Clock clock, HistoryErrorListener listener) {
		this.history = history;
		this.clock = clock;
		this.listener = listener;
	}

	/**
	 * 이력 1행을 남긴다. 호출자가 주는 것은 이벤트의 내용({@code articleId}·{@code eventType}·
	 * {@code actorUserId}·전이 컬럼·본문 스냅샷)이고, 이 메서드가 더하는 것은 <b>시각과 표시 제목</b>이다.
	 *
	 * <p>본문이 <b>비어 있지 않은 문자열</b>일 때만 표시 제목을 파생해 함께 저장한다. 파생 결과가
	 * {@code ''}여도 <b>그대로 저장한다</b> — NULL로 바꾸면(예: {@code isEmpty() ? null : title}) 그 행이
	 * 영구 레거시로 오판되어 이력보기마다 본문을 다시 읽는다("스냅샷 없음"과 "제목이 빈 스냅샷"은 다르다).
	 * 스냅샷이 없는 행(상태 전이 등)은 제목 컬럼을 아예 싣지 않는다(NULL 유지).
	 *
	 * <p>이 게이트는 DB의 {@code hasSnapshot} 술어보다 <b>좁다</b>(조건부 동형): 비문자열 본문(예: JSON
	 * 숫자)은 TEXT affinity로 저장돼 {@code hasSnapshot=1}인데 제목 컬럼은 NULL이라 그 행만 조회 폴백을
	 * 탄다 — 표시는 정확하고 성능만 현행 유지라 수용한다(정상 클라이언트는 문자열만 보낸다).
	 *
	 * <p><b>예외를 던지지 않는다</b>(호출자를 깨뜨리지 않는다). {@code Error}는 삼키지 않는다 — 기록
	 * 실패와 JVM 이상을 같이 묻으면 진단이 무너진다.
	 */
	public void record(Map<String, ?> entry) {
		try {
			Map<String, Object> row = new LinkedHashMap<>();
			if (entry != null) {
				row.putAll(entry);
			}
			row.put(CREATED_AT, Iso8601.now(this.clock));
			// 파생도 이 try 안에서 한다 — 실패해도 본 기능을 깨뜨리지 않고 통지로 표면화된다.
			if (row.get(MARKUP_VERSION) instanceof String body && !body.isEmpty()) {
				row.put(SNAPSHOT_TITLE, HistoryMeta.snapshotTitle(body));
			}
			this.history.insert(row);
		}
		catch (RuntimeException ex) {
			notifyError(entry, ex);
		}
	}

	/** 통지 seam 호출 — 통지가 던져도 본 기능은 계속된다(그 자리에서 던지면 격리의 의미가 없다). */
	private void notifyError(Map<String, ?> entry, RuntimeException cause) {
		try {
			this.listener.onHistoryError(new HistoryError(text(entry, ARTICLE_ID), text(entry, EVENT_TYPE),
					text(entry, ACTION), reasonOf(cause)));
		}
		catch (RuntimeException ignored) {
			// 통지 실패는 본 기능을 막지 않는다 — 이미 커밋된 편집·전이를 되돌릴 수 없다.
		}
	}

	private static String text(Map<String, ?> entry, String key) {
		Object value = (entry == null) ? null : entry.get(key);
		return (value == null) ? null : String.valueOf(value);
	}

	/** 메시지가 없는 예외는 타입 이름으로 남긴다(값을 담지 않는다 — 마스킹 규율). */
	private static String reasonOf(RuntimeException cause) {
		String message = cause.getMessage();
		return (message == null) ? cause.getClass().getName() : message;
	}

	/**
	 * 이력 기록 실패 통지 — <b>식별자 3개와 사유 하나뿐</b>이다. 본문 스냅샷·세션 토큰·비밀번호를
	 * 담지 않는다(LOGS.md 마스킹 규율).
	 */
	public record HistoryError(String articleId, String eventType, String action, String reason) {
	}

	/**
	 * 실패 통지 seam — Node의 {@code onHistoryError} 콜백과 같은 자리다. 기본 구현은
	 * {@link HistoryErrorLogger}이고, 테스트는 캡처 구현을 물려 페이로드를 관측한다.
	 */
	@FunctionalInterface
	public interface HistoryErrorListener {

		void onHistoryError(HistoryError error);

	}

}
