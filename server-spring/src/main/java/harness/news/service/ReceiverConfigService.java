package harness.news.service;

import harness.news.model.ReceiverConfigRepository;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * 수집(자동기사) 수신 설정 서비스 — 리포 루트 {@code src/services/receiverConfigService.js}와 1:1이다.
 * HTTP 비의존(ADR-006)이며 사유 토큰만 돌려준다(상태코드 매핑은 web 계층 {@code ReasonStatus}의 몫이다).
 *
 * <h2>CRITICAL — 3 op 전부 Z 전용(ADR-004)</h2>
 * 조회·생성·삭제 모두 {@link Authorization#MANAGE_RECEIVER_CONFIG} 게이트를 통과해야 한다. acting role은
 * <b>검증된 세션에서만</b> 도출한다 — 이 서비스는 세션 토큰만 받고 role을 파라미터로 받지 않는다. 게이트가
 * 거부하면 <b>리포지토리를 부르지 않는다</b>(거부된 요청이 행을 만들거나 지우지 못한다 — 계약이 실측).
 *
 * <h2>응답 투영은 allowlist다(블랙리스트 금지)</h2>
 * 조회 응답은 {@link #SAFE_FIELDS} <b>10키</b>만 싣는다. {@code password}(FTP)·{@code apiKey}(API)는
 * <b>쓰기 전용 시크릿</b>이라 어떤 응답에도 없다. '전체에서 시크릿을 빼는' 방식이 아니라 '담을 것만
 * 나열'하는 allowlist다 — 새 시크릿 컬럼이 스키마에 추가돼도 자동으로 비노출된다(안전 기본값). 목록
 * 원소는 항상 정확 10키이고 값이 SQL NULL이어도 키는 남긴다({@code createdAt}은 서버가 채우지 않으면 null).
 *
 * <h2>검증이 없다</h2>
 * type·sourceId를 검증하지 않는다 — 게이트를 통과하면 생성은 항상 성공한다(계약이 '검증 없음'을 동결).
 * 여기에 입력 검증을 추가하지 마라.
 */
@Service
public class ReceiverConfigService {

	/**
	 * 응답에 노출 가능한 필드 — Node {@code SAFE_FIELDS}의 <b>순서 그대로</b>다(정렬본이 아니다).
	 * {@code password}·{@code apiKey}는 여기 없으므로 어떤 경로로도 나가지 않는다.
	 */
	static final List<String> SAFE_FIELDS = List.of(
			"id", "sourceId", "type", "name", "host", "port",
			"apiEndpoint", "active", "createdAt", "username");

	private final ReceiverConfigRepository configs;

	private final Authorization authorization;

	public ReceiverConfigService(ReceiverConfigRepository configs, Authorization authorization) {
		this.configs = configs;
		this.authorization = authorization;
	}

	/**
	 * op 결과 — Node의 {@code {ok, ...}} 결과 객체와 동형이다. 성공이면 사유가 없고 해당 payload
	 * (items·id·changes) 중 하나만 채운다. 실패면 사유 토큰만 있다.
	 */
	public record Result(boolean ok, String reason,
			List<Map<String, Object>> items, Integer id, Integer changes) {

		static Result deny(String reason) {
			return new Result(false, reason, null, null, null);
		}

		static Result listed(List<Map<String, Object>> items) {
			return new Result(true, null, items, null, null);
		}

		static Result created(int id) {
			return new Result(true, null, null, id, null);
		}

		static Result removed(int changes) {
			return new Result(true, null, null, null, changes);
		}
	}

	/** 게이트 → 통과면 리포지토리 행마다 SAFE_FIELDS 투영해 목록 반환. */
	public Result query(String sessionToken, Map<String, ?> filters) {
		Authorization.Decision gate = this.authorization.authorize(sessionToken,
				Authorization.MANAGE_RECEIVER_CONFIG);
		if (!gate.ok()) {
			return Result.deny(gate.reason());
		}
		List<Map<String, Object>> items = new ArrayList<>();
		for (Map<String, Object> row : this.configs.query(filters)) {
			items.add(sanitize(row));
		}
		return Result.listed(items);
	}

	/** 게이트 → 통과면 삽입하고 새 행 id 반환. 응답에 시크릿을 반향하지 않는다(id만). */
	public Result create(String sessionToken, Map<String, ?> entry) {
		Authorization.Decision gate = this.authorization.authorize(sessionToken,
				Authorization.MANAGE_RECEIVER_CONFIG);
		if (!gate.ok()) {
			return Result.deny(gate.reason());
		}
		return Result.created(this.configs.insert(entry));
	}

	/** 게이트 → 통과면 삭제하고 영향 행 수 반환(존재 판정 없음 — 멱등). */
	public Result remove(String sessionToken, double id) {
		Authorization.Decision gate = this.authorization.authorize(sessionToken,
				Authorization.MANAGE_RECEIVER_CONFIG);
		if (!gate.ok()) {
			return Result.deny(gate.reason());
		}
		return Result.removed(this.configs.remove(id));
	}

	/**
	 * DB 행 → SAFE_FIELDS 투영. allowlist를 순서대로 돌며 키를 항상 남긴다(값이 없으면 {@code null}) —
	 * 시크릿(password·apiKey)은 allowlist에 없으므로 자연히 빠진다.
	 */
	private static Map<String, Object> sanitize(Map<String, Object> row) {
		Map<String, Object> out = new LinkedHashMap<>();
		for (String field : SAFE_FIELDS) {
			if (row != null && row.containsKey(field)) {
				out.put(field, row.get(field));
			}
		}
		return out;
	}
}
