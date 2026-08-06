// 배부 실패 복구(재전송) 서비스 — ADR-008 MVP-4. 도메인 로직(HTTP·세션 비의존, ADR-006), 의존성은 전부 주입.
// 앱은 스풀 파일을 다시 쓸 뿐 네트워크 전송을 하지 않는다(egress 0). 여기에 타이머·자동 재시도·백오프를
// 두지 않는다: 복구 트리거는 Z의 명시적 조작뿐이다(ADR-008 (3)).
//
// 책임은 둘뿐이다:
//  (1) list  — 미해소 수신처 실패 목록의 파생 + 화이트리스트 투영(경로성 필드 미노출)
//  (2) retry — 그 수신처 한 곳에만 스풀 재기록 + 결과의 append-only 기록
//
// 책임이 아닌 것:
//  - 인가(Z 게이트)·HTTP shape → 컨트롤러/라우트(step4·5). 이 서비스는 세션을 모른다.
//  - 주기 실행·시점 판정(dueKinds) → 재전송은 새 배부 결정이 아니라 이미 내려진 결정의 복구다.
//    미해소 실패 행의 존재 자체가 "그 시점에 배부가 이미 지시됐다"는 사실 기록이므로 도래를 재판정하지 않는다.
//  - kind 단위 배부(전 수신처) → distributionService. 섞으면 tick 멱등·사이클 경계가 오염된다.
//  - 상태 전이 → 생애주기는 articleService가 단일 출처다(status는 읽기만 한다).

import { EMBARGO_DISTRIBUTABLE_STATUSES, cycleDistributedKinds } from './embargoPolicy.js';
import {
  DISTRIBUTE_FAILED_EVENT,
  DISTRIBUTE_RETRY_EVENT,
  isRetryableFailureReason,
  unresolvedFailures,
  findUnresolvedFailure,
} from './distributionFailureLog.js';

// 표시용 목록 창 — 최신 N건만 훑는다(보조 인덱스 없는 id DESC 스캔 + LIMIT, SCHEMA.md 비용 인식).
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;
// 재전송 게이트의 미해소 조회는 articleId 스코프 + 사실상 무제한이다 — 표시용 창을 그대로 쓰면
// 오래돼 창 밖으로 밀린 실패가 no-failure로 오거부된다(복구 불가). 한 기사로 좁혀져 있어 비용은 작다.
const RETRY_SCAN_LIMIT = 1000000;

function normalizeListLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIST_LIMIT;
  return Math.min(limit, MAX_LIST_LIMIT);
}

