// 시점 배부(tick) 도메인 서비스 — 도메인 로직 (HTTP 비의존, ADR-006).
// ADR-008 (3): 시점 배부(엠바고 1·2차 시각)는 앱 내 타이머가 아니라 pull 엔드포인트(POST /api/distribution/tick,
// step2)로 실행한다. 이 모듈은 그 pull 1회 호출당 해야 할 일(도래 판정 → 배부 → 완결 전이)을 정의할 뿐,
// 스스로 스케줄링하지 않는다.
//
// 책임은 셋뿐이다:
//  (1) EPS 후보 중 엠바고 시각이 도래한 kind를 골라(멱등 — 이미 배부된 kind는 제외) distributionService.distribute 위임
//  (2) 배부 이후 articleService.completeEmbargoDistribution으로 완결 전이(EPS→DPS) 시도
//  (3) 프로세스 내 단일 실행 보장(같은 kind 중복 배부 방지)
//
// 책임이 아닌 것:
//  - 스풀 파일 쓰기·대상 선정·배부 시각 갱신·배부 이력 기록 → distributionService(재구현 금지)
//  - 상태 전이(EPS→DPS) → articleService.completeEmbargoDistribution(재구현 금지)
//  - "엠바고 설정 → 요구 배부 kind" 매핑 → requiredDistributionKinds(재구현 금지)
//  - HTTP 라우트/인증 헤더 파싱·로그·SSE 신호 → step2/3

import { requiredDistributionKinds } from './articleService.js';

// 어떤 시각 문자열이 now 이하로 도래했는지 — Date.parse가 NaN이거나 값이 falsy면 안전측(미도래)으로 본다.
// Contents.embargoAt은 VARCHAR 자유 텍스트라 포맷 보장이 없다(파싱 불가 값을 배부하면 되돌릴 수 없다).
function isDue(value, nowMs) {
  if (!value) return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && t <= nowMs;
}

// 프로세스 내 단일 실행 게이트 — 모듈 스코프(인스턴스 스코프 금지).
// distribute는 async이며 스풀 쓰기를 await하므로, 중첩 tick이 둘 다 "이력 없음"으로 판정해
// 같은 kind를 두 번 스풀에 기록할 수 있다(외부 전송기가 두 번 발송 — 되돌릴 수 없다).
let running = false;

// 리뷰 승인안 a(phase 48 코드리뷰 high) — tick↔송고 훅 press 경합 유예.
// applyAction(articleService)은 EPS를 먼저 커밋하고 press 배부를 await 없이(fire-and-forget) 호출한다.
// 그 창(스풀 write~history insert, 수 ms~수백 ms)에 tick이 돌면 "2차 엠바고만" 기사는
// pressAlwaysDue=true이고 history에 press 행이 아직 없어 tick이 press를 한 번 더 distribute한다
// → 같은 수신처 스풀에 2개 파일 → 외부 전송기 2회 발송(되돌릴 수 없다).
// 해법: 송고 시점(sentAt) 기준 유예 시간 안에는 tick이 press를 회복 배부하지 않는다(송고 훅의
// in-flight 배부를 신뢰). 유예가 지나도 press 이력이 없으면(=송고 훅 배부가 실패한 경우) 그때 회복한다.
// 새 환경변수는 만들지 않는다(ADR-008) — 모듈 상수로 고정.
const GRACE_MS = 60000; // 60초.

function pressRecoveryReady(row, nowMs) {
  // sentAt이 없거나(레거시 데이터) 파싱 불가면 유예 창이 이미 지난 것으로 본다(기존 동작 보존).
  if (!row.sentAt) return true;
  const sentMs = Date.parse(row.sentAt);
  if (!Number.isFinite(sentMs)) return true;
  return nowMs - sentMs > GRACE_MS;
}

export function createDistributionTickService({
  articleModel,
  historyModel,
  distributionService,
  articleService,
  authorization,
  now = () => new Date(),
}) {
  // 이 기사에 지금 배부해야 할 kind들 — requiredDistributionKinds(단일 출처) ∩ 도래한 kind − 이미 배부된 kind.
  function dueKinds(row) {
    const required = requiredDistributionKinds(row);
    if (required.length === 0) return [];

    const nowMs = now().getTime();
    // 2차 엠바고만 설정된 기사는 press의 도래 시각이 "송고 시점"이다(news.md) — tick에서는 도래로 본다.
    // 단, pressRecoveryReady 유예가 지나야만 적용한다(위 GRACE_MS 설명 참조 — high 수정).
    // 1차 엠바고가 설정된 기사(embargoAt truthy)로 이 예외를 확대하지 않는다.
    const pressAlwaysDue = !row.embargoAt && !!row.secondEmbargoAt && pressRecoveryReady(row, nowMs);
    const due = new Set();
    if (pressAlwaysDue || isDue(row.embargoAt, nowMs)) due.add('press');
    if (isDue(row.secondEmbargoAt, nowMs)) due.add('nonpress');

    const distributedRows = historyModel.queryByArticle(row.articleId) || [];
    const already = new Set(
      distributedRows.filter((h) => h.eventType === 'distribute').map((h) => h.action),
    );

    return required.filter((k) => due.has(k) && !already.has(k));
  }

  async function run(sessionId) {
    // 1) 인가가 항상 먼저 — 비인가 호출자에게 실행 상태(spool 설정/busy)를 노출하지 않는다.
    const gate = authorization.runDistributionTick(sessionId);
    if (!gate.ok) return gate;

    // 2) 그 다음 단일 실행 게이트. busy 판정은 인가 통과 후에만 한다.
    if (running) return { ok: false, reason: 'busy' };
    running = true;
    try {
      if (!distributionService) return { ok: false, reason: 'spool-disabled' };

      const candidates = articleModel.query({ status: 'EPS' });
      const distributed = [];
      const transitioned = [];
      const failed = [];

      for (const row of candidates) {
        const articleId = row.articleId;
        try {
          const kinds = dueKinds(row);
          if (kinds.length > 0) {
            // med 수정: distribute 반환을 반영한다 — 활성 대상 0건이거나 전 수신처 실패면
            // distributed가 비어 있다(distributionService.distribute 계약). 그런 경우를 "배부됨"으로
            // 집계하지 않는다 — 요구 kind 수신처가 없어 EPS에 정체된 기사가 로그상 정상으로 보이면 안 된다.
            const res = await distributionService.distribute(articleId, { kinds, actorUserId: gate.userId });
            const recordedKinds = res && res.ok
              ? [...new Set((res.distributed || []).map((d) => d.kind))]
              : [];
            if (recordedKinds.length > 0) distributed.push({ articleId, kinds: recordedKinds });

            const missingKinds = kinds.filter((k) => !recordedKinds.includes(k));
            if (missingKinds.length > 0) {
              const reason = res && res.ok ? 'not-distributed' : ((res && res.reason) || 'distribute-failed');
              for (const kind of missingKinds) failed.push({ articleId, kind, reason });
            }
          }

          const comp = articleService.completeEmbargoDistribution(articleId, { actorUserId: gate.userId });
          if (comp && comp.transitioned) transitioned.push(articleId);
        } catch (err) {
          failed.push({ articleId, reason: (err && err.message) || 'tick-failed' });
        }
      }

      return { ok: true, evaluated: candidates.length, distributed, transitioned, failed };
    } finally {
      // 예외 경로에서도 반드시 해제 — 다음 외부 호출이 처리할 수 있게 한다(내부 대기·큐잉 없음).
      running = false;
    }
  }

  return { run };
}
