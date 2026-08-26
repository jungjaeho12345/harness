package harness.news.service;

import harness.news.config.SpoolProperties;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.DistributionTargetRepository;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Optional;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 배부 계층 합성 루트(ADR-008) — 리포 루트 {@code src/controllers/index.js} 71~130행과 <b>같은 결선</b>이다.
 *
 * <h2>배부가 켜지는 조건은 여기 한 줄뿐이다</h2>
 * {@link SpoolProperties#rootPath()}가 비어 있으면(= {@code DIST_SPOOL_DIR} 미설정) 스풀 writer가 없고,
 * 그러면 배부 서비스도 없다(decisions (3)). 그 상태의 관측 결과는:
 * <ul>
 *   <li>tick — 인가 통과 <b>후</b> {@code spool-disabled}(503). 판정은 {@link DistributionTickService}가
 *       {@code distribution == null}로 받아 스스로 한다 — 컨트롤러가 설정을 다시 읽으면 판정 지점이 둘이
 *       되어 tick과 retry의 503 조건이 어긋난다.</li>
 *   <li>retry — <b>어떤 DB 조회도 하기 전에</b> {@code spool-disabled}(503). 같은 이유로
 *       {@link DistributionRetryService}가 writer 부재를 스스로 본다.</li>
 *   <li>failures(조회) — 스풀 설정과 <b>무관하게</b> 200이다. 그래서 재전송 서비스는 writer가 없어도
 *       <b>항상</b> 결선한다(Node도 그렇다).</li>
 *   <li>송고 훅 — {@link ArticleLifecycleService}가 {@code ObjectProvider}로 받아 없으면 아무 일도 하지
 *       않는다(배부가 없던 때와 완전히 같은 동작).</li>
 * </ul>
 *
 * <h2>비활성이면 빈을 만들지 않는다({@code null} 반환)</h2>
 * 소비자는 전부 {@code ObjectProvider.getIfAvailable()}로 받는다 — "비어 있는 writer"를 만들어 주입하면
 * 미설정 배포에서 <b>쓰기를 시도하는 코드 경로가 살아 있게</b> 되고, 그 경로의 안전은 다시 런타임 분기에
 * 의존한다. 없으면 없는 것이 안전 기본값이다.
 *
 * <h2>여기에 타이머를 두지 않는다</h2>
 * tick의 트리거는 외부 cron의 {@code POST /api/distribution/tick} 하나뿐이다(ADR-008 (3)) — 이 클래스에
 * {@code @EnableScheduling}·워커 풀·재시도 큐가 없다는 사실은 {@code Adr008DisciplineTest}가 기계로 지킨다.
 *
 * <h2>실패 통지</h2>
 * 세 seam({@code onFailure}·{@code onError})은 전부 로그 버퍼로 간다 — 미발송이 <b>무음</b>으로 사라지면
 * 운영이 알 방법이 없다. 줄에는 <b>식별자와 고정 사유만</b> 담는다: 이 버퍼는
 * {@code GET /api/logs/digest}로 밖으로 나가므로 경로·본문 한 조각이 곧 응답이다(LOGS.md · ADR-007).
 * 배부 실패와 재전송 실패, 이력 기록 실패는 <b>서로 다른 사건</b>이라 어휘를 섞지 않는다.
 */
@Configuration(proxyBeanMethods = false)
public class DistributionConfig {

	/**
	 * 스풀 라이터 — 루트가 설정된 환경에서만 존재한다. 디렉토리 생성은 이 빈이 <b>쓰기 직전</b>에 하므로
	 * 여기서 파일시스템을 만지지 않는다(부팅 시점 생성은 미설정 환경에 폴더를 만든다).
	 *
	 * @return 스풀 루트가 없으면 {@code null}(빈 없음)
	 */
	@Bean
	public SpoolWriter spoolWriter(SpoolProperties properties, Clock clock) {
		Optional<Path> root = properties.rootPath();
		return root.isEmpty() ? null : new SpoolWriter(root.get(), clock);
	}

	/**
	 * 배부 실행(대상 선정·스풀 쓰기·{@code distributedAt}·이력) — writer가 없으면 이 서비스도 없다.
	 *
	 * @return 배부 비활성이면 {@code null}(빈 없음)
	 */
	@Bean
	public DistributionService distributionService(DistributionTargetRepository targets,
			ArticleRepository articles, ArticleHistoryRepository history, ArticleHistoryRecorder recorder,
			ObjectProvider<SpoolWriter> spoolWriter, Clock clock, LogService logs) {
		SpoolWriter writer = spoolWriter.getIfAvailable();
		if (writer == null) {
			return null;
		}
		return new DistributionService(targets, articles, history, recorder, writer, clock,
				(failure) -> logs.warn("배부 실패 articleId=" + failure.articleId() + " targetId="
						+ failure.targetId() + " kind=" + failure.kind() + " reason=" + failure.reason()));
	}

	/** 배부 후 상태 반영(DES → EPS → DPS) — 파일시스템과 무관하므로 <b>항상</b> 결선한다. */
	@Bean
	public ArticleEmbargoService articleEmbargoService(ArticleRepository articles,
			ArticleHistoryRepository history, ArticleHistoryRecorder recorder,
			TransactionTemplate transactions) {
		return new ArticleEmbargoService(articles, history, recorder, transactions);
	}

	/**
	 * 엠바고 시점 배부 tick — <b>항상</b> 결선한다. 배부가 비활성일 때 {@code spool-disabled}를 돌려주는
	 * 것도 이 서비스의 책임이라(판정 지점 단일화) 빈을 없애지 않는다.
	 */
	@Bean
	public DistributionTickService distributionTickService(ArticleRepository articles,
			ArticleHistoryRepository history, ObjectProvider<DistributionService> distribution,
			ObjectProvider<ArticleEmbargoService> embargo, Clock clock, LogService logs) {
		return new DistributionTickService(articles, history, distribution.getIfAvailable(),
				embargo.getIfAvailable(), clock,
				(error) -> logs.warn("배부 tick 실패 articleId=" + error.articleId() + " reason="
						+ error.reason()));
	}

	/**
	 * 배부 실패 조회·재전송 — <b>항상</b> 결선한다. 조회는 스풀 설정과 무관하게 200이어야 하고, 재전송의
	 * {@code spool-disabled}는 이 서비스가 writer 부재로 스스로 판정한다.
	 */
	@Bean
	public DistributionRetryService distributionRetryService(ArticleHistoryRepository history,
			ArticleHistoryRecorder recorder, DistributionTargetRepository targets, ArticleRepository articles,
			ObjectProvider<SpoolWriter> spoolWriter, TransactionTemplate transactions, Clock clock,
			LogService logs) {
		return new DistributionRetryService(history, recorder, targets, articles,
				spoolWriter.getIfAvailable(), transactions, clock,
				(failure) -> logs.warn("배부 재전송 실패 articleId=" + failure.articleId() + " targetId="
						+ failure.targetId() + " kind=" + failure.kind() + " reason=" + failure.reason()));
	}

}
