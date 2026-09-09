// 커넥션 풀 1 천장 실측과 769자 텍스트 PK 축의 **순수 판정부** (phase 76 step9).
//
// 왜 별도 모듈인가: scripts/pool-ceiling-probe.mjs 는 CLI 로 즉시 돌아 두 서버를 띄우므로 그 안의 함수를 가져다
// 시험할 수 없다(spring-contract.mjs·spool-parity.mjs·load-rehearsal.mjs 와 같은 이유). 여기 있는 것은
// **분위수 · 부하 자기검사 · 769자 기대표 · 큐 깊이 산술 · 표 만들기**뿐이고, 이것들이 틀리면
// "부하를 걸었는데 아무것도 재지 않은" 상태가 조용히 green 으로 남는다.
// 부수효과(spawn·fetch·fs·env)는 여기 두지 않는다 — 전부 호출자의 몫이다.
//
// 이 파일이 지키는 사실 둘(step9 의 실질 산출물):
//   ① 평균을 적지 않는다 — 천장은 꼬리(p95·최대)와 5xx 건수에서 보인다.
//   ② **VARCHAR(768) 의 상한은 글자다.** 768 이라는 숫자가 utf8mb4 인덱스 상한 3072바이트/4 에서 왔기 때문에
//      「768바이트」로 착각하기 쉬운데, MySQL 이 1406 을 내는 경계는 **글자 수**다(한글 768자 = 2,304바이트는 통과).

/** 동시 요청 수 계단. 1 은 자기검사(U2)의 대조군이라 반드시 첫 칸이다. */
export const LADDER = Object.freeze([1, 2, 4, 8, 16, 32]);

/** 텍스트 PK 의 글자 상한 — 기반선 `VARCHAR(768)`(scripts/lib/dbScaleProbe.mjs `TEXT_PK_LIMIT` 와 같은 값). */
export const TEXT_PK_LIMIT = 768;

/**
 * 769자 축의 **기대표**. `node`/`spring` 은 `POST /api/users` 의 기대 상태코드다.
 *
 * <p>Node(SQLite)는 길이를 강제하지 않아 언제나 200 이고, Spring(MySQL)은 상한을 넘는 글자 수에서
 * 1406 으로 거부해 500 이 된다(divergence — `docs/db-mysql-mapping.md` §7 ④).
 * **한글 768자 줄이 이 표의 핵심이다**: 바이트로 재면 2,304 > 768 이라 실패해야 하지만 실제로는 통과한다.
 */
export const USERID_CASES = Object.freeze([
  Object.freeze({ id: 'ascii-768', fill: 'u', chars: 768, bytes: 768, node: 200, spring: 200, note: '상한 이하(대조군)' }),
  Object.freeze({ id: 'ascii-769', fill: 'u', chars: 769, bytes: 769, node: 200, spring: 500, note: '한 글자 초과 = 1406' }),
  Object.freeze({ id: 'korean-768', fill: '가', chars: 768, bytes: 2304, node: 200, spring: 200, note: '**바이트 상한이면 여기서 터진다**' }),
  Object.freeze({ id: 'korean-769', fill: '가', chars: 769, bytes: 2307, node: 200, spring: 500, note: '글자 초과 = 1406' }),
]);

/** 기대표대로 실제 값을 만든다(값 자체는 리포트에 싣지 않는다 — 길이만 싣는다). */
export function buildUserIdCases() {
  return USERID_CASES.map((c) => ({ ...c, userId: c.fill.repeat(c.chars) }));
}

/**
 * 최근접 순위 분위수. 평균을 쓰지 않는 이유는 천장이 **꼬리**에서 먼저 보이기 때문이다
 * (풀 1 에서는 대부분의 요청이 빠르고 줄 끝의 요청만 느리다 — 평균은 그 사실을 지운다).
 *
 * @returns 표본이 없으면 `null`(0 을 돌려주면 "빠르다"로 읽힌다)
 */
