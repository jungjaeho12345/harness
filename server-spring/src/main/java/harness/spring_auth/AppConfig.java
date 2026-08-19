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
}
