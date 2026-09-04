package harness.news.model.dialect;

import com.zaxxer.hikari.HikariDataSource;
import harness.news.db.NewsDataSource;
import harness.news.model.ArticleHistoryRepository;
import harness.news.model.ArticleRepository;
import harness.news.model.DistributionTargetRepository;
import harness.news.model.PhotoRepository;
import harness.news.model.ReceiverConfigRepository;
import harness.news.testsupport.EphemeralMysqlDb;
import harness.news.testsupport.TempNewsDb;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Comparator;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 리포지토리 <b>차등 측정</b> 픽스처 — 같은 리포지토리 코드를 두 방언 위에서 나란히 돌린다
 * (phase 75 step6 B).
 *
 * <h2>왜 리포지토리를 통해 재는가</h2>
 * step1의 프로브(축 1~12)는 <b>SQL 조각</b>을 두 엔진에 직접 던져 의미론을 쟀다. 그것으로는 답할 수 없는
 * 질문이 남는다 — "이 서버가 <b>실제로 쓰는 문장</b>이 두 방언에서 같은 답을 주는가". 정렬 절, LIKE 절,
 * 값 바인딩 정책({@code ColumnValues}), 생성 키 회수({@code GeneratedKeyHolder})가 조합된 상태에서만
 * 드러나는 차이가 있고, 그 조합이 곧 프로덕션 경로다. 그래서 여기서는 리포지토리 <b>인스턴스</b>를
 * 양쪽에 하나씩 만들어 같은 호출을 하고 결과를 비교한다.
 *
 * <h2>정본은 SQLite다</h2>
 * 이 phase의 판정 기준은 "MySQL이 SQLite와 같은 답을 주는가"다(Node 서버가 SQLite로 남는다). 그래서
 * 기대값은 언제나 SQLite 쪽 결과이고, 갈리는 축은 <b>양쪽 기대값을 각각 명시</b>해 고정한다
 * (docs/db-mysql-mapping.md §7).
 *
 * <h2>어느 DB·어느 자격인가</h2>
 * SQLite는 OS 임시 디렉토리의 새 파일({@link TempNewsDb} 정본 픽스처), MySQL은
 * {@code harness_ct_<16진수>} 임시 DB({@code news_ct} 자격 · 마이그레이터 기반선)다. 리포 {@code news.db}도
 * {@code news_stage}도 열지 않는다 — 폭발 반경 0이다.
 *
 * <p>MySQL 쪽 커넥션은 <b>프로덕션 경로</b>({@link NewsDataSource#create})로 연다. 세션 read-back까지
 * 같은 코드가 돌아야 측정이 서버와 같은 조건에 선다.
 */
final class DialectPair implements AutoCloseable {

	/** 한쪽 방언의 리포지토리 한 벌. {@code name}은 실패 메시지에만 쓴다. */
	record Side(String name, JdbcClient jdbc, TransactionTemplate transactions,
			ArticleRepository articles, ArticleHistoryRepository history, PhotoRepository photos,
			DistributionTargetRepository targets, ReceiverConfigRepository configs) {
	}

	private final Path sqliteDir;

	private final HikariDataSource sqliteDataSource;

	private final EphemeralMysqlDb mysqlDb;

	private final HikariDataSource mysqlDataSource;

	private final Side sqlite;

	private final Side mysql;

	private DialectPair(Path sqliteDir, HikariDataSource sqliteDataSource, EphemeralMysqlDb mysqlDb,
			HikariDataSource mysqlDataSource) {
		this.sqliteDir = sqliteDir;
		this.sqliteDataSource = sqliteDataSource;
		this.mysqlDb = mysqlDb;
		this.mysqlDataSource = mysqlDataSource;
		this.sqlite = sideOf("sqlite", sqliteDataSource);
		this.mysql = sideOf("mysql", mysqlDataSource);
	}

	/** 두 방언에 같은 스키마를 세우고 리포지토리를 한 벌씩 만든다. */
	static DialectPair open() {
		Path dir;
		try {
			dir = Files.createTempDirectory("news-dialect-pair-");
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
		TempNewsDb.seed(dir);
		HikariDataSource lite = NewsDataSource.create(dir);
		EphemeralMysqlDb db = EphemeralMysqlDb.create();
		try {
			db.applyBaselineSchema();
			HikariDataSource my = NewsDataSource.create(db.dbProperties(), dir);
			return new DialectPair(dir, lite, db, my);
		}
		catch (RuntimeException ex) {
			db.close();
			lite.close();
			throw ex;
		}
	}

	Side sqlite() {
		return this.sqlite;
	}

	Side mysql() {
		return this.mysql;
	}

	/** 두 방언을 같은 순서로 훑을 때 쓰는 목록(정본이 앞이다). */
	java.util.List<Side> both() {
		return java.util.List.of(this.sqlite, this.mysql);
	}

	@Override
	public void close() {
		this.mysqlDataSource.close();
		this.mysqlDb.close();
		this.sqliteDataSource.close();
		deleteRecursively(this.sqliteDir);
	}

	private static Side sideOf(String name, HikariDataSource dataSource) {
		JdbcClient jdbc = JdbcClient.create(dataSource);
		TransactionTemplate transactions = new TransactionTemplate(new JdbcTransactionManager(dataSource));
		return new Side(name, jdbc, transactions,
				new ArticleRepository(jdbc, transactions, Clock.systemUTC()),
				new ArticleHistoryRepository(jdbc),
				new PhotoRepository(jdbc),
				new DistributionTargetRepository(jdbc),
				new ReceiverConfigRepository(jdbc));
	}

	private static void deleteRecursively(Path root) {
		if (!Files.exists(root)) {
			return;
		}
		try (var paths = Files.walk(root)) {
			paths.sorted(Comparator.reverseOrder()).forEach((path) -> {
				try {
					Files.deleteIfExists(path);
				}
				catch (IOException ignored) {
					// 임시 디렉토리 정리는 best-effort — 판정에 영향을 주지 않는다.
				}
			});
		}
		catch (IOException ignored) {
			// 위와 같다.
		}
	}
}
