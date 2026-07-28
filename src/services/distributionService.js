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

// 배부 대상 종류 — news.md 엠바고 규칙의 두 축(1차→언론사, 2차→비언론사).
const KINDS = ['press', 'nonpress'];

// onFailure(선택): 수신처 1곳의 스풀 기록 실패를 표면화한다(ftpWatcher.onError와 동형).
//   배부 호출자는 fire-and-forget이라 반환값을 보지 않으므로, 이 콜백이 없으면 미발송이 무음으로 사라진다.
// onDistributed(선택): 배부가 실제로 1건 이상 이뤄졌을 때 호출한다(SSE 무효화 재발행 훅).
//   송고 즉시 배부는 fire-and-forget이라 라우트가 notifyChange를 보낸 뒤 distributedAt이 기록된다 —
//   이 콜백이 없으면 목록의 배부시간이 즉시 갱신되지 않는다(handoff #2).
export function createDistributionService({
  distributionTargetModel,
  articleModel,
  historyModel,
  spoolWriter,
  now = () => new Date().toISOString(),
  onFailure,
  onDistributed,
}) {
  // 실패 알림 자체가 배부를 깨뜨리지 않도록 격리한다.
  function notifyFailure(info) {
    if (!onFailure) return;
    try { onFailure(info); } catch { /* 알림 실패는 배부를 막지 않는다 */ }
  }
  // 배부 완료 알림도 배부/호출자를 깨뜨리지 않도록 격리한다.
  function notifyDistributed(info) {
    if (!onDistributed) return;
    try { onDistributed(info); } catch { /* 알림 실패는 배부를 막지 않는다 */ }
  }
  // 이력 기록은 부가 기록이다 — 실패해도 이미 끝난 배부를 되돌리지 않는다(articleService.record와 동형).
  function record(rec) {
    if (!historyModel) return;
    try { historyModel.insert({ ...rec, createdAt: now() }); }
    catch { /* 이력 기록 실패는 배부를 막지 않는다 */ }
  }

  // 지금 이 kind들로 배부한다. 언제 부를지는 호출자가 정한다(송고 훅 / phase 48 tick).
  // 반환: { ok:true, distributed:[{targetId, kind, spoolDir, file}], failed:[{targetId, kind, reason}] }
  async function distribute(articleId, { kinds, actorUserId = null } = {}) {
    if (!spoolWriter) return { ok: false, reason: 'spool-disabled' };

    // 허용 밖 값·비배열은 조용히 걸러낸다(호출자 실수가 임의 폴더 배부로 이어지지 않게).
    const wanted = Array.isArray(kinds) ? KINDS.filter((k) => kinds.includes(k)) : [];
    if (wanted.length === 0) return { ok: true, distributed: [], failed: [] };

    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };

    const distributed = [];
    const failed = [];

    for (const kind of wanted) {
      // 비활성('N') 대상은 배부하지 않는다(SCHEMA.md — active='N'이면 배부 대상에서 제외).
      const targets = distributionTargetModel.query({ kind, active: 'Y' });
      let okInKind = 0;

      for (const t of targets) {
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
      // 배부 완료 → 목록의 배부시간 즉시 갱신을 위한 무효화 재발행(SSE). 이번에 성공한 kind만 알린다.
      notifyDistributed({ articleId, kinds: [...new Set(distributed.map((d) => d.kind))] });
    }

    return { ok: true, distributed, failed };
  }

  return { distribute };
}
