package harness.news.config;

import harness.news.service.NodeString;
import java.nio.file.Path;
import java.util.Optional;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 배부 스풀 루트 설정 바인딩({@code app.distribution.spool-dir}) — <b>미설정이면 배부가 전면 비활성</b>이다
 * (ADR-008 · decisions (3)).
 *
 * <h2>기본값을 하드코딩하지 않는다</h2>
 * 값은 {@code DIST_SPOOL_DIR} 환경변수에서만 온다. cwd·{@code DATA_DIR} 하위 같은 경로를 추정하면 설정이
 * 없는 배포가 조용히 어딘가에 파일을 쓰기 시작한다 — {@link AppProperties}의 {@code app.data-dir} 규율과
 * 같은 이유다("모르면 하지 않는다").
 *
 * <h2>왜 {@link AppProperties}에 넣지 않는가</h2>
 * 그 타입은 record이고 {@code new AppProperties(...)} 호출부가 테스트 9곳이라, 컴포넌트를 하나 더하면 무관한
 * 두 파일이 함께 바뀐다. 무엇보다 <b>설정의 소유 경계</b>가 흐려진다 — 배부가 켜지는 조건은 배부 도메인이
 * 소유한다({@link CollectionProperties}가 같은 이유로 분리돼 있다).
 *
 * <h2>여기서 파일시스템을 만지지 않는다</h2>
 * 이 클래스는 <b>경로 문자열만</b> 다룬다. 디렉토리 생성·존재 확인은 {@code SpoolWriter}가 쓰기 직전에 멱등
 * ({@code createDirectories})으로 한다. 이유 둘: ① 이 파일은 {@code Adr008DisciplineTest} 4군(파일 쓰기)의
 * <b>예외가 아니다</b> — 파일 연산 한 줄이면 그 게이트가 red다(올바른 복구는 예외 확대가 아니라 코드를
 * 옮기는 것이다) ② 부팅 시점 생성은 미설정 환경에서 의도치 않은 디렉토리를 만든다.
 *
 * <h2>판정 지점은 하나다</h2>
 * tick과 retry가 각자 "스풀이 켜져 있는가"를 판정하면 두 라우트의 503 조건이 어긋난다. 그 판정은
 * {@link #rootPath()} 하나뿐이다.
 *
 * <p><b>Node와의 차이(기록)</b>: Node는 {@code env.DIST_SPOOL_DIR}의 truthy 판정이라 공백 1칸(" ")을
 * <b>설정됨</b>으로 본다. 여기서는 공백만 있는 값을 미설정으로 수렴시킨다(decisions (3) — 빈 .env 항목·오타가
 * 배부를 "켜진 것처럼" 보이게 하지 않는다). 두 서버 모두 그런 값으로는 정상 배부가 불가능하므로 계약이
 * 관측하는 축이 아니다.
 *
 * @param spoolDir 배부 스풀 루트 절대경로. 빈 문자열·공백이면 <b>없음</b>이다
 */
@ConfigurationProperties("app.distribution")
public record SpoolProperties(String spoolDir) {

	public SpoolProperties {
		// 다듬기는 NodeString 단일 출처다 — String.trim()/strip()은 JS 공백 집합과 갈린다.
		spoolDir = (spoolDir == null) ? "" : NodeString.trim(spoolDir);
	}

	/**
	 * 스풀 루트 경로 — <b>배부 활성 판정의 단일 출처</b>다. 값이 없으면 {@link Optional#empty()}이고, 그때
	 * 스풀 writer도 배부 서비스도 만들어지지 않는다.
	 */
	public Optional<Path> rootPath() {
		return this.spoolDir.isEmpty() ? Optional.empty() : Optional.of(Path.of(this.spoolDir));
	}

	/** 배부 활성 여부(= 스풀 루트가 설정돼 있는가). */
	public boolean enabled() {
		return !this.spoolDir.isEmpty();
	}
}
