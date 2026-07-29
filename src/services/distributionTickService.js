// 시점/엠바고 배부의 도메인 엔진 — EPS(엠바고 송고 대기) 기사를 훑어 도래한 kind만 배부하고,
// 배부 요건이 전부 채워진 기사만 EPS→DPS로 전이한다. HTTP·세션·타이머·FS를 모른다(ADR-006).
//
// ADR-008: 앱에 스케줄러를 두지 않는다. runTick()은 외부 cron이 HTTP로 pull하는 1회 실행 함수다(라우트는 step3).
// 배부 실행/스풀 쓰기는 distributionService에, 시각·완결 규칙은 embargoSchedule에 위임한다(단일 출처).
//
// CRITICAL: "이미 무엇이 배부됐는가/완결됐는가"의 판정 근거는 ArticleHistory(eventType='distribute')뿐이다.
//   - Contents.distributedAt은 마지막 시각 1개라 어떤 kind가 나갔는지 알 수 없다.
//   - distribute() 반환값은 실패를 포함할 수 있어 완결 판정 근거로 쓰면 실패한 배부가 완결로 둔갑한다.
//   따라서 배부 전/후로 이력을 두 번 읽어(스풀에 실제로 기록된 것만 남는다) 판정한다.

import * as embargoScheduleModule from './embargoSchedule.js';

// 이력 행들에서 배부 완료된 kind 집합을 만든다(eventType='distribute'의 action). 삽입 순서 유지.
function distributedSet(rows) {
  const set = new Set();
  for (const row of rows) {
    if (row && row.eventType === 'distribute' && row.action != null) set.add(row.action);
  }
  return set;
}

export function createDistributionTickService({
  articleModel,
  historyModel,
  distributionService,                        // 없으면(스풀 미설정) runTick은 spool-disabled
  embargoSchedule = embargoScheduleModule,    // 순수 규칙 모듈(주입 가능 — 테스트 결정성)
  now = () => new Date().toISOString(),       // 주입 가능한 시계
}) {
  // single-flight: runTick은 await를 포함하므로, cron이 겹쳐 호출하면 같은 기사가 두 번 반출된다.
  // 클로저 플래그로 동시 실행을 막고, 해제는 반드시 finally에서 한다(예외가 나도 영구 잠김 금지).
  let running = false;

  async function runTick({ actorUserId = null } = {}) {
    // (a) 진입 가드 — DB를 읽기 전에 판정한다.
    if (!distributionService) return { ok: false, reason: 'spool-disabled' };
    if (running) return { ok: false, reason: 'tick-in-progress' };
    const nowMs = embargoSchedule.parseInstant(now());
    if (nowMs === null) return { ok: false, reason: 'invalid-clock' }; // fail-safe: 배부 0건.

    running = true;
    try {
      // (b) 대상 조회 — EPS만. 다른 status는 대상에 넣지 않는다.
      const candidates = articleModel.query({ status: 'EPS' });
      const distributed = [];
      const completed = [];
      const incomplete = [];

      for (const candidate of candidates) {
        const articleId = candidate.articleId;
        // (f) 기사 단위 격리 — 한 기사의 예외가 tick 전체를 죽이지 않는다.
        try {
          // (b) TOCTOU 방어: 최신 행을 다시 읽어 여전히 EPS인 것만 처리한다.
          // 목록 조회와 처리 사이에 데스크가 KILL(EEK)/보류(EEH)했을 수 있다 — 죽은 기사 부활 금지.
          const fresh = articleModel.getById(articleId);
          if (!fresh || !fresh.contents || fresh.contents.status !== 'EPS') continue;

          // (c) 배부 — 도래한 kind 중 이력에 없는 것만(이력 기반 멱등).
          const already = distributedSet(historyModel.queryByArticle(articleId));
          const due = embargoSchedule.dueKinds(fresh.contents, nowMs);
          const toDistribute = due.filter((kind) => !already.has(kind));

          if (toDistribute.length > 0) {
            // 반환이 ok:false거나 failed가 있어도 throw하지 않는다 — 그 기사만 미완결로 남긴다.
            await distributionService.distribute(articleId, { kinds: toDistribute, actorUserId });
          }

          // (d) 완결 판정 — 이력을 다시 읽어 실제 스풀 기록분만 반영한다.
          const afterRows = historyModel.queryByArticle(articleId);
          const afterSet = distributedSet(afterRows);
          // 이번 tick에서 실제로 스풀 기록에 성공한 kind만 — 이력 DESC 순이 아니라 due의 정규 순서로.
          const newly = due.filter((kind) => afterSet.has(kind) && !already.has(kind));
          if (newly.length > 0) distributed.push({ articleId, kinds: newly });

          if (embargoSchedule.isComplete(fresh.contents, afterSet)) {
            // (e) 완결 시 전이 — 직전에 최신 행을 한 번 더 읽어 EPS일 때만 전이한다(배부 중 KILL 방지).
            const latest = articleModel.getById(articleId);
            if (latest && latest.contents && latest.contents.status === 'EPS') {
              // present-only: status 하나만 넘긴다(sentAt/distributedAt/본문 불변).
              articleModel.update(articleId, { contents: { status: 'DPS' } });
              // append-only 이력. insert 실패는 격리한다(이미 끝난 전이를 되돌리지 않는다).
              try {
                historyModel.insert({
                  articleId, eventType: 'status', action: 'embargoComplete',
                  fromStatus: 'EPS', toStatus: 'DPS', actorUserId, createdAt: now(),
                });
              } catch { /* 이력 기록 실패는 전이를 되돌리지 않는다 */ }
              completed.push(articleId);
            }
            // latest가 EPS가 아니면(배부 중 KILL/보류) 전이하지 않고 조용히 넘어간다 — 부활 금지.
          } else {
            // 아직 요건 미충족(도래 전 포함) — 표면화한다.
            incomplete.push({ articleId, missing: embargoSchedule.missingKinds(fresh.contents, afterSet) });
          }
        } catch {
          // 예외가 난 기사는 무음 삼키지 않고 incomplete로 표면화한다.
          incomplete.push({ articleId, missing: [] });
        }
      }

      return { ok: true, checked: candidates.length, distributed, completed, incomplete };
    } finally {
      running = false;
    }
  }

  return { runTick };
}
