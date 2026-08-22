package harness.news.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code Contents} 행의 응답 투영 — 리포 루트 {@code src/services/contentsProjection.js}와 1:1.
 *
 * <p>존재 이유(ADR-004 신뢰 경계): 세션 토큰은 그 자체가 권한이다. {@code lockerSessionId}에는 편집 중인
 * 사용자의 <b>유효 세션 토큰 원문</b>이, {@code lockerClientId}에는 저장 인가에 쓰이는 편집 탭 식별자가
 * 들어 있다. 이 값이 조회 응답에 실리면 인증된 아무 사용자나(예: R 기자) 목록만 조회해 데스크의 토큰·탭
 * 식별자를 얻어 권한 상승·탭 사칭을 할 수 있다.
 *
 * <p>규율:
 * <ul>
 *   <li>DB 컬럼과 저장 로직은 그대로 둔다(DB 비파괴, ADR-002). 재로그인 takeover 판정에
 *       {@code lockerSessionId}가 필요하므로 리포지토리는 계속 전 컬럼을 돌려준다.</li>
 *   <li>제거는 <b>이 한 곳</b>에서만 한다. 컨트롤러에서 컬럼을 개별로 지우면 새 라우트에서 반드시
 *       누락된다(이 결함의 원인 자체가 라우트별 처리 부재였다).</li>
 *   <li>원본 행을 변형하지 않는다 — 같은 행이 잠금 판정 등 후속 로직에서 재사용된다.</li>
 *   <li>토큰을 해시·마스킹·prefix 등 다른 형태로 파생해 내보내지 않는다(부분 노출도 공격 표면이다).</li>
 * </ul>
 *
 * <p>외부 반출(배부 스풀)의 필드 allowlist는 목적이 다르므로 여기서 소유하지 않는다.
 */
public final class ContentsProjection {

	/**
	 * 응답으로 나가면 안 되는 {@code Contents} 컬럼의 <b>단일 출처</b>. 값이 곧 인증 자격이거나 위조
	 * 재료인 것만 담는다.
	 *
	 * <p>{@code lockYN}·{@code lockerUserId}·{@code lockedAt}은 <b>넣지 않는다</b> — 잠금 표시 UI 계약이라
	 * 빼면 목록 화면이 잠금 상태를 잃는다.
	 */
	public static final List<String> PRIVATE_COLUMNS = List.of("lockerSessionId", "lockerClientId");

	/**
	 * 원본 행 → 클라이언트로 내보낼 안전한 새 맵(29컬럼 − 2 = 27키). 키 순서는 그대로이고, 값이 SQL
	 * NULL인 키도 <b>남는다</b>(decisions (5)(20) — 키 없음과 null은 다르다).
	 *
	 * <p>{@code null} 입력은 {@code null}이다 — 투영이 호출자를 깨뜨리지 않는다.
	 */
	public static Map<String, Object> toPublic(ContentsRow row) {
		if (row == null) {
			return null;
		}
		Map<String, Object> out = new LinkedHashMap<>();
		for (Map.Entry<String, Object> column : row.columns().entrySet()) {
			if (PRIVATE_COLUMNS.contains(column.getKey())) {
				continue;
			}
			out.put(column.getKey(), column.getValue());
		}
		return out;
	}

	/**
	 * 컬렉션 입력의 원소별 투영. 호출부(목록·검색)가 명시적으로 이 메서드를 부르는 것이 규율이며,
	 * 이 안전망은 오용이 무음 토큰 유출로 번지지 않게 한다.
	 */
	public static List<Map<String, Object>> toPublicAll(List<ContentsRow> rows) {
		List<Map<String, Object>> out = new ArrayList<>();
		for (ContentsRow row : (rows == null) ? List.<ContentsRow>of() : rows) {
			out.add(toPublic(row));
		}
		return out;
	}

	private ContentsProjection() {
	}
}
