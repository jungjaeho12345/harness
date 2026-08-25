package harness.news.service;

import harness.news.model.ReceiverConfigRepository;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * 수집(자동기사) 서비스 — 리포 루트 {@code src/services/collectionService.js}와 1:1이다. 수신 → 분석 →
 * 등록 파이프라인이며 HTTP·FTP에 의존하지 않는다(ADR-006).
 *
 * <h2>이 서비스는 세션을 모른다</h2>
 * 수집 2 라우트는 <b>사용자 세션 라우트가 아니다</b>({@code AuthClass.TOKEN}). 방어는 바인딩(fail-closed)과
 * {@code x-collection-token}뿐이고 그 둘은 web 계층 소유다 — 여기에 세션·role·{@code Authorization}을
 * 끌어들이면 계약의 200 경로가 401이 된다. 서블릿 타입도 import하지 않는다.
 *
 * <h2>판정 순서가 계약이다</h2>
 * {@link #receive}는 등록({@code unregistered}) → 활성({@code inactive}) → 파싱 → 등록이고,
 * {@link #pull}은 등록 → 활성 API 소스 선택({@code no-active-api-source}) → <b>1회</b> 외부 호출
 * ({@code fetch-failed}) → <b>{@link #receive} 재사용</b>이다. 재사용이라서 외부 호출이 도는 동안 설정이
 * 비활성으로 바뀌면 등록이 거부된다 — Node가 그렇게 동작하므로 그대로 둔다.
 *
 * <h2>거부는 예외가 아니라 사유 토큰이다</h2>
 * 실패를 던지면 400/403이 500이 된다(graceful 거부 — news.md). {@code unregistered}·{@code inactive}는
 * 전역 표({@code ReasonStatus})가 403으로 매핑하고, <b>{@code no-active-api-source}·{@code fetch-failed}는
 * 표에 없어 폴백 400</b>이다 — 계약이 그 400을 동결했으므로 표에 추가하지 마라.
 *
 * <h2>검증이 없다</h2>
 * payload를 검증하지 않는다: 없어도 200이고 빈 제목·빈 본문의 기사가 등록된다
 * ({@code receive-missing-payload}). 재시도·백오프·큐도 없다(ADR-008 (6)).
 *
 * <h2>빈 등록은 step5(HTTP 경계)가 함께 올린다</h2>
 * step3에서는 {@code ApiSourceFetcher} 구현 빈이 아직 없어 {@code @Service}를 붙이면 전
 * {@code @SpringBootTest} 컨텍스트가 로딩에서 죽었다. step4가 {@link HttpApiSourceFetcher}를 올리고
 * step5가 {@link harness.news.controller.CollectionController}를 붙이면서 이 배선이 완결된다.
 */
@Service
public class CollectionService {

	/** rcv.md 규칙 — 수집 기사는 반드시 {@code Contents.attribute}에 이 값을 갖는다. */
	private static final String AUTO_ATTRIBUTE = "자동기사";

	/** 등록 여부 판정에 쓰는 유일한 필터 키. */
	private static final String SOURCE_ID = "sourceId";

	/** pull 대상 소스의 종류 — <b>엄격 비교</b>다(소문자 {@code 'api'}는 대상이 아니다). */
	private static final String API_TYPE = "API";

	/** 비활성 표식. {@code active}가 NULL이면 {@code 'Y'}로 보므로 이 값만 수신을 막는다. */
	private static final String INACTIVE = "N";

	/**
	 * 응답 본문 판독 전용 매퍼.
	 *
	 * <p>{@link MarkupJson}을 재사용하지 않는 이유는 폴백의 모양이 다르기 때문이다: 그쪽은 실패도
	 * {@code null} 리터럴도 {@code null}로 접지만, 여기서는 <b>실패면 평문 문자열 그대로</b>이고
	 * {@code "null"} 본문은 {@code null} 값이다(Node {@code JSON.parse}의 try/catch 동형). 합치면
	 * {@code "hello"} 같은 평문이 빈 payload로 둔갑한다.
	 */
	private static final ObjectMapper MAPPER = JsonMapper.builder().build();

	private final ReceiverConfigRepository configs;

	private final ArticleWriteService articles;

	private final ApiSourceFetcher fetcher;

	public CollectionService(ReceiverConfigRepository configs, ArticleWriteService articles,
			ApiSourceFetcher fetcher) {
		this.configs = configs;
		this.articles = articles;
		this.fetcher = fetcher;
	}

	/**
	 * 수집 결과 — Node의 {@code {ok, ...}} 결과 객체와 동형이다. 성공이면 발급된 {@code articleId}만,
	 * 실패면 사유 토큰만 채워진다(상태코드 매핑은 web 계층의 몫이다).
	 */
	public record Result(boolean ok, String articleId, String reason) {

		static Result deny(String reason) {
			return new Result(false, null, reason);
		}

		static Result created(String articleId) {
			return new Result(true, articleId, null);
		}
	}

	/**
	 * 수신 인제스트 — 등록·활성 {@code sourceId}만 받아 파싱 후 기사로 등록한다.
	 *
	 * <p>{@code sourceId}는 클라이언트 입력이라 문자열이 아닐 수 있다. 리포지토리의 값 바인딩 정책
	 * ({@code ColumnValues}) 단일 출처를 그대로 태운다 — 불리언·객체는 예외가 되어 전역 핸들러가 500을
	 * 만든다(Node {@code node:sqlite}의 TypeError와 동형). 조용히 문자열화하지 마라.
	 *
	 * <p>{@code sourceId}가 없으면(=null) 필터가 통째로 빠져 <b>등록된 전 행</b>이 매치된다 — Node 모델이
	 * {@code undefined}·{@code null} 필터를 건너뛰기 때문이다. 여기에 null 거부를 더하면 두 서버가 갈린다.
	 *
	 * <p>기사에 {@code sourceId}·수집 시각을 저장하지 않는다({@code Contents}에 그런 컬럼이 없다 —
	 * DDL 0).
	 */
	public Result receive(Object sourceId, Object payload) {
		List<Map<String, Object>> found = this.configs.query(Collections.singletonMap(SOURCE_ID, sourceId));
		if (found == null || found.isEmpty()) {
			return Result.deny("unregistered");
		}
		if (!hasActive(found)) {
			return Result.deny("inactive");
		}

		CollectionParser.Parsed parsed = CollectionParser.parse(payload);

		// 등록은 ArticleWriteService.create 재사용 — role·action이 없어 status는 RDS이고 이력은 남지 않는다.
		Map<String, Object> dto = new LinkedHashMap<>();
		dto.put("title", parsed.title());
		dto.put("markupVersion", CollectionMarkup.toMarkup(parsed.title(), parsed.content()));
		dto.put("attribute", AUTO_ATTRIBUTE);
		return Result.created(this.articles.create(dto, null, null));
	}

	/**
	 * 능동 수집(pull) — 등록된 활성 API 소스({@code apiEndpoint})를 <b>한 번</b> 호출해 응답을 분석·등록한다
	 * (rcv.md "API 호출 후 응답 분석").
	 *
	 * <p>어댑터가 실패를 알리든 예외를 던지든 {@code fetch-failed} 하나로 수렴한다 — 예외가 새면 계약의
	 * 400이 500이 된다. 분석·등록은 {@link #receive} 재사용이다.
	 */
	public Result pull(Object sourceId) {
		List<Map<String, Object>> found = this.configs.query(Collections.singletonMap(SOURCE_ID, sourceId));
		if (found == null || found.isEmpty()) {
			return Result.deny("unregistered");
		}
		Map<String, Object> source = firstActiveApiSource(found);
		if (source == null) {
			return Result.deny("no-active-api-source");
		}

		Object payload;
		try {
			Object apiKey = source.get("apiKey");
			ApiSourceFetcher.FetchResult response = this.fetcher.fetch(text(source.get("apiEndpoint")),
					truthy(apiKey) ? text(apiKey) : null);
			if (response == null || !response.ok()) {
				return Result.deny("fetch-failed");
			}
			payload = decodeBody(response.body());
		}
		catch (RuntimeException ex) {
			// 연결 거부·잘못된 URL 등 — 재시도하지 않고 사유를 돌려준다(ADR-008 (6)).
			return Result.deny("fetch-failed");
		}
		return receive(sourceId, payload);
	}

	/** {@code configs.some((c) => (c.active ?? 'Y') !== 'N')} — 하나라도 활성이면 수신한다. */
	private static boolean hasActive(List<Map<String, Object>> rows) {
		for (Map<String, Object> row : rows) {
			if (isActive(row)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * {@code (active ?? 'Y') !== 'N'} — <b>NULL·미설정은 활성</b>이고 정확히 {@code 'N'}만 비활성이다.
	 * 소문자 {@code 'n'}·빈 문자열도 활성이다(Node 그대로 — 관용을 더하지도 빼지도 않는다).
	 *
	 * <p>이 판정을 {@code "Y".equals(active)}로 좁히면 {@code active}를 채우지 않은 <b>기존 수집 소스가
	 * 전부 죽는다</b>(운영 DB의 그 컬럼은 NULL일 수 있다).
	 */
	private static boolean isActive(Map<String, Object> row) {
		Object active = row.get("active");
		Object effective = (active == null) ? "Y" : active;
		return !INACTIVE.equals(effective);
	}

	/** {@code find((c) => 활성 && c.type === 'API' && c.apiEndpoint)} — 없으면 {@code null}. */
	private static Map<String, Object> firstActiveApiSource(List<Map<String, Object>> rows) {
		for (Map<String, Object> row : rows) {
			if (isActive(row) && API_TYPE.equals(row.get("type")) && truthy(row.get("apiEndpoint"))) {
				return row;
			}
		}
		return null;
	}

	/**
	 * 응답 텍스트를 파서가 처리할 값으로 만든다 — JSON이면 그 값(객체·배열·스칼라 무엇이든), 아니면
	 * <b>평문 그대로</b>다(파서가 양쪽을 처리한다).
	 *
	 * <p>{@code null} 본문은 그대로 넘긴다: Node도 {@code typeof text !== 'string'}이면 판독하지 않는다.
	 */
	private static Object decodeBody(String text) {
		if (text == null) {
			return null;
		}
		try {
			return MAPPER.readValue(text, Object.class);
		}
		catch (RuntimeException ex) {
			return text; // 평문 응답 — 첫 줄이 제목이 된다.
		}
	}

	/** JS truthy 중 이 경로에 오는 것만: {@code null}·빈 문자열이 falsy다(DB 컬럼은 TEXT 또는 NULL이다). */
	private static boolean truthy(Object value) {
		return value != null && !text(value).isEmpty();
	}

	private static String text(Object value) {
		return (value == null) ? null : value.toString();
	}

}
