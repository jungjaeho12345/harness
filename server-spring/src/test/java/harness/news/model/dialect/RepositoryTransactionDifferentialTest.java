package harness.news.model.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import harness.news.db.NewsDataSource;
import harness.news.model.ArticleAggregate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 차등 측정 <b>축 B-6: 트랜잭션·잠금</b>(phase 75 step6).
 *
 * <h2>풀 상한 1이 이 축의 전제다</h2>
 * 커넥션 풀은 두 방언 모두 1이다({@code NewsDataSource.MAX_POOL_SIZE} · ADR-016 결정 6). SQLite에서의
 * 원래 근거(단일 writer)는 MySQL에서 사라지지만, 확대는 동시성 동작을 바꾸는 별개 결정이고 74 ⑤가
 * 폐색한 락 순서 결함의 방어선({@code LogsStreamWireTest} 항목 22)이 그 상수에 걸려 있다.
 *
 * <p>상한이 1이면 <b>같은 스레드 안에서 커넥션을 두 번 요구하는 코드가 곧 교착</b>이다. 그래서 이
 * 클래스는 트랜잭션 안에서 리포지토리를 다시 부르는 경로가 <b>두 방언 모두</b> 같은 물리 커넥션을 쓰는지
 * 확인한다 — 한쪽만 성립하면 MySQL 전환이 조용히 교착을 들여온다.
 *
 * <p><b>변이 M6</b>: {@code MAX_POOL_SIZE}를 2로 바꾸면 아래 "커넥션 하나" 단언과
 * {@code LogsStreamWireTest} 항목 22가 red다(결과표는 step summary).
 */
class RepositoryTransactionDifferentialTest {

	/** 동시 삽입 스레드 수 — 풀 상한 1이므로 실제 병렬은 아니고 <b>순서 뒤섞임</b>을 만든다. */
	private static final int WRITERS = 4;

	private static final int ROUNDS = 6;

	private static DialectPair pair;

	@BeforeAll
	static void openPair() {
		pair = DialectPair.open();
	}

	@AfterAll
	static void closePair() {
		if (pair != null) {
			pair.close();
		}
	}

	/** 두 테이블 삽입이 <b>한 트랜잭션</b>이다 — 중간에 실패하면 어느 테이블에도 남지 않는다. */
	@Test
	void aFailedTwoTableInsertLeavesNothingBehindInEitherDialect() {
		for (DialectPair.Side side : pair.both()) {
			String articleId = "AKR%08d%09d".formatted(20260501, side.name().length());

			assertThrows(RuntimeException.class, () -> side.articles().insert(
					row("articleId", articleId, "title", "원자성"),
					row("articleId", articleId, "title", "원자성", "status", Boolean.TRUE)),
					side.name() + ": 두 번째 삽입이 실패해야 한다(불리언 바인딩 거부)");

			assertNull(side.articles().findById(articleId),
					side.name() + ": 첫 테이블 삽입이 커밋으로 남았다 — 원자성이 깨졌다");
		}
	}

	/** 성공 경로는 두 테이블이 함께 보인다(위 단언이 "언제나 null"이 아님을 못 박는다). */
	@Test
	void aSuccessfulTwoTableInsertIsVisibleInBothTablesInEitherDialect() {
		for (DialectPair.Side side : pair.both()) {
			String articleId = "AKR%08d%09d".formatted(20260502, side.name().length());
			side.articles().insert(
					row("articleId", articleId, "title", "원자성 성공"),
					row("articleId", articleId, "title", "원자성 성공", "status", "RDS"));

			ArticleAggregate found = side.articles().findById(articleId);
			assertNotNull(found, side.name() + ": 커밋된 기사를 찾지 못했다");
		}
	}

	/**
	 * 트랜잭션 안에서 리포지토리를 <b>여러 번</b> 불러도 커넥션 하나로 끝난다 — 풀 상한 1에서 이것이
	 * 성립하지 않으면 그 경로는 교착이다(30초 {@code connectionTimeout} 뒤 실패).
	 *
	 * <p>{@code assertTimeoutPreemptively} 대신 실제로 끝나는지를 본다: 교착이면 이 테스트가 멈추고,
	 * 멈춘 스위트는 그 자체로 신호다(무한 대기가 아니라 Hikari 타임아웃으로 끝난다).
	 */
	@Test
	void nestedRepositoryCallsInsideATransactionShareOneConnectionInBothDialects() {
		for (DialectPair.Side side : pair.both()) {
			Integer id = side.transactions().execute((status) -> {
				int created = side.configs().insert(row("sourceId", "tx-nested-" + side.name(),
						"type", "API", "name", "중첩 호출", "createdAt", "2026-05-01T00:00:00.000Z"));
				List<Map<String, Object>> found = side.configs().query(Map.of("id", Integer.valueOf(created)));
				assertEquals(1, found.size(), side.name() + ": 같은 트랜잭션 안에서 방금 넣은 행이 보여야 한다");
				return Integer.valueOf(created);
			});

			assertNotNull(id, side.name() + ": 트랜잭션이 값을 돌려주지 못했다");
		}
	}

