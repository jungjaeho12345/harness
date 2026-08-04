// 엠바고 시점 배부 tick — 도메인 로직(HTTP·타이머·파일시스템 비의존, ADR-006). 의존성은 주입.
// ADR-008 (3): 시점 배부는 앱 내 타이머가 아니라 외부 운영 cron이 부르는 pull 엔드포인트로 실행한다
// (`POST /api/distribution/tick` — 라우트 결선은 다음 step). 그래서 이 모듈에는:
//   - setInterval/setTimeout 등 주기 실행이 없다(다중 인스턴스 중복 배부 방지). run()은 호출자만 트리거한다.
//   - fetch/소켓 등 egress가 없다. 외부로 나가는 유일한 경로는 distributionService→spoolWriter의 파일 쓰기다.
//
// run()이 하는 일은 하나뿐이다: "엠바고 시각이 도래했는데 아직 배부되지 않은 kind"를 찾아 배부를 지시한다.
//   - 무엇이 도래/미배부인가          → embargoPolicy(dueKinds) 단일 출처
//   - 어디에 어떻게 쓰는가            → distributionService(대상 선정·스풀 쓰기·distributedAt·배부 이력)
//   - 배부 후 상태는 무엇인가          → articleService.syncEmbargoStatus(생애주기 단일 출처)
// 이 모듈은 위 셋을 순서대로 엮고 결과를 요약할 뿐이며, status도 distributedAt도 직접 쓰지 않는다.

import {
  EMBARGO_DISTRIBUTABLE_STATUSES,
  requiredKinds,
  cycleDistributedKinds,
  dueKinds,
  unparsableEmbargoFields,
} from './embargoPolicy.js';

// 기사 단위 예외의 고정 사유 토큰. 원시 에러 문자열(String(e))을 쓰지 않는 이유:
// 에러 메시지에 스풀 경로가 실려 나가면 아래 failed 투영(화이트리스트)이 그대로 우회된다.
const TICK_FAILED = 'tick-failed';
// 배부 서비스가 사유를 주지 않은 경우의 기본값(실물은 항상 토큰을 준다 — 방어).
const UNKNOWN_FAILURE = 'spool-write-failed';
// 배부 직전 재검증에서 allowlist(DES·EPS·DPS) 밖으로 전이된 것이 확인된 기사의 스킵 사유.
// 새 상태값 자체는 담지 않는다 — 요약은 식별자·고정 사유만 담는 화이트리스트다.
const STATUS_CHANGED = 'status-changed';
// 도래한 kind의 활성 수신처가 0곳이라 성공·실패 기록이 모두 0건으로 끝난 경우의 사유.
// 요약 어디에도 안 남으면 미배부가 무음으로 사라진다(무음 삼킴 금지).
const NO_ACTIVE_TARGET = 'no-active-target';

// 배부 실패 항목은 **식별자와 사유만** 남긴다 — 이 값은 tick 라우트의 HTTP 응답으로 그대로 나간다.
// 실물 실패 항목은 { articleId, targetId, kind, spoolDir, reason }(distributionService.js:77)이라
// 그대로 합치면 서버 파일시스템 경로가 유출된다. 화이트리스트 투영이므로 향후 실패 항목에
// 필드가 추가돼도 기본값은 "미노출"이다(안전 기본값).
function projectFailure(articleId, item) {
  return {
    articleId,
    targetId: item && item.targetId !== undefined ? item.targetId : null,
    kind: item && typeof item.kind === 'string' ? item.kind : null,
    reason: item && typeof item.reason === 'string' ? item.reason : UNKNOWN_FAILURE,
  };
}

