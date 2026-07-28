// 시점 배부 tick 서비스 — ADR-008 (3)(5). 도메인 로직 (HTTP 비의존, ADR-006). 의존성은 주입.
//
// "외부 운영 루틴이 POST /api/distribution/tick을 주기 호출하면, 지금 시각 기준으로
//  배부할 게 있는 EPS 기사를 배부하고, 배부가 전부 완결된 기사를 EPS→DPS로 전이한다."
//
// CRITICAL — 이 파일에 타이머(setInterval/재귀 setTimeout)를 두지 않는다.
//   주기 실행의 주체는 앱 밖의 운영 루틴이다(ADR-008 (3)). 앱이 스스로 돌면 다중 인스턴스에서 중복 반출이 난다.
//
// 책임 분담:
//   - "언제/무엇을 배부할지"의 규칙 → embargoSchedule(순수 함수). 여기서 시각을 비교하지 않는다.
//   - 실제 스풀 파일 쓰기·distributedAt·배부 이력 → 주입된 distributionService(phase 47).
//   - 상태 전이 규칙 → lifecycle.embargoCompleteTransition. 여기서 전이표를 재구현하지 않는다.
//
// 멱등성: 외부 루틴이 분 단위로 반복 호출한다. 이미 배부된 kind는 이력 기준으로 걸러지고(pendingKinds),
//   완결된 기사는 DPS가 되어 다음 tick의 조회 대상(status='EPS')에서 자연히 빠진다.

import { pendingKinds, isEmbargoComplete, requiredKinds, distributedKinds } from './embargoSchedule.js';
import { embargoCompleteTransition } from './lifecycle.js';

export function createDistributionTickService({
  articleModel,
  historyModel,
  distributionService,
  now = () => new Date().toISOString(),
}) {
  // 이력 기록은 부가 기록이다 — 실패해도 이미 반영된 전이를 되돌리지 않는다(articleService.record와 동형).
  function record(rec) {
    if (!historyModel) return;
    try { historyModel.insert({ ...rec, createdAt: now() }); }
    catch { /* 이력 기록 실패는 tick을 막지 않는다 */ }
  }

  // 배부 이력을 DB에서 다시 읽는다 — 완결 판정의 근거는 distribute()의 반환값이 아니라 이력이다(ADR-008 (5)).
  // 이력 append가 실패한 배부를 완결로 오인하면, 전이 후 근거가 DB에 없어 감사 추적이 끊긴다.
  function historyRowsOf(articleId) {
    try { return historyModel.queryByArticle(articleId); }
    catch { return []; }
  }

  // 한 기사 처리 — 배부(있으면)와 완결 판정을 **독립적으로** 수행한다.
  // 배부할 pending이 0이어도 완결 판정을 건너뛰지 않는다: 이전 tick이 이력을 남긴 뒤 전이 전에 중단됐거나
  // 송고 훅이 필요한 kind를 이미 전부 배부한 기사는 배부 없이 전이만 필요하다(자가 치유 — 없으면 영구 EPS 고착).
  async function processArticle(contents, nowIso, actorUserId, out) {
    const articleId = contents.articleId;

    const pending = pendingKinds(contents, historyRowsOf(articleId), nowIso);
    if (pending.length > 0) {
      const res = await distributionService.distribute(articleId, { kinds: pending, actorUserId });
      if (res && res.ok) {
        if (res.distributed && res.distributed.length > 0) {
          out.distributed.push({ articleId, kinds: [...new Set(res.distributed.map((d) => d.kind))] });
        }
        for (const f of res.failed ?? []) {
          out.failed.push({ articleId, kind: f.kind, reason: f.reason ?? 'spool-write-failed' });
        }
      } else {
        out.failed.push({ articleId, kind: null, reason: res?.reason ?? 'distribute-failed' });
      }
    }

    // 전이 판정은 **다시 읽은 최신 행**으로 한다 — 목록 스냅샷으로 판정하면 안 된다.
    // 스풀 쓰기(await) 동안 HTTP 핸들러가 끼어들어 데스크가 KILL/보류(EPS→EEK/EEH)했을 수 있는데,
    // 스냅샷의 'EPS'를 믿으면 킬된 기사를 DPS로 되살린다(회수 불가한 생애주기 오염).
    const fresh = articleModel.getById(articleId)?.contents;
    if (!fresh) return;

    // 완결 판정 — 배부 직후의 이력을 다시 읽어 판정한다.
    const rows = historyRowsOf(articleId);
    if (!isEmbargoComplete(fresh, rows)) {
      // 아직 완결이 아닌 기사는 무엇이 빠졌는지 드러낸다(운영자가 원인을 알 수 있어야 한다 —
      // 예: 2차 엠바고 기사에서 송고 시 언론사 배부가 실패해 press 이력이 없는 경우).
      const done = new Set(distributedKinds(rows));
      out.incomplete.push({ articleId, missing: requiredKinds(fresh).filter((k) => !done.has(k)) });
      return;
    }

    // 전이 규칙은 lifecycle이 단일 출처다. EPS가 아니면(EEH/EEK 등) 여기서 거부된다.
    const next = embargoCompleteTransition(fresh.status);
    if (!next.ok) return;

    // present-only 갱신 — status만 쓴다. sentAt·sender·distributedAt·본문은 건드리지 않는다(DB 비파괴).
    articleModel.update(articleId, { contents: { status: next.status } });
    record({
      articleId,
      eventType: 'status',
      action: 'embargoComplete',
      fromStatus: fresh.status,
      toStatus: next.status,
      actorUserId,
    });
    out.completed.push(articleId);
  }

  // 1회 실행. 호출될 때만 동작한다(타이머 없음).
  // 반환: { ok:true, checkedCount, distributed, completed, incomplete, failed }
  async function tick({ actorUserId = null } = {}) {
    if (!distributionService) return { ok: false, reason: 'spool-disabled' };

    const nowIso = now();
    // 대상은 엠바고 송고 대기(EPS)뿐이다. 보류(EEH)·킬(EEK)된 기사는 시각이 지나도 나가면 안 된다.
    const targets = articleModel.query({ status: 'EPS' });

    const out = { distributed: [], completed: [], incomplete: [], failed: [] };
    let checkedCount = 0;

    for (const contents of targets) {
      // 엠바고 시각이 하나도 없는 EPS 기사는 시점 배부의 대상이 아니다(required 빈 배열 → 완결 판정도 false).
      if (requiredKinds(contents).length === 0) continue;
      checkedCount += 1;
      try {
        await processArticle(contents, nowIso, actorUserId, out);
      } catch {
        // 한 기사의 실패가 나머지 기사의 엠바고를 통째로 밀리게 하면 안 된다.
        // 사유는 고정 문자열만 싣는다 — 예외 메시지에는 스풀 경로 등 내부 정보가 섞인다(마스킹 규율).
        // 상세는 배부 실패 로그(logService.warn)가 이미 식별자·사유 형태로 남긴다.
        out.failed.push({ articleId: contents.articleId, kind: null, reason: 'tick-failed' });
      }
    }

    return { ok: true, checkedCount, ...out };
  }

  return { tick };
}