export function percentile(values, p) {
  const sorted = [...(values ?? [])].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/**
 * 한 계단(한 회차)의 요약 — 지연 분위수와 상태코드 분포를 함께 낸다.
 *
 * <p><b>[step10 리뷰 후속]</b> 호출자의 `api()` 는 fetch 가 던지면 `{ status: 0, ms, error }` 를 돌려준다
 * (조용히 버리지 않는 설계다). 그 표본을 **성공으로도 5xx 로도 세지 않은 채 분위수에만 섞으면**
 * 「5xx 0건 · 천장 미관측」이라는 판정이 **전송 계층 실패를 못 보는 카운터** 위에 서게 된다.
 * 그래서 `status <= 0`(응답을 받은 적이 없는 요청)은 <b>`transportFailures` 로 따로 세고 분위수 모집단에서 뺀다</b>.
 * `count` 는 보낸 요청 수 그대로이고 `measured` 가 분위수의 모집단이다. 상태 분포에는 `0` 을 그대로 남긴다.
 */
export function summarise(samples) {
  const list = samples ?? [];
  const statuses = {};
  const times = [];
  let errors5xx = 0;
  let transportFailures = 0;
  for (const s of list) {
    const status = Number(s.status);
    statuses[s.status] = (statuses[s.status] ?? 0) + 1;
    if (!Number.isFinite(status) || status <= 0) {
      transportFailures += 1;
      continue; // 서버가 답한 적이 없다 — 이 대기 시간은 응답 지연이 아니다.
    }
    times.push(s.ms);
    if (status >= 500) errors5xx += 1;
  }
  return {
    count: list.length,
    measured: times.length,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: times.length > 0 ? Math.max(...times) : null,
    errors5xx,
    transportFailures,
    statuses,
  };
}

/**
 * 부하 프로브의 **자기검사**(U2). 둘을 본다.
 * <ol>
 *   <li>동시 요청 수 1에서 5xx 가 나오면 그것은 천장이 아니라 **프로브·환경의 결함**이다.</li>
 *   <li>계단이 목표 동시 수에 실제로 닿지 않았으면 그 계단의 수치는 "그 부하에서의 값"이 아니다
 *       (요청을 순차로 보내 놓고 32 동시라고 적는 것이 이 자리의 조용한 거짓말이다).</li>
 * </ol>
 */
export function judgeLoadSelfCheck(stages) {
  const problems = [];
  for (const stage of stages ?? []) {
    if (stage.concurrency === 1 && stage.summary.errors5xx > 0) {
      problems.push(`동시 요청 수 1에서 5xx 가 ${stage.summary.errors5xx}건 나왔다 — 천장이 아니라 프로브·환경의 결함이다`);
    }
    if (stage.maxInFlight < stage.concurrency) {
      problems.push(`동시 요청 수 ${stage.concurrency} 를 목표했는데 실제 동시 실행은 최대 ${stage.maxInFlight} 였다 — 이 계단의 수치는 그 부하의 값이 아니다`);
    }
    // 전송 실패는 "서버가 답하지 않았다"이지 "빨랐다"가 아니다 — 분위수에서 뺀 사실을 표에도 판정에도 드러낸다.
    if ((stage.summary.transportFailures ?? 0) > 0) {
      problems.push(`동시 요청 수 ${stage.concurrency} 계단에서 전송 실패가 ${stage.summary.transportFailures}건이다`
        + ' — 응답을 받은 적이 없는 요청이라 분위수에서 뺐다. 이 계단의 수치를 그대로 믿지 마라');
    }
  }
  return problems;
}

/** 769자 축 판정 — 기대표와 정확히 같아야 하고, **관측 누락도 실패**다. */
export function judgeUserIdAxis(observations) {
  const failures = [];
  const seen = new Map((observations ?? []).map((o) => [o.id, o]));
  for (const expected of USERID_CASES) {
    const actual = seen.get(expected.id);
    if (!actual) {
      failures.push(`${expected.id}: 관측이 없다 — 재지 못한 것을 통과로 읽지 않는다`);
      continue;
    }
    if (actual.node !== expected.node) {
      failures.push(`${expected.id}: Node 기대 ${expected.node} 실제 ${actual.node}`);
    }
    if (actual.spring !== expected.spring) {
      failures.push(`${expected.id}: Spring 기대 ${expected.spring} 실제 ${actual.spring}`
        + (expected.id.startsWith('korean') ? ' — 한글 축이 어긋나면 상한이 글자가 아니라 바이트로 돈다는 뜻이다' : ''));
    }
  }
  for (const observed of seen.keys()) {
    if (!USERID_CASES.some((c) => c.id === observed)) failures.push(`${observed}: 기대표에 없는 케이스다`);
  }
  return { ok: failures.length === 0, failures };
}

/**
 * 30초 천장에 닿는 데 필요한 **큐 깊이**. 풀이 `poolSize` 이고 요청 하나가 커넥션을 `serviceMs` 쥔다면,
 * 줄 끝의 요청은 대략 `깊이 / poolSize × serviceMs` 를 기다린다 — 그 값이 `timeoutMs` 를 넘는 깊이를 돌려준다.
 *
 * <p>이 산술이 필요한 이유: 부하 계단에서 500 이 하나도 안 나왔다는 관측만으로는 **천장이 없다**고 말할 수 없다.
 * "이 서버 스레드 수로는 그 깊이에 닿을 수 없다"까지 말해야 운영자가 판단할 수 있다.
 */
export function queueDepthForTimeout({ serviceMs, timeoutMs, poolSize }) {
  if (!Number.isFinite(serviceMs) || serviceMs <= 0) return null;
  return Math.ceil((timeoutMs * poolSize) / serviceMs);
}

const cell = (v) => (v === null || v === undefined ? '-' : String(v));

/** 계단표 — 계단마다 **회차를 각각 한 줄로** 낸다(평균 한 줄로 접지 않는다). */
export function formatStageTable(rows) {
  const lines = [
    '| 대상 | 동시 | 회차 | 요청 | p50(ms) | p95(ms) | 최대(ms) | 5xx | 전송 실패 | 실제 동시 |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows ?? []) {
    lines.push(`| ${r.target} | ${r.concurrency} | ${r.round} | ${r.summary.count} | ${cell(r.summary.p50)}`
      + ` | ${cell(r.summary.p95)} | ${cell(r.summary.max)} | ${r.summary.errors5xx}`
      + ` | ${r.summary.transportFailures ?? 0} | ${cell(r.maxInFlight)} |`);
  }
  return lines.join('\n');
}

/** 769자 축 표 — **글자 수와 바이트 수를 같이** 싣는다(둘을 섞지 않기 위해서다). */
export function formatUserIdTable(rows) {
  const byId = Object.fromEntries(USERID_CASES.map((c) => [c.id, c]));
  const lines = [
    '| 케이스 | 글자 | 바이트 | Node | Spring | 기대 |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of rows ?? []) {
    const c = byId[r.id];
    if (!c) continue;
    lines.push(`| ${r.id} | ${c.chars} | ${c.bytes} | ${cell(r.node)} | ${cell(r.spring)} | Node ${c.node} / Spring ${c.spring} |`);
  }
  return lines.join('\n');
}
