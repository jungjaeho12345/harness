package harness.news.model.dialect;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 차등 측정 <b>축 B-8(유한하지 않은 id)</b> — phase 75 <b>step7</b>이 계약 패리티에서 실제로 잡은 divergence다.
 *
 * <h2>어떻게 드러났는가(정직한 기록)</h2>
 * step6의 차등 배터리는 이 축을 <b>보지 못했다</b>(정수 id만 넣었다). step7에서 Spring을 MySQL로 띄우고
 * 계약을 돌리자 {@code default} 프로파일이 관측 3건을 잃으며 red가 났다:
 * <ul>
 * <li>{@code PUT /api/distribution-targets/abc} → Node·SQLite <b>404</b> / MySQL <b>500</b></li>
 * <li>{@code PUT /api/distribution-targets/abc/deactivate} → Node·SQLite <b>404</b> / MySQL <b>500</b></li>
 * <li>{@code DELETE /api/receiver-config/abc} → Node·SQLite <b>200 changes:0</b> / MySQL <b>500</b></li>
 * </ul>
 *
 * <h2>원인</h2>
 * 두 라우트의 id는 Node 의미론({@code Number(req.params.id)})을 따라 {@code double}로 넘어오고
 * 비수치 경로는 {@code NaN}이 된다({@code ReceiverConfigRepository#remove} javadoc이 그 근거를 적고 있다).
 * SQLite는 {@code id = NaN}을 어떤 행과도 같지 않다고 보고 조용히 0행을 준다. <b>MySQL은 다르다</b> —
 * Connector/J가 {@code NaN}·무한대의 바인딩 자체를 프로토콜 단계에서 거부한다. 즉 값이 DB에 닿기도 전에
 * 예외이고, 그것이 500으로 나온다.
 *
 * <h2>해소 방향</h2>
 * 방언별 분기를 넣지 않는다. "유한하지 않은 id는 어떤 행에도 매치되지 않는다"는 것은 <b>정본(Node·SQLite)의
 * 의미론</b>이므로 그 의미론을 리포지토리 코드로 옮긴다 — 그러면 두 방언이 같은 답을 주고, sqlite 경로의
 * 동작은 한 톨도 바뀌지 않는다(무한대도 같은 이유로 함께 막는다: {@code Number('Infinity')}가 실제로
 * 도달 가능한 경로다).
 *
 * <p>대상 DB는 SQLite 임시 파일과 {@code harness_ct_<16진수>}({@code news_ct} 자격)다.
 */
class RepositoryNonFiniteIdDifferentialTest {

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

	/** 존재 판정({@code findById})은 두 방언 모두 <b>빈 Optional</b>이다 — 예외가 아니다. */
	@Test
	void findByIdWithANonFiniteIdIsEmptyInBothDialects() {
		for (double id : new double[] { Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY }) {
			for (DialectPair.Side side : pair.both()) {
				Optional<Map<String, Object>> found = side.targets().findById(id);
				assertTrue(found.isEmpty(), side.name() + ": 유한하지 않은 id(" + id + ")는 어떤 행에도 매치되지 않는다");
			}
		}
	}

	/** 수정({@code update})은 두 방언 모두 <b>0행</b>이고, 멀쩡한 행을 건드리지 않는다. */
	@Test
	void updateWithANonFiniteIdChangesNothingInBothDialects() {
		for (DialectPair.Side side : pair.both()) {
			int alive = side.targets().insert(row("name", "비수치 id 대비군 " + side.name(), "kind", "general",
					"spoolDir", "nonfinite-control", "active", "Y", "createdAt", "2026-09-04T00:00:00.000Z"));

			assertEquals(0, side.targets().update(Double.NaN, Map.of("active", "N")),
					side.name() + ": NaN id 수정은 0행이다");
			assertEquals(0, side.targets().update(Double.POSITIVE_INFINITY, Map.of("active", "N")),
					side.name() + ": 무한대 id 수정은 0행이다");

			Map<String, Object> control = side.targets().findById(alive).orElseThrow();
			assertEquals("Y", control.get("active"), side.name() + ": 남의 행이 바뀌면 안 된다");
		}
	}

	/**
	 * 삭제({@code remove})는 두 방언 모두 <b>0행</b>이다 — 계약이 {@code 200 {ok:true,changes:0}}으로 동결한
	 * 그 수다(500이 아니다).
	 */
	@Test
	void removeWithANonFiniteIdIsZeroChangesInBothDialects() {
		for (DialectPair.Side side : pair.both()) {
			int alive = side.configs().insert(row("sourceId", "nonfinite-" + side.name(), "type", "FTP",
					"name", "비수치 id 대비군", "createdAt", "2026-09-04T00:00:00.000Z"));

			assertEquals(0, side.configs().remove(Double.NaN), side.name() + ": NaN id 삭제는 changes 0이다");
			assertEquals(0, side.configs().remove(Double.NEGATIVE_INFINITY),
					side.name() + ": 무한대 id 삭제는 changes 0이다");

			assertEquals(1, side.configs().query(Map.of("id", Integer.valueOf(alive))).size(),
					side.name() + ": 멀쩡한 행이 사라지면 안 된다");
		}
	}

	/**
	 * <b>대비군</b> — 유한한 id는 여전히 DB까지 간다. 이것이 없으면 "전부 0을 돌려주는" 구현으로도 위 셋이
	 * 통과해 버린다(그 상태에서는 수신설정 삭제 라우트가 영원히 changes 0이 된다).
	 */
	@Test
	void aFiniteIdStillReachesTheDatabaseInBothDialects() {
		for (DialectPair.Side side : pair.both()) {
			int target = side.targets().insert(row("name", "유한 id 대비군 " + side.name(), "kind", "general",
					"spoolDir", "finite-control", "active", "Y", "createdAt", "2026-09-04T00:00:00.000Z"));
			assertTrue(side.targets().findById(target).isPresent(), side.name() + ": 유한 id 조회는 행을 찾는다");
			assertEquals(1, side.targets().update(target, Map.of("active", "N")), side.name() + ": 유한 id 수정은 1행이다");

			int config = side.configs().insert(row("sourceId", "finite-" + side.name(), "type", "FTP",
					"name", "유한 id 대비군", "createdAt", "2026-09-04T00:00:00.000Z"));
			assertEquals(1, side.configs().remove(config), side.name() + ": 유한 id 삭제는 changes 1이다");
			assertEquals(List.of(), side.configs().query(Map.of("id", Integer.valueOf(config))),
					side.name() + ": 지운 행은 남지 않는다");
		}
	}

	private static Map<String, Object> row(Object... keyValues) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < keyValues.length; i += 2) {
			map.put((String) keyValues[i], keyValues[i + 1]);
		}
		return map;
	}

}
