package harness.news.config;

import java.nio.file.Path;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 앱 설정 바인딩(`app.*`). 값은 전부 OS 환경변수에서 온다 — 키 ↔ 환경변수 대응표는 README를 보라.
 *
 * <p>절대 규칙: {@code app.data-dir}는 필수다. cwd·리포 경로를 추정하지 않는다 — 설정 누락이 조용히
 * 리포 {@code news.db}를 여는 경로가 되기 때문이다("모르면 뜨지 않는다"가 DB 비파괴의 1차 방어선이고,
 * 런타임 탐지보다 명시 주입이 포팅 불변식 7이다).
 *
 * @param dataDir 데이터 디렉토리 절대경로(필수). 이 step은 값을 열지 않는다 — 실제 DB 접근은 step2가 올린다.
 * @param env 실행 환경. {@code production}이면 프로덕션 분기(쿠키·CSRF)를 켠다. 기본은 비프로덕션.
 * @param allowedOrigins CORS allowlist. 콤마 구분 목록이며 기본은 빈 목록이다.
 */
@ConfigurationProperties("app")
public record AppProperties(String dataDir, String env, List<String> allowedOrigins) {

	/** 프로덕션 분기 판정 값. */
	public static final String PRODUCTION = "production";

	private static final String DEFAULT_ENV = "development";

	private static final String MISSING_DATA_DIR =
			"필수 설정 app.data-dir 이(가) 없습니다. 환경변수 DATA_DIR 에 데이터 디렉토리 절대경로를 지정하고 다시 실행하세요. "
					+ "이 서버는 데이터 경로를 추정하지 않습니다(설정 누락으로 엉뚱한 news.db 를 여는 사고를 막기 위함).";

	public AppProperties {
		if (dataDir == null || dataDir.isBlank()) {
			throw new IllegalArgumentException(MISSING_DATA_DIR);
		}
		dataDir = dataDir.trim();
		env = (env == null || env.isBlank()) ? DEFAULT_ENV : env.trim();
		allowedOrigins = allowedOrigins == null
				? List.of()
				: allowedOrigins.stream().map(String::trim).filter(origin -> !origin.isEmpty()).toList();
	}

	/** 프로덕션 분기 여부(쿠키 Secure·SameSite=None, CSRF allowlist 엄격 모드의 입력). */
	public boolean production() {
		return PRODUCTION.equals(env);
	}

	/** 데이터 디렉토리 경로. 존재 여부·스키마 확인은 DB 접근층(step2)의 책임이다. */
	public Path dataDirPath() {
		return Path.of(dataDir);
	}
}
