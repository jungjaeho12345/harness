package harness.spring_auth;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 합성 루트(ADR-006) — 서비스/리포지토리 빈을 생성자 주입으로 조립하는 단일 지점.
 * 환경변수(APS_DB_FILE)는 여기서만 읽어 하위 컴포넌트에 값으로 주입한다.
 */
@Configuration
public class AppConfig {

	/**
	 * 영속 계층 — APS_DB_FILE(하네스가 시드한 임시 news.db) 경로로 조립한다.
	 * 미설정 시 NewsDb 생성자가 즉시 실패한다(하드코딩 폴백 없음 — 원본 news.db 무접촉).
	 */
	@Bean
	NewsDb newsDb(@Value("${APS_DB_FILE:}") String dbFile) {
		return new NewsDb(dbFile);
	}

	/** 인메모리 세션 스토어 — 프로덕션 시계(System.currentTimeMillis). */
	@Bean
	SessionStore sessionStore() {
		return new SessionStore();
	}

	/** 세션 가드 — 매 요청 User 재도출(ADR-004). NewsDb를 UserLookup으로 주입한다. */
	@Bean
	SessionGuard sessionGuard(SessionStore sessionStore, NewsDb newsDb) {
		return new SessionGuard(sessionStore, newsDb);
	}

	/** 세션 쿠키 writer — APS_PROD_COOKIE로 프로덕션/비프로덕션 속성 분기. */
	@Bean
	SessionCookieWriter sessionCookieWriter(@Value("${APS_PROD_COOKIE:false}") boolean prodCookie) {
		return new SessionCookieWriter(prodCookie);
	}

	/** 로그인 정책 — bcrypt 검증·계정잠금(5회/15분). 잠금 카운트는 NewsDb.updateUser 화이트리스트 경유. */
	@Bean
	AuthService authService(NewsDb newsDb) {
		return new AuthService(newsDb);
	}

	/** POST /api/login IP 레이트리밋(15분/10회) — 11번째 요청이 429(비-JSON). */
	@Bean
	LoginRateLimitFilter loginRateLimitFilter() {
		return new LoginRateLimitFilter();
	}
}
