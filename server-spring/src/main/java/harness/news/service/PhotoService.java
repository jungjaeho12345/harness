package harness.news.service;

import harness.news.model.PhotoRepository;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * 사진DB 서비스 — 리포 루트 {@code src/services/photoService.js}와 1:1이다. HTTP 비의존(ADR-006)이며
 * 서블릿 타입을 하나도 알지 못한다.
 *
 * <h2>연산은 둘뿐이다 — 등록(append-only)과 캡션 검색</h2>
 * 이 테이블은 <b>append-only</b>다: 여기에는 행을 고치거나 지우는 연산이 없고 그런 API 자체가 없다
 * (최상위 규칙 — DB에 있는 내용은 절대 지우지 않는다). 그 사실은 {@code NoSchemaSqlInMainSourcesTest}가
 * main 소스 전체에 대해 정적으로도 잠근다.
 *
 * <h2>신원은 마지막 인자로만 들어온다(ADR-004)</h2>
 * {@code registeredBy}는 <b>검증된 세션에서 재도출한 {@code userId}</b>로만 채운다. 그래서 이 서비스는
 * 요청 본문을 맵째로 받지 않는다 — 받는 순간 클라이언트가 보낸 {@code registeredBy}가 흘러들 통로가
 * 생기고, 그 통로는 있기만 해도 위조 경로다(정본 라우트도 본문에서 {@code {src, caption,
 * sourceArticleId}} 셋만 꺼내 넘긴다). 표면 자체를 {@code PhotoServiceTest}가 리플렉션으로 단언한다.
 *
 * <h2>{@code src} 검증은 {@link FileRef} 하나뿐이다</h2>
 * 규칙을 여기서 재구현하거나 넓히지 마라 — 첨부·자료 파일과 사진 {@code src}는 <b>규칙의 단일 출처</b>를
 * 공유한다(한쪽만 넓어지면 발행 HTML에 재임베드되는 참조에서 방어가 갈린다). 정본이
 * {@code String(value)}를 먼저 부르므로 문자열이 아닌 입력도 문자열이 된 뒤 규칙을 탄다 —
 * {@link FileRef#sanitize(Object)}가 이미 그 형태다. 빈 결과는 사유 {@code invalid-src}이고 <b>행이 생기지
 * 않는다</b>(상태코드 400은 라우트가 직접 준다 — 이 사유는 전역 표에 넣지 않는다, decisions (16)).
 *
 * <h2>{@code ?? ''}는 null 병합이다</h2>
 * {@code caption}·{@code sourceArticleId}의 기본값은 <b>값이 없을 때만</b> 적용된다({@code ||}가 아니다).
 * 빈 문자열·{@code 0}·{@code false}는 그대로 리포지토리로 내려가고, 그 뒤의 처분은 바인딩 정책이 정한다
 * (수는 REAL, 불리언은 예외 → 500 — {@code node:sqlite} 동형).
 *
 * <h2>시각은 주입된 {@link Clock}에서만 온다</h2>
 * {@code createdAt}이 이 도메인의 유일한 시각 stamp다(ADR-013 · {@code ClockDisciplineTest}).
 */
@Service
public class PhotoService {

	private static final String INVALID_SRC = "invalid-src";

	private final PhotoRepository photos;

	private final Clock clock;

	public PhotoService(PhotoRepository photos, Clock clock) {
		this.photos = photos;
		this.clock = clock;
	}

	/**
	 * 사진 1건 등록.
	 *
	 * @param src 요청 {@code src}(문자열이 아닐 수 있다 — 판정은 {@link FileRef}가 한다)
	 * @param caption 요청 {@code caption}. 없으면 빈 문자열이다(null 아님)
	 * @param sourceArticleId 요청 {@code sourceArticleId}. 없으면 빈 문자열이다
	 * @param userId <b>검증된 세션에서 도출한</b> 사용자 id. 없으면 SQL NULL로 남는다
	 * @return 성공이면 {@code {ok:true, id}}, 거부면 {@code {ok:false, reason:"invalid-src"}} —
	 * <b>키 순서</b>가 Node 응답과 같다
	 */
	public Map<String, Object> register(Object src, Object caption, Object sourceArticleId, String userId) {
		String reference = FileRef.sanitize((src == null) ? "" : src);
		if (reference.isEmpty()) {
			Map<String, Object> rejected = new LinkedHashMap<>();
			rejected.put("ok", false);
			rejected.put("reason", INVALID_SRC);
			return rejected;
		}

		Map<String, Object> photo = new LinkedHashMap<>();
		photo.put("src", reference);
		photo.put("caption", (caption == null) ? "" : caption);
		photo.put("sourceArticleId", (sourceArticleId == null) ? "" : sourceArticleId);
		// 신원은 인자에서만 온다 — 위 세 값 중 어느 것도 이 자리에 올 수 없다(ADR-004).
		photo.put("registeredBy", userId);
		photo.put("createdAt", Iso8601.now(this.clock));

		Map<String, Object> accepted = new LinkedHashMap<>();
		accepted.put("ok", true);
		accepted.put("id", this.photos.insert(photo));
		return accepted;
	}

	/**
	 * 캡션 부분일치 검색 — 얇은 위임이다(도메인 규칙 없음). 행은 스키마 순서의 6컬럼 그대로 나간다.
	 *
	 * @param q 질의. 라우트의 {@code req.query.q ?? ''} 뒤의 값이라 {@code null}(생략)은 빈 문자열과 같고,
	 * <b>키가 반복되면 리스트</b>다 — {@link NodeString#queryText(Object)}가 Node {@code String(...)}
	 * 의미론으로 접는다({@code LIKE '%a,b%'}). 첫 값만 취하면({@code getParameter}의 기본 동작) 같은 질의에
	 * 두 서버가 다른 행 집합을 준다 — 계약이 관측하지 않는 축이라 {@code PhotoServiceTest}가 방어선이다
	 */
	public List<Map<String, Object>> search(Object q) {
		return this.photos.searchByCaption(NodeString.queryText(q));
	}

}
