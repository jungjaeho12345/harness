package harness.news.service;

import harness.news.model.ReceiverConfigRepository;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * 수집 수신 설정 서비스 — 리포 루트 {@code src/services/receiverConfigService.js}와 1:1(조회·생성·삭제).
 * HTTP 비의존(ADR-006) — 서블릿 타입을 import하지 않는다.
 *
 * <h2>CRITICAL — 모든 op는 Z(관리자) 전용이고 acting role은 검증된 세션에서만 도출한다(ADR-004)</h2>
 * 각 op는 {@link Authorization#authorize(String, String)}에 세션 토큰만 넘긴다 —
 * {@code Authorization}은 role을 파라미터로 받지 않고 {@link SessionGuard}가 매 호출 User 행을 다시 읽어
 * 만든 신원의 role만 본다. 그래서 요청 본문·헤더의 {@code role}은 판정에 닿을 수 없고, 강등·비활성이
 * 재로그인 없이 다음 요청부터 반영된다. 거부 사유(미인증 {@code unauthenticated} · 비-Z {@code forbidden})는
 * 결과 맵의 {@code reason}으로 나가고 상태코드 매핑은 web 계층({@code ReasonStatus})의 몫이다.
 *
 * <h2>응답 투영은 allowlist(담기 방식)다</h2>
 * 조회는 모델의 전체 행(시크릿 포함)을 {@link #SAFE_FIELDS} 10키로만 투영한다 — {@code password}·
 * {@code apiKey}는 쓰기 전용 시크릿이라 어떤 응답 경로에도 없다. <b>빼기 방식(전체 − 시크릿)으로 만들지
 * 않는다</b>: 새 시크릿 컬럼이 추가되는 순간 조용히 노출되기 때문이다(안전 기본값 · UsersController
 * PUBLIC_FIELDS 선례). 미지정 컬럼도 키를 남기고 값은 {@code null}이다.
 *
 * <h2>create는 입력을 검증하지 않고 {@code createdAt}을 stamp하지 않는다(현행 계약 재현)</h2>
 * Node {@code create}는 요청 body를 그대로 모델에 넣는다 — type/sourceId를 검증하지 않고(게이트 통과 시
 * 항상 성공) {@code createdAt}도 채우지 않는다(입력에 없으면 저장 후 {@code null} · 계약 {@code createdAtNull}).
 * 여기서 4xx나 stamp를 더하면 계약이 red가 된다(decisions (6) · forward_notes (6)).
 */
@Service
public class ReceiverConfigService {

	/**
	 * 조회 응답에 노출 가능한 컬럼 — Node {@code SAFE_FIELDS}(10키, {@code username}이 마지막). {@code password}·
	 * {@code apiKey}는 의도적으로 제외한다(시크릿은 쓰기 전용, ADR-004). {@code username}은 host/port/apiEndpoint와
	 * 함께 "어디에 무엇으로 붙는지"를 보여주는 식별자라 노출을 유지한다(비밀번호 없이는 인증 불가).
	 */
	static final List<String> SAFE_FIELDS = List.of(
			"id", "sourceId", "type", "name", "host", "port", "apiEndpoint", "active", "createdAt", "username");

	private final ReceiverConfigRepository configs;

	private final Authorization authorization;

	public ReceiverConfigService(ReceiverConfigRepository configs, Authorization authorization) {
		this.configs = configs;
		this.authorization = authorization;
	}

	/**
	 * 조회 — Z면 모델 전건을 SAFE_FIELDS 10키로 투영한 {@code items}. 필터는 모델로 그대로 넘긴다
	 * (화이트리스트 컬럼 AND 동등 · {@code password}·{@code apiKey}를 포함하는 것은 Node 동형 결함 후보 #3).
	 */
	public Map<String, Object> query(String sessionToken, Map<String, ?> filters) {
		Authorization.Decision gate = this.authorization.authorize(sessionToken, Authorization.MANAGE_RECEIVER_CONFIG);
		if (!gate.ok()) {
			return fail(gate.reason());
		}
		List<Map<String, Object>> items = new ArrayList<>();
		for (Map<String, Object> row : this.configs.query(filters)) {
			items.add(sanitize(row));
		}
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", true);
		out.put("items", items);
		return out;
	}

	/**
	 * 생성 — Z면 요청 entry를 그대로 모델에 넣고 {@code {ok:true, id:<정수>}}. 입력 검증 없음 · 시크릿
	 * 미반향(응답은 정확 2키) · {@code createdAt} 미stamp.
	 */
	public Map<String, Object> create(String sessionToken, Map<String, ?> entry) {
		Authorization.Decision gate = this.authorization.authorize(sessionToken, Authorization.MANAGE_RECEIVER_CONFIG);
		if (!gate.ok()) {
			return fail(gate.reason());
		}
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", true);
		out.put("id", this.configs.insert(entry));
		return out;
	}

	/**
	 * 삭제 — Z면 모델 remove에 위임한 {@code {ok:true, changes:<정수>}}. 없는 id·NaN → {@code changes:0}.
	 * 이 서버 유일의 행 삭제 라우트이며 설정 행만 지운다(수집 기사 불변 · decisions (1)).
	 */
	public Map<String, Object> remove(String sessionToken, double id) {
		Authorization.Decision gate = this.authorization.authorize(sessionToken, Authorization.MANAGE_RECEIVER_CONFIG);
		if (!gate.ok()) {
			return fail(gate.reason());
		}
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", true);
		out.put("changes", this.configs.remove(id));
		return out;
	}

	/**
	 * DB 행 → SAFE_FIELDS 투영. Node {@code sanitize}와 동형: 행에 있는 SAFE_FIELDS 키만 담되, 모델이 요구
	 * 스키마 전 컬럼을 항상 싣으므로 결과는 10키가 모두 있고 값이 SQL NULL이면 {@code null}이다.
	 */
	private static Map<String, Object> sanitize(Map<String, Object> row) {
		Map<String, Object> out = new LinkedHashMap<>();
		for (String field : SAFE_FIELDS) {
			if (row.containsKey(field)) {
				out.put(field, row.get(field));
			}
		}
		return out;
	}

	private static Map<String, Object> fail(String reason) {
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", false);
		out.put("reason", reason);
		return out;
	}
}
