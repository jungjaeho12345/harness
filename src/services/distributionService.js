// 배부 실행 서비스 — 도메인 로직 (HTTP 비의존, ADR-006). 의존성은 주입.
// ADR-008: 앱은 수신처별 스풀 폴더에 파일을 쓰기만 하고(egress 없음), 발송은 외부 전송기가 한다.
//
// 책임은 셋뿐이다:
//  (1) 주어진 kind의 **활성** DistributionTarget 선정
//  (2) 수신처별 스풀 파일 쓰기(주입된 spoolWriter — 파일 shape/allowlist는 그쪽이 단일 출처)
//  (3) 사실 기록 — Contents.distributedAt 갱신 + ArticleHistory 배부 이력(append-only)
//
// 책임이 아닌 것(넘겨받거나 다음 phase):
//  - "지금이 엠바고 시각인가" 시점 판정과 주기 실행 → phase 48의 tick pull(ADR-008 (3)). 여기엔 타이머가 없다.
//  - 엠바고 유형 판정("어떤 kind로 배부할지") → 호출자(articleService 송고 훅)가 정해서 kinds로 넘긴다.
//  - 상태 전이(EPS→DPS) → 생애주기는 lifecycle/articleService가 단일 출처다.
//    쓰기 직전 status 재확인(아래 TOCTOU 가드)은 전이가 아니라 **배부 안전 중단**이다 — status를 읽기만 한다.

import { EMBARGO_DISTRIBUTABLE_STATUSES } from './embargoPolicy.js';

// 배부 대상 종류 — news.md 엠바고 규칙의 두 축(1차→언론사, 2차→비언론사).
const KINDS = ['press', 'nonpress'];

// 배부 중 상태가 배부 가능 목록 밖으로 전이돼 중단된 항목의 사유 토큰.
// distributionTickService의 재검증 스킵과 같은 어휘다(운영 요약 통일 — tick이 failed를 HTTP로 투영한다).
// 새 상태값(EEK/EEH/DPD 등)은 담지 않는다 — 요약은 식별자·고정 사유만 담는 화이트리스트다.
const STATUS_CHANGED = 'status-changed';

// 최신 행이 배부 가능한 상태인가. allowlist는 embargoPolicy가 단일 출처다(복제 금지).
function isDistributable(row) {
  return Boolean(row && row.contents && EMBARGO_DISTRIBUTABLE_STATUSES.includes(row.contents.status));
}

