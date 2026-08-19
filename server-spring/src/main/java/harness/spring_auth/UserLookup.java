package harness.spring_auth;

/**
 * 사용자 행 조회 추상화 — SessionGuard가 매 요청 신원 재도출에 쓴다(ADR-004). NewsDb가 구현한다.
 * 인터페이스로 분리해 세션 가드 단위 테스트가 DB 없이 재도출 호출 횟수를 검증할 수 있게 한다.
 */
public interface UserLookup {
	NewsDb.User findUser(String userId);
}