	/**
	 * 풀 상한 1에서 <b>동시 삽입이 남의 id를 받지 않는다</b> — {@code GeneratedKeyHolder}가 삽입한 그
	 * 문장에서 키를 회수하기 때문이다(step5 M4가 SQLite에서 실증한 결함의 MySQL 판본).
	 *
	 * <p>이 축은 계약이 볼 수 없다(Node는 단일 스레드다). 회수한 id로 <b>삭제</b>가 이어지는 경로가
	 * 있으므로(유일한 행 삭제 예외) 잘못된 id는 곧 남의 설정 행이 사라지는 사고다.
	 */
	@Test
	void concurrentInsertsNeverReceiveAnotherWritersIdOnMysql() throws Exception {
		DialectPair.Side side = pair.mysql();
		Map<Integer, String> byId = new ConcurrentHashMap<>();
		CountDownLatch start = new CountDownLatch(1);
		List<Future<?>> futures = new ArrayList<>();

		ExecutorService pool = Executors.newFixedThreadPool(WRITERS);
		try {
			for (int writer = 0; writer < WRITERS; writer++) {
				int mine = writer;
				futures.add(pool.submit(() -> {
					start.await();
					for (int round = 0; round < ROUNDS; round++) {
						String sourceId = "tx-race-%d-%d".formatted(mine, round);
						int id = side.configs().insert(row("sourceId", sourceId, "type", "FTP",
								"name", "경합", "createdAt", "2026-05-02T00:00:00.000Z"));
						byId.put(Integer.valueOf(id), sourceId);
					}
					return null;
				}));
			}
			start.countDown();
			for (Future<?> future : futures) {
				future.get(60, TimeUnit.SECONDS);
			}
		}
		finally {
			pool.shutdownNow();
		}

		assertEquals(WRITERS * ROUNDS, byId.size(), "회수한 id가 겹쳤다 — 남의 id를 받은 삽입이 있다");
		for (Map.Entry<Integer, String> entry : byId.entrySet()) {
			List<Map<String, Object>> rows = side.configs().query(Map.of("id", entry.getKey()));
			assertEquals(1, rows.size(), "id " + entry.getKey() + " 행이 없다");
			assertEquals(entry.getValue(), rows.get(0).get("sourceId"),
					"id " + entry.getKey() + " 가 남의 행을 가리킨다");
		}
	}

	/**
	 * 두 방언의 <b>대기 시간 정책이 다르다</b>는 사실을 기록한다 — SQLite는 우리가 세운
	 * {@code busy_timeout}(5초)이고, MySQL은 서버가 정한 {@code innodb_lock_wait_timeout}(실측 50초)이다.
	 *
	 * <p>이 차이는 결함이 아니라 <b>운영 지식</b>이다: 같은 교착이 SQLite에서는 5초 뒤 예외로, MySQL에서는
	 * 50초 뒤 예외로 드러난다(그 전에 Hikari의 30초 {@code connectionTimeout}이 먼저 터질 수도 있다).
	 * 값을 바꾸지 않고 <b>부등식만</b> 단언한다 — 서버 설정을 코드가 통제하지 않기 때문이다.
	 */
	@Test
	void theLockWaitBudgetsDifferAndTheDifferenceIsRecordedNotEqualised() {
		long innodbSeconds = pair.mysql().jdbc().sql("SELECT @@session.innodb_lock_wait_timeout")
				.query(Long.class).single();

		assertTrue(innodbSeconds > 0, "InnoDB 대기 예산이 0이면 즉시 실패한다: " + innodbSeconds);
		assertTrue(innodbSeconds * 1000L > NewsDataSource.BUSY_TIMEOUT_MS,
				"측정 기록: innodb_lock_wait_timeout=" + innodbSeconds + "s vs busy_timeout="
						+ NewsDataSource.BUSY_TIMEOUT_MS + "ms — 부등식이 뒤집혔으면 런북을 갱신하라");
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}
}