// onFailure(선택): 수신처 1곳의 스풀 기록 실패를 표면화한다(ftpWatcher.onError와 동형).
//   배부 호출자는 fire-and-forget이라 반환값을 보지 않으므로, 이 콜백이 없으면 미발송이 무음으로 사라진다.
export function createDistributionService({
  distributionTargetModel,
  articleModel,
  historyModel,
  spoolWriter,
  now = () => new Date().toISOString(),
  onFailure,
}) {
  // 실패 알림 자체가 배부를 깨뜨리지 않도록 격리한다.
  function notifyFailure(info) {
    if (!onFailure) return;
    try { onFailure(info); } catch { /* 알림 실패는 배부를 막지 않는다 */ }
  }
  // 이력 기록은 부가 기록이다 — 실패해도 이미 끝난 배부를 되돌리지 않는다(articleService.record와 동형).
  function record(rec) {
    if (!historyModel) return;
    try { historyModel.insert({ ...rec, createdAt: now() }); }
    catch { /* 이력 기록 실패는 배부를 막지 않는다 */ }
  }

  // 지금 이 kind들로 배부한다. 언제 부를지는 호출자가 정한다(송고 훅 / phase 48 tick).
  // 반환: { ok:true, distributed:[{targetId, kind, spoolDir, file}], failed:[{targetId, kind, reason}] }
  //       (상태 가드 중단 시 failed에 시작도 못 한 kind가 targetId:null 항목으로 추가된다)
  // 비용 인식(의도적 수용): TOCTOU 가드로 수신처 수만큼 getById 읽기가 늘어난다(N+1).
  // in-process SQLite 단건 조회라 비용이 작고, 회수 불가능한 KILL 기사 유출을 막는 가치가 압도한다.
  async function distribute(articleId, { kinds, actorUserId = null } = {}) {
    if (!spoolWriter) return { ok: false, reason: 'spool-disabled' };

    // 허용 밖 값·비배열은 조용히 걸러낸다(호출자 실수가 임의 폴더 배부로 이어지지 않게).
    const wanted = Array.isArray(kinds) ? KINDS.filter((k) => kinds.includes(k)) : [];
    if (wanted.length === 0) return { ok: true, distributed: [], failed: [] };

    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };

    const distributed = [];
    const failed = [];
    // 상태 가드에 걸리면 남은 수신처·남은 kind 전부를 중단한다 —
    // 배부 불가로 전이된 기사는 어떤 kind로도 나가면 안 된다.
    let aborted = false;

    // 중단된 항목도 failed에 남기고 onFailure로 표면화한다(무음 삼킴 금지 — 기존 실패 정책과 동일).
    function abortEntry(info) {
      failed.push(info);
      notifyFailure(info);
    }

    for (const kind of wanted) {
      // 앞선 kind에서 가드가 걸렸다 — 이 kind는 시작하지 않는다. 그래도 failed에 남겨야 한다:
      // tick은 distributed∪failed에 등장한 kind만 "처리됨"으로 보므로, 빠뜨리면 활성 수신처가
      // 있는데도 no-active-target으로 오보한다(distributionTickService.js touched 판정).
      if (aborted) {
        abortEntry({ articleId, targetId: null, kind, reason: STATUS_CHANGED });
        continue;
      }

      // 비활성('N') 대상은 배부하지 않는다(SCHEMA.md — active='N'이면 배부 대상에서 제외).
      const targets = distributionTargetModel.query({ kind, active: 'Y' });
      let okInKind = 0;

      for (let i = 0; i < targets.length; i += 1) {
        const t = targets[i];
        // TOCTOU 가드: 앞 수신처의 await 동안 KILL(EEK)·보류(EEH)·삭제 승인(DPD)으로 전이됐을 수 있다.
        // 한 번 나간 기사는 회수 수단이 없으므로 매 쓰기 직전 최신 status를 재확인한다.
        // 재조회는 status 판정 전용이다 — 페이로드는 최초 스냅샷(row)을 계속 쓴다
        // (한 배부 배치는 같은 본문을 내보내야 정정 추적이 가능하다).
        if (!isDistributable(articleModel.getById(articleId))) {
          aborted = true;
          if (i === 0) {
            // 이 kind는 쓰기를 하나도 시작하지 않았다 — kind 단위 항목(targetId:null)로 남긴다.
            abortEntry({ articleId, targetId: null, kind, reason: STATUS_CHANGED });
          } else {
            // 처리하지 못하고 남은 수신처들 — 기존 failed 항목과 같은 shape로 남긴다.
            for (const rest of targets.slice(i)) {
              abortEntry({ articleId, targetId: rest.id, kind, spoolDir: rest.spoolDir, reason: STATUS_CHANGED });
            }
          }
          break;
        }

        // 한 수신처의 실패가 다른 수신처를 막지 않는다 — writer는 throw하지 않지만 방어적으로 감싼다.
        let res;
        try {
          res = await spoolWriter.write({
            spoolDir: t.spoolDir,
            articleId,
            article: row.article,
            contents: row.contents,
          });
        } catch {
          res = { ok: false, reason: 'spool-write-failed' };
        }

        if (res && res.ok) {
          okInKind += 1;
          distributed.push({ targetId: t.id, kind, spoolDir: t.spoolDir, file: res.file });
        } else {
          const info = { articleId, targetId: t.id, kind, spoolDir: t.spoolDir, reason: res?.reason ?? 'spool-write-failed' };
          failed.push(info);
          // 미발송은 운영자가 알아야 한다 — 무음 삼킴 금지(재전송은 후속 MVP-4).
          notifyFailure(info);
        }
      }

      // 실제로 스풀에 기록된 게 있을 때만 이력을 남긴다 — 거짓 기록 금지.
      // 이 행(eventType='distribute', action=kind)이 phase 48 tick의 "이미 배부됨" 판정 근거가 된다.
      if (okInKind > 0) {
        record({ articleId, eventType: 'distribute', action: kind, actorUserId });
      }
    }

    // 배부 지시가 1건이라도 성공하면 배부 시각을 갱신한다(ADR-008: 스풀 기록 시각 = distributedAt).
    // 과거 배부 사실은 ArticleHistory에 append-only로 남으므로 정보 손실이 없다.
    // present-only 업데이트라 status·sentAt·본문 등 다른 컬럼은 건드리지 않는다(DB 비파괴).
    if (distributed.length > 0) {
      articleModel.update(articleId, { contents: { distributedAt: now() } });
    }

    return { ok: true, distributed, failed };
  }

  return { distribute };
}
