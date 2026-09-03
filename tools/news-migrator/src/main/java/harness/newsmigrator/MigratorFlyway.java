package harness.newsmigrator;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;

/**
 * MySQL 스키마 정본의 <b>적용기</b> — 기반선({@code db/migration/V1__baseline.sql})은 이 모듈이 소유한다.
 *
 * <h2>왜 server-spring 이 아니라 여기인가</h2>
 * {@code server-spring} 의 {@code NoSchemaSqlInMainSourcesTest} 가 main 소스·리소스에서 이 도구의 철자
 * 자체를 금지한다(실측 · 그 파일 43~52행). 그 게이트는 완화 대상이 아니라 <b>설계 입력</b>이다 —
 * 스키마를 두 서버가 각자 만들면 P3 전환기에 어느 쪽이 정본인지 사라진다(ADR-013 ②). 그래서 Spring 서버는
 * DDL 을 한 줄도 실행하지 않는 채로 두고, MySQL 측 스키마의 정본은 이 모듈이 갖는다(ADR-016 ③④).
 * SQLite 측 정본은 여전히 {@code src/db/schema.js} 이고, 두 정본의 동형성은 기계가 대조한다
 * ({@code BaselineMatchesCanonicalSchemaTest}).
 *
 * <h2>{@link #harden} 이 따로 있는 이유</h2>
 * 스키마의 전 객체를 지우는 기능을 <b>명시로</b> 잠근다. 라이브러리 기본값이 지금 어느 쪽이든 상관없다 —
 * 기본값은 판본 업그레이드로 조용히 바뀔 수 있는 남의 결정이고, 그때 이 도구는 <b>운영 DB 를 향해</b>
 * 돌고 있을 수 있다. 명시로 잠갔는지는 행동 테스트가 확인한다(씨앗 설정을 일부러 반대로 만들어 넣는다).
 */
public final class MigratorFlyway {

	/** 마이그레이션 스크립트의 위치 — 이 모듈의 클래스패스 안에 고정한다(파일 경로를 받지 않는다). */
	public static final String MIGRATION_LOCATION = "classpath:db/migration";

	private MigratorFlyway() {
	}

	/**
	 * 설정을 <b>안전한 쪽으로 잠근다</b>. 씨앗 설정이 무엇이든 결과는 같아야 한다.
	 *
	 * <ul>
	 * <li>스키마 비우기 기능을 명시로 끈다(기본값에 기대지 않는다).</li>
	 * <li>적용 위치를 고정한다 — 실행 디렉토리에 따라 엉뚱한 스크립트가 적용되지 않게.</li>
	 * <li>{@code baselineOnMigrate} 를 켜지 않는다: 이미 내용이 있는 스키마를 "적용된 것으로 치고" 넘어가면
	 * 대조가 통과해도 그 스키마가 정본과 같다는 보장이 사라진다.</li>
	 * <li>버전 정합성 검사를 켠 채로 둔다 — 스크립트가 사후에 바뀌면 시끄럽게 실패해야 한다.</li>
	 * </ul>
	 */
	public static FluentConfiguration harden(FluentConfiguration configuration) {
		return configuration
				.cleanDisabled(true)
				.locations(MIGRATION_LOCATION)
				.baselineOnMigrate(false)
				.validateOnMigrate(true);
	}

	/** 대상 자격으로 잠긴 적용기를 만든다(비밀번호는 인자로만 흐르고 URL 에 박히지 않는다). */
	public static Flyway forTarget(TargetCredentials target) {
		return harden(Flyway.configure().dataSource(target.url(), target.username(), target.password())).load();
	}

}
