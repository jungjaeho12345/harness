package harness.news.service;

import harness.news.model.ArticleRepository;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * 기사 <b>쓰기</b> 서비스 — 리포 루트 {@code src/services/articleService.js}의 {@code create}·
 * {@code update}와 1:1 이식이다. HTTP 비의존이며(ADR-006) 서블릿 타입을 알지 못한다: 세션도 요청 객체도
 * 읽지 않고, <b>신원과 의도는 인자로만</b> 받는다. 신뢰 경계 stamp(클라 {@code role} 제거 · 빈 부서 →
 * 세션 부서 · 빈 작성자 → 세션 사용자 · {@code modifier} = 세션 userId)는 컨트롤러의 몫이다(ADR-004).
 *
 * <h2>화이트리스트 픽이 방어 수단이다</h2>
 * 저장 대상은 두 갈래 목록({@link #ARTICLE_FIELDS}·{@link #CONTENTS_FIELDS})에 있는 키뿐이고, 그 밖의
 * 키는 <b>조용히 빠진다</b>. 그래서 클라이언트가 보낸 {@code status}·{@code sender}·{@code articleId}·
 * {@code distributedAt}·잠금 5컬럼이 저장되지 않는다 — <b>개별 삭제 코드로 막지 않는다</b>. 삭제 목록은
 * 새 필드가 생길 때마다 누락되지만 화이트리스트는 그렇지 않다.
 *
 * <p>{@code content} 컬럼은 어느 쪽 목록에도 없다(두 테이블 모두 NULL로 남는다 — 응답 27키에는 키가
 * 있다). {@code status}는 신규 저장에서 <b>서버가 계산</b>하고 이후에는 전이 라우트만 바꾼다.
 *
 * <h2>두 테이블은 한 트랜잭션이다</h2>
 * 신규 2행 삽입도 부분 수정 2문장도 원자적이다(리포지토리가 보장한다 — decisions (18)). 부분 저장은
 * 본문과 목록행이 갈라진 기사를 만든다. 수정이 돌려주는 {@code changes}는 <b>두 갱신문의 영향 행 수
 * 합</b>이며 그 정수가 계약 리포트의 비교 값이다 — 1/0으로 정규화하지 마라.
 *
 * <h2>이 서비스가 하지 않는 것</h2>
 * <ul>
 *   <li><b>입력 검증</b>(제목 필수 등) — 신규 저장은 <b>항상 성공</b>하는 것이 계약이다.</li>
 *   <li><b>존재 검사·잠금 인가</b> — 호출자(컨트롤러)가 잠금 서비스로 먼저 판정한다. 게이트 순서
 *       (존재 404 → 보유자 403)가 계약이라 그 판단이 여기 있으면 순서를 잃는다.</li>
 *   <li><b>생성 시 이력 기록</b> — 계약이 "갓 만든 기사의 이력은 빈 배열"을 동결했다.</li>
 *   <li><b>상태 전이</b>·<b>SSE 통지</b>·<b>배부 훅</b> — 각각 다른 step·phase의 소유다.</li>
 *   <li><b>응답 shape 조립</b> — {@code {ok:true, …}} 봉투는 HTTP 계층이 만든다(decisions (13)).
 *       두 경로 모두 실패 분기가 없어 {@code ok}는 변수가 아니라 상수다.</li>
 * </ul>
 */
@Service
public class ArticleWriteService {

	/** {@code Article} 테이블에 들어가는 3필드(본문 마크업). {@code articleId}는 서버가 붙인다. */
	private static final List<String> ARTICLE_FIELDS = List.of("title", "markupVersion", "modifier");

	/**
	 * {@code Contents} 테이블에 들어가는 공통정보·메타 16필드. {@code status}·시각·잠금은 목록에 없다 —
	 * 서비스와 전이·잠금 경로가 직접 관리한다(클라이언트가 정할 수 없는 값들이다).
	 */
	private static final List<String> CONTENTS_FIELDS = List.of(
			"title", "author", "modifier", "department", "departmentCode",
			"embargoAt", "secondEmbargoAt",
			"coAuthor", "category", "region", "attribute", "keyword",
			"internalComment", "externalComment", "attachmentFile", "referenceFile");

	/**
	 * 스킴 방어를 거치는 파일 참조 2필드. 규칙의 단일 출처는 {@link FileRef}다(사진DB src와 공유 —
	 * 재현 금지: 발산하면 우회 벡터다).
	 */
	private static final List<String> FILE_REF_FIELDS = List.of("attachmentFile", "referenceFile");

	private static final String ARTICLE_ID = "articleId";

	private static final String MODIFIER = "modifier";

	private static final String MARKUP_VERSION = "markupVersion";

	private static final String EDIT = "edit";

	private final ArticleRepository articles;

	private final ArticleHistoryRecorder recorder;

	private final Clock clock;

	public ArticleWriteService(ArticleRepository articles, ArticleHistoryRecorder recorder, Clock clock) {
		this.articles = articles;
		this.recorder = recorder;
		this.clock = clock;
	}

	/**
	 * 신규 저장 — {@code articleId} 발급 → 두 화이트리스트로 픽 → 초기 {@code status}·{@code createdAt}
	 * stamp → 파일 참조 정화 → <b>한 트랜잭션</b>으로 두 행 삽입.
	 *
	 * <p>{@code role}과 의도 {@code action}은 초기 상태 계산에만 쓰인다(기본 {@code RDS} · D·Z + hold →
	 * {@code DDH} · R + hold → {@code RRH}). 둘 다 없으면 {@code RDS}다. <b>세션에서 읽지 않고 인자로만
	 * 받는다</b> — 서비스가 서블릿에 묶이면 계층이 무너지고 단위 테스트가 컨테이너를 요구하게 된다.
	 *
	 * <p>이력 행을 남기지 않는다(계약). 실패 분기가 없다(항상 성공).
	 *
	 * @return 서버가 발급한 {@code articleId}. 클라이언트가 보낸 값은 언제나 무시된다.
	 */
	public String create(Map<String, ?> dto, String role, String action) {
		String articleId = this.articles.generateArticleId();

		Map<String, Object> article = new LinkedHashMap<>();
		article.put(ARTICLE_ID, articleId);
		article.putAll(pick(dto, ARTICLE_FIELDS));

		Map<String, Object> contents = new LinkedHashMap<>();
		contents.put(ARTICLE_ID, articleId);
		contents.putAll(pick(dto, CONTENTS_FIELDS));
		contents.put("status", Lifecycle.initialStatus(role, action));
		contents.put("createdAt", Iso8601.now(this.clock));
		sanitizeFileRefs(contents);

		this.articles.insert(article, contents);
		return articleId;
	}

	/**
	 * 부분 수정 — 준 필드만 반영하고 {@code editedAt}을 stamp한 뒤, 성공한 편집을 이력에 남긴다.
	 *
	 * <p><b>present-only</b>다: 주지 않은 필드는 문장에 들어가지 않아 기존 값이 보존된다. 파일 참조
	 * 정화도 <b>주어진 것만</b> 한다 — 미전달 필드까지 정화하면 그 순간 값이 {@code null}에서 빈
	 * 문자열로 바뀌어 부분 수정이 남의 필드를 덮는다.
	 *
	 * <p>이력의 actor는 호출자가 stamp한 {@code modifier}(세션 userId)이고, 이 편집에서 저장되는 본문을
	 * <b>스냅샷으로 함께</b> 기록한다(메타 전용 편집이면 본문 없이 남는다). 기록 실패는 편집을 되돌리지
	 * 않는다({@link ArticleHistoryRecorder}).
	 *
	 * <p>존재 검사를 하지 않으므로 없는 기사에는 {@code 0}이 돌아온다 — 404를 만드는 것은 호출자다.
	 *
	 * @return 두 갱신문의 영향 행 수 <b>합</b>(계약 비교 값 — 정규화 금지)
	 */
	public int update(String articleId, Map<String, ?> fields) {
		Map<String, Object> contents = pick(fields, CONTENTS_FIELDS);
		contents.put("editedAt", Iso8601.now(this.clock));
		sanitizeFileRefs(contents);

		int changes = this.articles.update(articleId, pick(fields, ARTICLE_FIELDS), contents);

		// 값이 없는 키도 그대로 실어 보낸다 — 리포지토리가 SQL NULL로 넣으므로 결과 행은 컬럼을 생략한
		// Node와 같다(둘 다 NULL). 본문이 없으면 스냅샷 없는 편집 행이 된다.
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put(ARTICLE_ID, articleId);
		entry.put("eventType", EDIT);
		entry.put("actorUserId", value(fields, MODIFIER));
		entry.put(MARKUP_VERSION, value(fields, MARKUP_VERSION));
		this.recorder.record(entry);

		return changes;
	}

	/** 화이트리스트에 있고 <b>키가 주어진</b> 필드만 고른다(값이 {@code null}이어도 주어진 것이다). */
	private static Map<String, Object> pick(Map<String, ?> source, List<String> fields) {
		Map<String, Object> picked = new LinkedHashMap<>();
		if (source == null) {
			return picked;
		}
		for (String field : fields) {
			if (source.containsKey(field)) {
				picked.put(field, source.get(field));
			}
		}
		return picked;
	}

	/** present인 파일 참조만 정화한다 — 미전달 필드는 추가하지도 바꾸지도 않는다. */
	private static void sanitizeFileRefs(Map<String, Object> contents) {
		for (String field : FILE_REF_FIELDS) {
			if (contents.containsKey(field)) {
				contents.put(field, FileRef.sanitize(contents.get(field)));
			}
		}
	}

	private static Object value(Map<String, ?> source, String key) {
		return (source == null) ? null : source.get(key);
	}

}
