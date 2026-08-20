package harness.news.web;

import harness.news.config.AppProperties;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * CORS(응답 판독)와 CSRF 가드(쓰기 실행)가 <b>공유하는</b> 허용 출처 목록 — 단일 출처다
 * (server/index.js {@code allowedOrigins}, ADR-009).
 *
 * <p>두 경계가 각자 목록을 들면 한쪽만 넓어졌을 때 조용히 뚫린다. 그래서 목록은 여기 하나뿐이고,
 * 환경 분기도 여기서 한 번만 한다:
 * <ul>
 *   <li><b>비프로덕션</b>: dev 배선 기본값 2개({@code http://localhost:5173}·{@code http://127.0.0.1:5173})
 *       + 설정값({@code ALLOWED_ORIGINS}).</li>
 *   <li><b>프로덕션</b>: 설정값만. 기본값을 남기면 피해자 PC에서 열린 임의의 로컬 페이지가 운영 API를
 *       피해자 세션으로 호출·판독할 수 있다 — 프로덕션 쿠키는 {@code SameSite=None; Secure}라 cross-site
 *       요청에도 붙고 Origin 위조도 필요 없다(브라우저가 진짜로 그 값을 보낸다).</li>
 * </ul>
 *
 * <p>대조는 <b>정확 문자열 일치</b>다 — Node도 Origin 헤더 원문을 그대로 대조하고 대소문자·후행 슬래시를
 * 정규화하지 않는다(정규화는 Referer 파싱 경로에만 있다 — {@link Origins}).
 */
public final class AllowedOrigins {

	/** 비프로덕션 기본값 — 오늘의 dev 배선(Vite :5173)이다. */
	private static final List<String> NON_PRODUCTION_DEFAULTS =
			List.of("http://localhost:5173", "http://127.0.0.1:5173");

	private final Set<String> values;

	private final List<String> ordered;

	private final boolean production;

	AllowedOrigins(boolean production, List<String> configured) {
		Set<String> merged = new LinkedHashSet<>();
		if (!production) {
			merged.addAll(NON_PRODUCTION_DEFAULTS);
		}
		merged.addAll(configured == null ? List.of() : configured);
		this.values = Set.copyOf(merged);
		this.ordered = List.copyOf(merged);
		this.production = production;
	}

	/** 설정에서 만든다 — 환경 판정은 {@link AppProperties#production()} 한 곳이 정본이다. */
	public static AllowedOrigins of(AppProperties properties) {
		return new AllowedOrigins(properties.production(), new ArrayList<>(properties.allowedOrigins()));
	}

	/** 허용 목록에 있는가(정확 일치). */
	public boolean allows(String origin) {
		return origin != null && !origin.isEmpty() && this.values.contains(origin);
	}

	/** 적용 중인 목록(선언 순서 유지) — 진단·테스트용이다. */
	public List<String> values() {
		return this.ordered;
	}

	/** 프로덕션 분기 여부(loopback 관용을 끄는 조건). */
	public boolean production() {
		return this.production;
	}
}