export function createDistributionRetryService({
  articleHistoryModel,
  distributionTargetModel,
  articleModel,
  spoolWriter,                 // 미주입(DIST_SPOOL_DIR 미설정) 시 retry는 spool-disabled, list는 정상
  now = () => new Date().toISOString(),
  onFailure,                   // 재전송 실패 표면화(distributionService.onFailure와 동형 — 식별자·사유만, 경로 금지)
  onHistoryError,              // 이력 insert 실패 표면화(어휘 분리 — onFailure로 흘리면 배부 실패로 오독된다)
} = {}) {
  function notifyFailure(info) {
    if (!onFailure) return;
    try { onFailure(info); } catch { /* 알림 실패는 재전송을 막지 않는다 */ }
  }
  function notifyHistoryError(info) {
    if (!onHistoryError) return;
    try { onHistoryError(info); } catch { /* 알림 실패는 재전송을 막지 않는다 */ }
  }
  // 이력 기록은 부가 기록이다 — 실패해도 이미 나간 재전송을 되돌리지 않는다(distributionService.record와 동형).
  function record(rec) {
    if (!articleHistoryModel) return;
    try { articleHistoryModel.insert({ ...rec, createdAt: now() }); }
    catch (err) {
      notifyHistoryError({
        articleId: rec?.articleId,
        eventType: rec?.eventType,
        action: rec?.action,
        reason: err?.message ?? String(err),
      });
    }
  }

  // 미해소 수신처 실패 목록 — Z 전용 조회의 유일한 경로(라우트 게이트는 step4·5).
  // 반환: { ok:true, items:[{ articleId, targetId, kind, reason, failedAt, historyId,
  //                           targetName, targetActive, targetKind, kindDistributed }] } (historyId DESC)
  // 투영은 화이트리스트다 — 모델 행 스프레드 금지(spoolDir가 새는 유일한 경로).
  function list({ limit } = {}) {
    const rows = articleHistoryModel.queryDistributionEvents({ limit: normalizeListLimit(limit) });
    const items = unresolvedFailures(rows);

    // kindDistributed = "다음 tick이 이 kind를 이미 배부됐다고 보는가" — tick의 실판정 함수
    // (cycleDistributedKinds, distributionTickService.distributedOf와 동일 입력)를 재사용한다.
    // ⚠️ distributedKinds(전체 이력) 금지: 재송고로 새 사이클이 열린 기사에서 이번 사이클 전량 실패가
    // 과거 사이클 배부 행에 가려져 true가 되고, 경고가 막으려던 중복 배부가 무경고로 지나간다.
    // 비용: distinct articleId 당 이력+status 조회 1회(캐시). 목록은 limit 상한이 있어 수용 가능.
    const articleCache = new Map();
    function tickView(articleId) {
      if (!articleCache.has(articleId)) {
        const row = articleModel.getById(articleId);
        articleCache.set(articleId, {
          status: row && row.contents ? row.contents.status : undefined,
          historyRows: articleHistoryModel.queryByArticle(articleId),
        });
      }
      return articleCache.get(articleId);
    }

    return {
      ok: true,
      items: items.map((it) => {
        const target = distributionTargetModel.findById(it.targetId);
        const view = tickView(it.articleId);
        return {
          articleId: it.articleId,
          targetId: it.targetId,
          kind: it.kind,
          reason: it.reason,
          failedAt: it.failedAt,
          historyId: it.historyId,
          // 대상 행 부재(방어) 폴백: 이름·kind는 null, active는 'N'(재전송 불가 쪽으로).
          targetName: target ? target.name ?? null : null,
          targetActive: target ? target.active ?? 'N' : 'N',
          targetKind: target ? target.kind ?? null : null,
          kindDistributed: cycleDistributedKinds({ status: view.status, historyRows: view.historyRows })
            .includes(it.kind),
        };
      }),
    };
  }

  // 실패한 수신처 한 곳에만 기사 파일을 다시 쓴다. 게이트 순서는 부작용 없는 판정 → 쓰기다:
  // (a) spoolWriter 유무 (b) 미해소 실패 존재 (c) 대상 존재/활성 (d) 대상 현재 kind == 실패 kind
  // (e) 기사 존재 (f) status allowlist (g) write. 어떤 거부 경로에서도 write는 호출되지 않는다.
  // kind는 클라이언트 입력이 아니라 실패 행의 action에서만 도출한다(ADR-004).
  // 게이트 거부는 이력을 남기지 않는다 — 배부를 시도조차 하지 않았으므로 사실 기록이 아니다.
  async function retry({ articleId, targetId, actorUserId = null } = {}) {
    // (a) 스풀 미설정 — DB를 건드리지 않는다.
    if (!spoolWriter) return { ok: false, reason: 'spool-disabled' };

    // (b) 미해소 실패 존재 — 없으면 임의 기사를 임의 수신처로 내보내는 경로가 된다(이 게이트가 보안 핵심).
    // 조회는 articleId 스코프 + 사실상 무제한(RETRY_SCAN_LIMIT) — 표시용 창과 다르다(위 상수 주석).
    const rows = articleHistoryModel.queryDistributionEvents({ articleId, limit: RETRY_SCAN_LIMIT });
    const failure = findUnresolvedFailure(rows, { articleId, targetId });
    if (!failure) return { ok: false, reason: 'no-failure' };

    // (c) 대상 존재/활성 — 비활성 수신처는 배부 대상이 아니다(SCHEMA.md).
    const target = distributionTargetModel.findById(failure.targetId);
    if (!target) return { ok: false, reason: 'not-found' };
    if (target.active !== 'Y') return { ok: false, reason: 'inactive' };

    // (d) 대상의 현재 kind == 실패 이력의 kind — 엄격 비교(trim·소문자 관용 금지).
    // 실패 이력의 kind는 "그때의 분류", 스풀 대상은 "지금의 분류"다. 어긋나면 아무것도 보내지 않는다:
    // press 실패 → nonpress 재분류 → 재전송이면 2차 엠바고 전에 비언론사로 나가고(회수 불가),
    // 이력에는 press가 남아 tick이 같은 수신처에 중복 배부한다.
    if (target.kind !== failure.kind) return { ok: false, reason: 'kind-changed' };

    // (e) 기사 존재 — 페이로드는 항상 현재 DB 행이다(호출자가 준 값이 아니다, ADR-004).
    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };

    // (f) 배부 가능 status — allowlist는 embargoPolicy가 단일 출처다(복제 금지).
    // KILL·보류·삭제 승인 기사는 회수 수단이 없으므로 재전송하지 않는다.
    if (!EMBARGO_DISTRIBUTABLE_STATUSES.includes(row.contents.status)) {
      return { ok: false, reason: 'status-changed' };
    }

    // (g) 스풀 재기록 — writer는 throw하지 않는 계약이지만 방어적으로 감싼다(예외 원문 비노출).
    let res;
    try {
      res = await spoolWriter.write({
        spoolDir: target.spoolDir,
        articleId,
        article: row.article,
        contents: row.contents,
      });
    } catch {
      res = { ok: false, reason: 'spool-write-failed' };
    }

    if (!res || res.ok !== true) {
      const reason = typeof res?.reason === 'string' ? res.reason : 'spool-write-failed';
      // 재전송 실패도 새 distribute-failed 행으로 append — 그룹 최신이 다시 실패가 되어 목록에 남는다.
      // 기록 조건은 distributionService와 동일한 단일 술어다(재전송 가능 사유만).
      if (isRetryableFailureReason(reason)) {
        record({
          articleId, eventType: DISTRIBUTE_FAILED_EVENT, action: failure.kind,
          targetId: failure.targetId, reason, actorUserId,
        });
      }
      notifyFailure({ articleId, targetId: failure.targetId, kind: failure.kind, reason });
      return { ok: false, reason };
    }

    // 성공 — 해소를 새 행으로 기록하고(원장 append-only), 배부 시각을 present-only로 갱신한다
    // (SCHEMA.md: distributedAt은 배부가 실행될 때마다 최신 시각 — 스풀 파일이 실제로 나갔다).
    const at = now();
    record({
      articleId, eventType: DISTRIBUTE_RETRY_EVENT, action: failure.kind,
      targetId: failure.targetId, actorUserId,
    });
    articleModel.update(articleId, { contents: { distributedAt: at } });
    // 반환에 file·spoolDir를 싣지 않는다 — 서버 파일시스템 경로는 HTTP로 나가면 안 된다.
    return { ok: true, articleId, targetId: failure.targetId, kind: failure.kind, at };
  }

  return { list, retry };
}
