package harness.news.service;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * 송고 성공 시 <b>"지금 즉시" 배부할 kind</b>를 정하는 순수 판정 — 리포 루트
 * {@code src/services/articleService.js} 86~94행({@code distributionKindsForSend})의 1:1 이식이다.
 * news.md "엠바고 규칙" + ADR-008 (4)의 직역이며, 상태도 시계도 DB도 만지지 않는다.
 *
 * <h2>판정표</h2>
 * <table>
 *   <caption>최종 상태 × 엠바고 설정</caption>
 *   <tr><th>상태(최종)</th><th>엠바고</th><th>결과</th></tr>
 *   <tr><td>{@code DPS}</td><td>미설정</td><td>{@code [press, nonpress]} — 전량 즉시 배부</td></tr>
 *   <tr><td>{@code DPS}</td><td>설정</td><td><b>이미 배부된 kind에만</b>(정정본)</td></tr>
 *   <tr><td>{@code DES}</td><td>2차만 설정</td><td>{@code [press]} — 송고 즉시 언론사</td></tr>
 *   <tr><td>그 밖</td><td>—</td><td>없음</td></tr>
 * </table>
 *
 * <p>{@code DPS} + 엠바고 설정은 레거시 {@code DDH} 경로의 잔존 행이나 완결 후 고침의 재송고다 —
 * <b>미도래분은 tick의 책임</b>이므로 이미 나간 곳에만 정정본을 보낸다. 송고 직후 상태는 {@code DES}뿐이다
 * ({@code EPS}는 배부가 <b>실제로 실행된 뒤</b> 승격이 만든다 — 여기에 {@code EPS} 분기를 두면 두 상태가
 * 같은 의미인 것처럼 오독된다).
 *
 * <h2>시각을 비교하지 않는다</h2>
 * "지금이 엠바고 시각인가"는 <b>tick의 질문</b>이다(ADR-008 (3)). 여기서 비교하면 판정이 두 곳으로 갈리고,
 * 도래 전 기사가 송고 순간 밖으로 나간다(회수 수단이 없다). 그래서 이 클래스에는 {@code Clock}도
 * {@code now} 인자도 없다.
 *
 * <h2>엠바고 설정 판정의 단일 출처</h2>
 * {@link EmbargoPolicy#requiredKinds}가 유일한 출처다 — {@code !!contents.embargoAt} 식 재구현을 하지
 * 않는다(빈 문자열·공백·숫자 0의 falsy 의미론이 두 벌이 되는 순간 한쪽이 엠바고를 흘린다). {@code DES}
 * 행이 두 컬럼을 <b>따로</b> 보는 것도 같은 출처로 한다: {@code requiredKinds}에 {@code press}가 없다는
 * 것이 곧 {@code embargoAt} 미설정이고, {@code nonpress}가 있다는 것이 곧 {@code secondEmbargoAt}
 * 설정이다(Node의 {@code !contents.embargoAt && contents.secondEmbargoAt}와 같은 판정이다).
 */
public final class SendDistribution {

	/** 배부 대상 종류. <b>반환 순서가 이 상수 순서</b>다(호출자가 준 순서가 아니다). */
	private static final List<String> KINDS = List.of("press", "nonpress");

	private static final String PRESS = "press";

	private static final String NONPRESS = "nonpress";

	private static final String DPS = "DPS";

	private static final String DES = "DES";

	private SendDistribution() {
	}

	/**
	 * 이 송고로 지금 배부할 kind.
	 *
	 * @param status <b>저장된 최종 상태</b>(엠바고 후처리를 거친 값 — 전이표의 결과가 아니다)
	 * @param contents 공통정보 컬럼 접근자. {@code null}이면 엠바고 미설정으로 본다
	 * @param alreadyDistributed 이 기사에서 <b>이미 배부된 kind</b>(= {@link EmbargoPolicy#distributedKinds}
	 *     — "역사상 어디로 나갔나"). 조회는 호출자 책임이고 {@code null}·미지 값은 조용히 무시된다.
	 *     <b>이번 사이클 한정 판정({@code cycleDistributedKinds})을 넣지 마라</b> — 질문이 다르다:
	 *     사이클로 좁히면 정정본이 나가지 않는다(decisions (9))
	 * @return 배부할 kind(항상 {@code press} → {@code nonpress} 순서). 배부하지 않으면 빈 목록
	 */
	public static List<String> kindsForSend(String status, Function<String, Object> contents,
			List<String> alreadyDistributed) {
		List<String> required = EmbargoPolicy.requiredKinds(contents);

		if (DPS.equals(status)) {
			// 엠바고가 없으면 전량이다 — 이미 배부된 목록을 보지 않는다(첫 송고에는 이력이 없다).
			return required.isEmpty() ? KINDS : intersect(alreadyDistributed);
		}
		// 2차만 설정된 기사는 송고 시 바로 언론사로 나간다(비언론사는 2차 시각에 — tick).
		if (DES.equals(status) && !required.contains(PRESS) && required.contains(NONPRESS)) {
			return List.of(PRESS);
		}
		return List.of();
	}

	/** 이미 나간 kind와의 교집합 — 상수 순서로 돌려주고 미지 값·{@code null} 원소는 버린다. */
	private static List<String> intersect(List<String> alreadyDistributed) {
		if (alreadyDistributed == null) {
			return List.of();
		}
		List<String> kinds = new ArrayList<>();
		for (String kind : KINDS) {
			if (alreadyDistributed.contains(kind)) {
				kinds.add(kind);
			}
		}
		return List.copyOf(kinds);
	}

}
