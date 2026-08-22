package harness.news.model;

import java.util.Map;

/**
 * 한 기사의 두 행 — {@code Article}(본문 마크업)과 {@code Contents}(공통정보·생애주기·잠금).
 *
 * <p>리포 루트 {@code src/models/articleModel.js}의 {@code getById}가 돌려주는
 * {@code { article, contents }}와 1:1이다. <b>둘 중 하나만 있을 수 있고</b>, 없는 쪽은
 * {@code null}이다 — 응답에서 "키 없음"과 "값이 null"을 가르는 근거가 이 구분이다(decisions (20)①).
 * 둘 다 없으면 애초에 이 객체가 만들어지지 않는다(조회가 {@code null}을 돌려준다).
 *
 * <p>{@code Article} 행은 투영 대상이 아니라 평범한 컬럼 순서 맵이고, {@code Contents} 행은 세션 토큰을
 * 품고 있어 불투명 명목 타입({@link ContentsRow})이다 — 응답에 실릴 수 있는 형태는
 * {@link ContentsProjection#toPublic(ContentsRow)}의 결과뿐이다(decisions (4)①).
 */
public record ArticleAggregate(Map<String, Object> article, ContentsRow contents) {
}