// distributionService(선택): 미주입이면 배부 자체가 불가하므로 tick은 아무것도 하지 않는다.
// onError(선택): 기사 단위 예외 원인을 표면화한다(distributionService.onFailure와 동형).
//   응답에는 고정 토큰만 담으므로, 이 훅이 없으면 원인이 무음으로 사라진다 — 무음 삼킴 금지.
export function createDistributionTickService({
  articleModel,
  historyModel,
  distributionService,
  articleService,
  // CRITICAL: now는 **ISO-8601 UTC 문자열**을 반환해야 한다(embargoPolicy의 시각 계약).
  // 숫자(epoch ms)를 주면 dueKinds가 안전 기본값으로 []를 돌려주어 전 기사가 조용히 미배부된다.
  now = () => new Date().toISOString(),
  onError,
}) {
  // 로그 실패가 스캔을 멈추지 않게 격리한다.
  function notifyError(info) {
    if (!onError) return;
    try { onError(info); } catch { /* 로그 실패는 배부를 막지 않는다 */ }
  }

  // "이미 배부됨"의 유일한 근거는 append-only 이력((eventType='distribute', action=kind))이다.
  // 상태가 아니라 이력으로 판정하기 때문에 멱등이 자연 성립하고(같은 시각 반복 호출에도 재배부 없음),
  // phase 47 이전에 DDH 경로로 송고돼 DPS로 남은 레거시 엠바고 기사도 후보에서 빠지지 않는다.
  // 범위는 **이번 배부 사이클**이다(cycleDistributedKinds — DES·EPS는 마지막 송고 이력 이후만,
  // DPS 등은 전체 이력). 보류→엠바고 재설정→재송고로 DES에 재진입한 기사를 전체 이력으로 보면
  // 도래분이 "이미 배부됨"으로 걸러져 영원히 배부되지 않고, 이어지는 self-heal이 거짓 완결(DPS)까지
  // 만든다 — 복구 경로가 없는 결함이다. status는 반드시 호출 시점의 판정 대상 상태를 넘겨라.
  function distributedOf(articleId, status) {
    if (!historyModel) return [];
    return cycleDistributedKinds({ status, historyRows: historyModel.queryByArticle(articleId) });
  }

  // 상태 전이는 전적으로 articleService.syncEmbargoStatus에 위임한다(생애주기 단일 출처).
  // 여기서 articleModel.update(..., { contents: { status } })를 부르지 않는 이유:
  // 상태 규칙이 두 곳으로 갈라지면 DES/EPS/DPS 판정이 발산한다.
  function syncStatus(articleId, extraKinds, actorUserId, fallback) {
    if (!articleService || typeof articleService.syncEmbargoStatus !== 'function') return fallback;
    const res = articleService.syncEmbargoStatus(articleId, { extraKinds, actorUserId });
    return res && res.ok ? res.status : fallback;
  }

  // single-flight 플래그 — cron 중복 트리거·수동 호출 겹침으로 run이 동시에 돌면 같은 기사가 두 번
  // 스풀된다(멱등 근거인 배부 이력은 스풀 쓰기 **후**에 남아, 동시 실행의 스캔에는 보이지 않는다).
  // 다중 인스턴스 중복은 ADR-008 (3)의 "외부 cron 단일 트리거" 운영 규율이 막고, 여기는 프로세스 내 보호다.
  let running = false;

  // 도래한 엠바고 배부를 1회 실행한다. 외부 cron이 주기 호출하는 유일한 진입점이다.
  // 반환: { ok:true, at, scanned, distributed:[{articleId,kinds,status}],
  //         failed:[{articleId,targetId,kind,reason}], invalid:[{articleId,field}] }
  //       진행 중 재진입 시 { ok:true, ..., scanned:0, skipped:'in-progress' } (스캔 없이 즉시 반환)
  //       미가용 시 { ok:false, reason:'spool-disabled' | 'tick-failed' }
  // CRITICAL: throw하지 않는다 — 라우트가 500으로 새면 운영 cron이 원인을 알 수 없다.
  async function run({ actorUserId = null } = {}) {
    if (!distributionService) return { ok: false, reason: 'spool-disabled' };

    // 진행 중이면 새 스캔을 시작하지 않는다 — 응답 shape은 정상 요약과 동형(화이트리스트 위생 유지),
    // skipped 토큰만 추가돼 운영 cron이 "겹침 스킵"을 관측할 수 있다.
    if (running) {
      return { ok: true, at: now(), scanned: 0, distributed: [], failed: [], invalid: [], skipped: 'in-progress' };
    }
    running = true;
    try {
      return await runOnce({ actorUserId });
    } finally {
      running = false; // 실패 반환 경로에서도 반드시 해제 — 아니면 tick이 영구 무력화된다.
    }
  }

  async function runOnce({ actorUserId }) {
    // 시계는 실행당 한 번만 읽는다 — 같은 실행 안에서 시각이 흔들리면 기사마다 판정이 갈린다.
    const at = now();

    let candidates;
    try {
      // 상태 allowlist는 embargoPolicy가 단일 출처다(DES·EPS·DPS).
      // 미송고(RDS·RRH·RRK·DDH·DDK)·킬(EEK)·보류(EEH)·삭제(DPD)가 외부로 나가면 회수 수단이 없다.
      // 비용 인식(의도적 수용): 이 조회는 송고된 전 기사(DPS 전량)를 로드한 뒤 JS에서 거른다.
      // 레거시 DPS 엠바고 기사 픽업의 대가이며, 규모는 scanned로 노출해 운영자가 관측한다.
      candidates = articleModel
        .query({ status: [...EMBARGO_DISTRIBUTABLE_STATUSES] })
        // 엠바고가 설정되지 않은 기사는 tick의 관심사가 아니다(송고 즉시 배부는 송고 훅의 책임).
        .filter((contents) => requiredKinds(contents).length > 0);
    } catch (e) {
      notifyError({ articleId: null, error: e });
      return { ok: false, reason: TICK_FAILED };
    }

    const distributed = [];
    const failed = [];
    const invalid = [];

    // 순차 처리(sequential await) — Promise.all 병렬 배부 금지.
    // 같은 SQLite 파일에 상태·이력을 쓰므로 순서가 예측 가능해야 하고, 테스트도 결정적이어야 한다.
    for (const contents of candidates) {
      const { articleId } = contents;
      try {
        // 오타 등 파싱 불가 엠바고 값은 "미도래"로 취급되어 영원히 배부되지 않는다 —
        // 운영자가 알 수 있게 표면화한다(무음 삼킴 금지).
        for (const field of unparsableEmbargoFields(contents)) invalid.push({ articleId, field });

        // 불변식: done을 계산할 때 쓴 status와, 그 done을 넘기는 dueKinds/embargoStatusFor의
        // status는 항상 같아야 한다(사이클 범위가 status에 따라 달라지므로).
        let done = distributedOf(articleId, contents.status);
        let effective = contents;
        let due = dueKinds({ status: contents.status, contents, distributed: done, now: at });

        if (due.length > 0) {
          // TOCTOU 재검증: 후보 스캔의 스냅샷과 실제 배부 사이(선행 기사의 await 동안)에 KILL(EEK)·
          // 보류(EEH)·삭제(DPD)로 전이됐을 수 있다 — 한 번 나간 기사는 회수 수단이 없으므로,
          // 배부 지시 직전에 최신 행으로 1회만 재조회해 status와 엠바고 값을 다시 판정한다.
          // 배부 후 상태 전이(syncEmbargoStatus)는 이미 fresh read라 이 지점만 막으면 된다.
          const freshRow = articleModel.getById(articleId);
          const fresh = freshRow && freshRow.contents ? freshRow.contents : null;
          if (!fresh || !EMBARGO_DISTRIBUTABLE_STATUSES.includes(fresh.status)) {
            // 무음 스킵 금지 — 요약에 고정 사유로만 남긴다(새 상태값·경로 비노출).
            failed.push({ articleId, targetId: null, kind: null, reason: STATUS_CHANGED });
            continue;
          }
          effective = fresh;
          // 스냅샷과 status가 달라졌으면 "이미 배부됨"도 fresh 기준으로 다시 센다(위 불변식).
          // 예: 스냅샷 DES(사이클 범위) → 완결로 전이(DPS·전체 이력 범위). 옛 done을 그대로 쓰면
          // 이미 나간 수신처로 중복 배부된다(회수 불가).
          if (fresh.status !== contents.status) done = distributedOf(articleId, fresh.status);
          due = dueKinds({ status: fresh.status, contents: fresh, distributed: done, now: at });
        }

        if (due.length === 0) {
          // 재정합(self-heal): 이력은 있는데 승격이 누락된 기사(이력 insert 실패·과거 데이터)가
          // 영원히 대기 상태로 남지 않게 한다. 바꿀 게 없으면 embargoStatusFor가 null을 주므로 쓰기 0건이다.
          if (effective.status === 'DES' || effective.status === 'EPS') {
            syncStatus(articleId, [], actorUserId, effective.status);
          }
          continue;
        }

        const res = await distributionService.distribute(articleId, { kinds: due, actorUserId });

        // { ok:false, reason:'spool-disabled'|'not-found' } — 배부 자체가 성립하지 않은 경우.
        if (!res || res.ok !== true) {
          failed.push(projectFailure(articleId, { reason: res && res.reason }));
          continue;
        }

        for (const item of Array.isArray(res.failed) ? res.failed : []) {
          failed.push(projectFailure(articleId, item));
        }

        // 도래한 kind가 성공·실패 어느 쪽에도 없는 유일한 경우는 해당 kind의 활성 수신처가 0곳일 때다
        // (distributionService는 수신처마다 distributed/failed 중 하나에 반드시 기록한다).
        // 그대로 두면 미배부가 요약 어디에도 안 남는다 — targetId 없이 사유만 투영한다(경로 비노출 유지).
        const touched = new Set([
          ...(Array.isArray(res.distributed) ? res.distributed : []),
          ...(Array.isArray(res.failed) ? res.failed : []),
        ].map((x) => x && x.kind));
        for (const kind of due) {
          if (!touched.has(kind)) {
            failed.push({ articleId, targetId: null, kind, reason: NO_ACTIVE_TARGET });
          }
        }

        // 승격 근거는 **실제 스풀 기록에 성공한 kind**뿐이다 — 거짓 완결 금지.
        // 전 수신처가 실패하면(distributed=[]) 상태는 그대로 두고 failed로만 보고한다.
        const okKinds = [...new Set(
          (Array.isArray(res.distributed) ? res.distributed : [])
            .map((d) => d && d.kind)
            .filter((k) => typeof k === 'string'),
        )];
        if (okKinds.length === 0) continue;

        // distributedAt은 여기서 쓰지 않는다 — 배부 시각 갱신은 distributionService의 단일 책임이며
        // (SCHEMA.md:49) 배부가 실행될 때마다 최신 시각으로 갱신된다(1차 후 T1, 2차 후 T2).
        const status = syncStatus(articleId, okKinds, actorUserId, effective.status);
        distributed.push({ articleId, kinds: okKinds, status });
      } catch (e) {
        // 한 기사의 예외가 스캔 전체를 중단시키지 않는다. 응답에는 고정 토큰만 담고 원인은 로그로.
        notifyError({ articleId, error: e });
        failed.push({ articleId, targetId: null, kind: null, reason: TICK_FAILED });
      }
    }

    return { ok: true, at, scanned: candidates.length, distributed, failed, invalid };
  }

  return { run };
}
