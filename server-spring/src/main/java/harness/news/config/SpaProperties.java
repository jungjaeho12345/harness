package harness.news.config;

import harness.news.service.NodeString;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * SPA 정적 루트 설정 바인딩({@code app.spa-dir}) — <b>미설정이면 SPA 서빙이 비활성</b>이다(ADR-017 결정 1).
 *
 * <h2>기본값을 하드코딩하지 않는다</h2>
 * 값은 {@code SPA_DIR} 환경변수에서만 온다. 경로를 추정하면 설정이 없는 배포가 조용히 어딘가의 파일을
 * 서빙한다 — {@link SpoolProperties}({@code DIST_SPOOL_DIR})와 같은 규율이다("모르면 하지 않는다").
 *
 * <h2>판정 기준은 디렉토리가 아니라 {@code <dir>/index.html} 파일이다</h2>
 * Node {@code resolveSpaRoot}(198~208행)의 CRITICAL 주석이 이유를 적어 뒀다: 파일이 없는데 폴백을 켜면
 * 미정의 GET마다 파일 부재가 전역 에러 핸들러로 흘러 <b>404가 500으로 뒤집힌다</b>. 확인은 <b>부팅 시
 * 1회</b>다 — {@link WebConfig}의 {@code @Bean}이 이 값을 한 번 읽고, 비활성이면 핸들러를 <b>등록하지
 * 않는다</b>(등록해 두고 요청마다 분기하면 404 경로가 두 갈래가 된다).
 *
 * <h2>비활성이 기본이라는 사실이 이 phase의 회귀 판정을 살려 둔다</h2>
 * 계약 하네스는 {@code SPA_DIR}을 자식 프로세스에 넘기지 않으므로({@code javaChildEnv()}는 허용목록 방식)
 * 313관측 × 2축이 <b>이 비활성 상태</b>로 돈다. 하네스가 이 값을 넘기도록 고치지 마라 — 계약 리포트가
 * SPA 응답을 관측하기 시작해 Node/Spring 두 대상의 프로파일 구성이 갈린다.
 *
 * <h2>절대 던지지 않는다</h2>
 * {@link SpoolProperties#rootPath()}와 같은 규율이다({@link Path#of}는 파일시스템이 파싱조차 못 하는
 * 문자열에 unchecked 예외를 던진다 — {@code "C:\web\dist"}처럼 따옴표가 섞인 {@code .env} 한 줄이면
 * <b>컨텍스트 기동이 실패</b>해 39 라우트가 전멸한다). SPA 설정 오타가 로그인을 죽이면 안 된다.
 *
 * @param spaDir SPA 정적 루트 절대경로. 빈 문자열·공백이면 <b>없음</b>(= 서빙 비활성)이다
 */
@ConfigurationProperties("app")
public record SpaProperties(String spaDir) {

	private static final Logger logger = LoggerFactory.getLogger(SpaProperties.class);

	/** 서빙 활성 판정의 기준 파일 — Node와 같은 이름이다. */
	private static final String INDEX_FILE = "index.html";

	public SpaProperties {
		// 다듬기는 NodeString 단일 출처다 — String.trim()/strip()은 JS 공백 집합과 갈린다.
		spaDir = (spaDir == null) ? "" : NodeString.trim(spaDir);
	}

	/**
	 * 설정값을 절대 경로로 해석한 것(<b>존재 확인 전</b>) — 미설정이거나 파싱 불가면 없음이다.
	 *
	 * <p>절대화는 여기 한 곳에서 한다: 상대 경로를 그대로 두면 프로세스 작업 디렉토리에 따라 서빙 루트가
	 * 달라진다(Node {@code resolveSpaDir}도 {@code path.resolve}로 절대화한다).
	 */
	public Optional<Path> resolvedDir() {
		if (this.spaDir.isEmpty()) {
			return Optional.empty();
		}
		try {
			return Optional.of(Path.of(this.spaDir).toAbsolutePath().normalize());
		}
		catch (InvalidPathException ex) {
			// 예외 메시지에는 문제의 경로 원문이 그대로 담긴다 — ex.toString()을 찍지 마라.
			logger.warn("spa root is not a valid path: spa serving disabled");
			return Optional.empty();
		}
	}

	/**
	 * SPA 루트 — <b>서빙 활성 판정의 단일 출처</b>다. 미설정·공백·{@code <dir>/index.html} 부재면
	 * {@link Optional#empty()}(= 비활성)이고, 어떤 경우에도 던지지 않는다.
	 */
	public Optional<Path> spaRootPath() {
		return resolvedDir().filter((root) -> Files.isRegularFile(root.resolve(INDEX_FILE)));
	}

	/**
	 * 서빙 활성 여부 — <b>{@link #spaRootPath()}에서 파생</b>한다. 별도 술어로 쓰면 두 판정이 갈린다
	 * (판정 지점은 하나다 — {@link SpoolProperties#enabled()}와 같은 규율).
	 */
	public boolean enabled() {
		return spaRootPath().isPresent();
	}
}
