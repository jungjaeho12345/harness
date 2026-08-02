// 기사 서비스 — 도메인 로직 (HTTP 비의존, ADR-006). 의존성은 주입(articleModel, db).
// 생애주기 전이는 lifecycle.transition을 따르고, 송고 가드/잠금 정책을 여기서 강제한다.
// role은 항상 인자로 받는다(클라이언트 신뢰 아님 — 신뢰 검증은 step8 HTTP 계층).

import { generateArticleId } from '../db/articleId.js';
import { transition, initialStatus } from './lifecycle.js';
import { sanitizeFileRef } from './fileRef.js';
import { requiredKinds, distributedKinds, embargoStatusFor } from './embargoPolicy.js';
import { toPublicContents } from './contentsProjection.js';

// 30분 무갱신이면 stale 잠금으로 보고 다음 시도자가 가져갈 수 있다.
const LOCK_TTL_MS = 30 * 60 * 1000;

// Article 테이블에 들어가는 필드(본문 마크업).
const ARTICLE_FIELDS = ['title', 'markupVersion', 'modifier'];
// Contents 테이블에 들어가는 공통정보/메타 필드. status·시간·잠금은 서비스가 직접 관리한다.
const CONTENTS_FIELDS = [
  'title', 'author', 'modifier', 'department', 'departmentCode',
  'embargoAt', 'secondEmbargoAt',
  'coAuthor', 'category', 'region', 'attribute', 'keyword',
  'internalComment', 'externalComment', 'attachmentFile', 'referenceFile',
];

function pick(src, fields) {
  const out = {};
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

function nowISO() {
  return new Date().toISOString();
}

// 본문 블록 마지막에 "(끝)" 마커가 있는지 검사한다.
// 본문은 Article.markupVersion에 블록 JSON으로 저장된다({...,"blocks":[{text}...]}).
// 파싱 실패 시(또는 평문 레거시) 문자열로 취급해 "(끝)" 포함 여부를 본다.
function hasEndMarker(article) {
  const raw = article && article.markupVersion;
  if (!raw) return false;
  let text = String(raw);
  try {
    const doc = JSON.parse(raw);
    if (doc && Array.isArray(doc.blocks)) {
      text = doc.blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
    }
  } catch {
    // 평문으로 취급 — text는 이미 raw.
  }
  return text.includes('(끝)');
}

function isStale(lockedAt) {
  if (!lockedAt) return true;
  const t = Date.parse(lockedAt);
  if (Number.isNaN(t)) return true;
  return (Date.now() - t) > LOCK_TTL_MS;
}

// 첨부/자료 파일 참조 스킴 방어 규칙은 fileRef.js(sanitizeFileRef)가 단일 출처다 —
// 사진DB src(photoService)와 공유한다(재현 금지 — 발산하면 우회 벡터).
// present인 파일참조 필드만 sanitizeFileRef로 대체한다.
// 미전달(undefined) 필드는 절대 추가·변경하지 않는다 — 모델의 present-only SET과 함께 DB 비파괴 보장.
const FILE_REF_FIELDS = ['attachmentFile', 'referenceFile'];
function sanitizeFileRefFields(contents) {
  for (const f of FILE_REF_FIELDS) {
    if (contents[f] !== undefined) contents[f] = sanitizeFileRef(contents[f]);
  }
  return contents;
}

// 송고 성공 시 "지금 즉시" 배부할 대상 종류를 정한다 — news.md "엠바고 규칙" + ADR-008 (4)의 직역.
//   엠바고 없음 → DPS      : 언론사 + 비언론사 전체 즉시 배부
//   엠바고 설정 → DPS      : (레거시 DDH 경로 잔존 행 / 완결 후 고침의 재송고) 이미 배부된 kind에만
//                            정정본을 보낸다 — 미도래분은 tick의 책임. 시각 비교는 여전히 하지 않는다.
//   2차 엠바고만 → DES     : 송고 시 바로 언론사(press). 비언론사는 2차 시각에(phase 48 tick)
//   1차 / 1+2차 → DES      : 즉시 배부 없음 — 1차 시각에 언론사, 2차 시각에 비언론사(phase 48 tick)
//   그 외(R의 RDS 유지 등) : 배부 없음
// 송고 직후 상태는 DES뿐이다(EPS는 배부가 실제 실행된 뒤 syncEmbargoStatus가 만든다) — EPS 분기를 두면
// 두 상태가 같은 의미인 것처럼 오독된다. 레거시 EPS 행은 lifecycle에 EPS.send가 없어 여기까지 오지 못한다.
// "지금이 엠바고 시각인가"는 여기서 판단하지 않는다(시점 판정은 tick의 책임 — 시각 비교 금지).
// distributed: 이 기사에서 이미 배부된 kind 목록(= embargoPolicy.distributedKinds(이력)). 조회는 호출자 책임.
// 엠바고 설정 판정은 embargoPolicy.requiredKinds가 단일 출처다(!!contents.embargoAt 식 재구현 금지).
export function distributionKindsForSend(status, contents = {}, distributed = []) {
  if (status === 'DPS') {
    if (requiredKinds(contents).length === 0) return ['press', 'nonpress'];
    const done = Array.isArray(distributed) ? distributed : [];
    return ['press', 'nonpress'].filter((kind) => done.includes(kind));
  }
  if (status === 'DES' && !contents.embargoAt && contents.secondEmbargoAt) return ['press'];
  return [];
}

// 송고 시 DES(엠바고 배부 대기)로 진입할 수 있는 이전 상태 — news.md·사용자 확정 스펙의 진입 경로뿐이다.
// DPS 재송고(고침/포털고침 후 재송)를 포함하지 않는 이유: 이미 배부 이력이 있는 기사를 DES로 되돌리면
// tick의 "미배부" 판정에 걸리지 않아 영구 DES 고착이 된다(복구 수단 없음).
const DES_ENTRY_STATUSES = new Set(['RDS', 'DDH']);

// distributionService(선택): 미주입이면 배부 훅이 비활성이며 송고는 기존과 동일하게 동작한다.
export function createArticleService({ articleModel, db, historyModel, distributionService }) {
  // 이력 기록 헬퍼 — 부가 기록이므로 본 기능(편집/전이)을 막지 않는다.
  // historyModel 미주입 시 건너뛰고, insert 실패는 try/catch로 격리한다.
  function record(rec) {
    if (!historyModel) return;
    try { historyModel.insert({ ...rec, createdAt: nowISO() }); }
    catch { /* 이력 기록 실패는 본 기능을 막지 않는다 */ }
  }

  // 신규 기사 — articleId 생성, 초기 status 결정, Article+Contents 트랜잭션 저장.
  // 초기 status는 세션 role + 의도 action으로 결정한다(initialStatus, 기본 RDS / (Z|D)+hold→DDH, R+hold→RRH).
  // 옵션 미전달 시(deriveArticle 등 기존 호출) role/action=undefined → RDS 유지(하위호환).
  function create(dto = {}, { role, action } = {}) {
    const articleId = generateArticleId(db);
    const article = { articleId, ...pick(dto, ARTICLE_FIELDS) };
    const createdAt = nowISO();
    const contents = sanitizeFileRefFields({
      articleId,
      ...pick(dto, CONTENTS_FIELDS),
      status: initialStatus(role, action),
      createdAt,
    });
    articleModel.insert({ article, contents });
    return { ok: true, articleId };
  }

  // 부분 업데이트(트랜잭션). status 전이는 다루지 않는다(applyAction 전용).
  // 잠금 보유 검증은 호출자(HTTP) 책임.
  function update(articleId, fields = {}) {
    const editedAt = nowISO();
    const changes = articleModel.update(articleId, {
      article: pick(fields, ARTICLE_FIELDS),
      contents: sanitizeFileRefFields({ ...pick(fields, CONTENTS_FIELDS), editedAt }),
    });
    // 편집 성공 후 이력 기록. actor는 호출자가 stamp한 modifier(세션 userId — step2).
    // 이 편집에서 저장되는 본문을 스냅샷으로 함께 기록한다(기사이력비교 — 메타 전용 편집이면 undefined → NULL).
    record({ articleId, eventType: 'edit', actorUserId: fields.modifier, markupVersion: fields.markupVersion });
    return { ok: true, changes };
  }

  // --- 읽기 경로: Contents 행이 응답으로 나가는 단일 투영 지점이다 ---
  // 아래 3개 함수(getById/query/search)만 클라이언트로 나가는 행을 만든다. 세션 토큰(lockerSessionId)·
  // 편집 탭 식별자(lockerClientId) 제거는 여기서만 한다 — 라우트/컨트롤러에서 개별 삭제 금지
  // (새 라우트에서 반드시 누락된다). 제거 목록의 단일 출처는 contentsProjection.PRIVATE_CONTENTS_COLS다.
  // 내부 판정 경로(acquireEditLock·assertLockHolder·applyAction·syncEmbargoStatus·deriveArticle)는
  // articleModel.getById를 직접 부르므로 이 투영의 영향을 받지 않는다(잠금 takeover 판정 보존).

  // 단건 조회 — 본문(Article.markupVersion)을 포함한 { article, contents }(없으면 null). 읽기 전용.
  function getById(articleId) {
    const row = articleModel.getById(articleId);
    if (!row) return null;
    return { ...row, contents: toPublicContents(row.contents) };
  }

  function query(filters) {
    return articleModel.query(filters).map((contents) => toPublicContents(contents));
  }

  // Article 행에는 잠금 컬럼이 없다(스키마) — 같은 투영을 통과시켜 검색 응답도 동일 규율 아래 둔다.
  function search(q) {
    return articleModel.searchByText(q).map((row) => toPublicContents(row));
  }

  // 생애주기 액션 적용 — transition으로 다음 status를 구하고 갱신한다.
  // send는 본문에 "(끝)" 마커가 있어야 한다. hold/kill/approveDelete은 불필요.
  function applyAction(articleId, role, action, { userId } = {}) {
    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };

    const result = transition(row.contents.status, role, action);
    if (!result.ok) return result;

    if (action === 'send' && !hasEndMarker(row.article)) {
      return { ok: false, reason: 'no-end-marker' };
    }

    // 엠바고 송고 진입(RDS·DDH → DES): 데스크(D/Z)가 엠바고 시간이 설정된 기사를 송고하면 DPS 대신 DES.
    // transition은 순수하게 유지하고(RDS/DDH + D/Z + send = DPS), 여기서만 후처리한다(news.md 엠바고 규칙).
    // DDH 경로를 포함하는 이유: 보류된 엠바고 기사도 송고 순간은 "엠바고 배부 대기"다 —
    // 빠지면 엠바고 기사가 DPS로 떨어져 press·nonpress 전량이 즉시 배부된다(엠바고 누수).
    // 엠바고 유형(1/2/1+2차)은 두 시간 컬럼 조합으로 도출되므로 별도 컬럼 없이 set 여부만 본다(DB 비파괴).
    // 판정은 DB에 저장된 값으로만 한다(클라이언트 값 불신 — ADR-004).
    let finalStatus = result.status;
    const embargoSet = !!(row.contents.embargoAt || row.contents.secondEmbargoAt);
    if (action === 'send' && DES_ENTRY_STATUSES.has(row.contents.status)
      && (role === 'D' || role === 'Z') && result.status === 'DPS' && embargoSet) {
      finalStatus = 'DES';
    }

    const contents = { status: finalStatus };
    if (action === 'send') {
      contents.sender = userId ?? null;
      contents.sentAt = nowISO();
    }
    articleModel.update(articleId, { contents });
    // 전이 성공 직후 이력 기록(거부/no-end-marker 경로는 이미 위에서 반환됨).
    record({
      articleId,
      eventType: 'status',
      action,
      fromStatus: row.contents.status,
      toStatus: finalStatus,
      actorUserId: userId ?? null,
    });

    // 송고 성공 직후 즉시 배부(ADR-008). 부수효과이므로:
    //  - applyAction의 동기 반환 계약을 바꾸지 않는다(라우트/기존 테스트가 await 없이 호출한다).
    //  - 배부 실패가 송고(상태 전이)를 되돌리지 않는다 — 스풀 쓰기 실패로 기사가 묶이면 복구 수단이 없다.
    // 엠바고 판정은 DB에 반영된 최종 status와 DB의 엠바고 컬럼으로만 한다(클라이언트 값 불신 — ADR-004).
    if (action === 'send' && distributionService) {
      try {
        // 이력 조회 실패·미주입은 "아는 배부 이력 없음([])"으로 폴백한다.
        // → 엠바고가 설정된 DPS 재송고에서는 곧바로 kinds=[](배부 없음)가 되어 안전 기본값이 성립한다.
        // 엠바고 미설정 기사는 distributed를 참조하지 않으므로 조회 장애가 일반 배부를 막지 않는다.
        let already = [];
        try { if (historyModel) already = distributedKinds(historyModel.queryByArticle(articleId)); }
        catch { already = []; }

        const kinds = distributionKindsForSend(finalStatus, row.contents, already);
        if (kinds.length > 0) {
          Promise.resolve(distributionService.distribute(articleId, { kinds, actorUserId: userId ?? null }))
            .then((res) => {
              // 승격 근거는 distributed(실제 스풀 기록 성공 목록)뿐이다.
              // res.ok만 보면 { ok:true, distributed:[], failed:[...] }(전 수신처 쓰기 실패)에도 승격이 일어나
              // 배부되지 않은 기사가 완결 처리된다. { ok:false, reason }에는 distributed 자체가 없다.
              if (!res || res.ok !== true || !Array.isArray(res.distributed) || res.distributed.length === 0) return;
              const doneKinds = [...new Set(res.distributed.map((d) => d && d.kind).filter(Boolean))];
              syncEmbargoStatus(articleId, { extraKinds: doneKinds, actorUserId: userId ?? null });
            })
            .catch(() => { /* 배부 실패는 송고를 막지 않는다(발송 결과는 앱이 알지 못한다 — ADR-008) */ });
        }
      } catch { /* 배부 지시 실패(동기 throw)는 송고를 막지 않는다(기존 격리 정책) */ }
    }
    return { ok: true, status: finalStatus };
  }

  // 배부 사실을 기사 상태에 반영한다(DES→EPS→DPS). 호출자는 송고 훅과 엠바고 tick(phase 48)이다.
  // transition()을 거치지 않는 이유: 전이표는 role×action 표인데 여기엔 role도 action도 없다 —
  // 사람의 액션이 아니라 "이미 일어난 배부"의 반영이다. 대신 허용 범위는 embargoPolicy.embargoStatusFor가
  // DES/EPS에서만 계산하도록 좁혀 강제한다(RDS·DPS·EEK·EEH·DPD 등은 절대 건드리지 않는다).
  // extraKinds: 방금 성공한 배부의 kind 힌트 — distributionService의 이력 기록은 실패를 삼키므로
  //   이력만 읽으면 승격이 누락될 수 있다. 반대로 힌트만 보면 tick의 self-heal이 무력해진다 → 합집합.
  function syncEmbargoStatus(articleId, { extraKinds = [], actorUserId = null } = {}) {
    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };

    const fromStatus = row.contents.status;
    const history = historyModel ? historyModel.queryByArticle(articleId) : [];
    const distributed = [...new Set([
      ...distributedKinds(history),
      ...(Array.isArray(extraKinds) ? extraKinds : []),
    ])];

    const next = embargoStatusFor({ status: fromStatus, contents: row.contents, distributed });
    if (!next) return { ok: true, status: fromStatus }; // 바꿀 필요 없음 — 쓰기 0건.

    // present-only 업데이트: status만 쓴다(sentAt·sender·본문·잠금은 절대 함께 쓰지 않는다 — DB 비파괴).
    articleModel.update(articleId, { contents: { status: next } });
    record({ articleId, eventType: 'status', action: 'embargo', fromStatus, toStatus: next, actorUserId });
    return { ok: true, status: next };
  }

  // 후속기사작성(followUp)/계속기사작성(continue) — 원본을 바탕으로 "새 기사"를 작성한다.
  // 항상 create()로만 신규 행을 만든다(새 articleId·status RDS·트랜잭션) — 원본은 절대 변경하지 않는다(DB 비파괴, ADR-002).
  // 명세 근거: news.md 85행은 두 메뉴만 언급하고 필드 복사 규칙을 명시하지 않는다.
  // 아래 규칙은 편집 진입 매핑(news.md 201행)과 "최초 작성=새 articleId·status RDS"(news.md 206행)에서
  // 도출한 합리적 정의다. 특히 followUp의 본문 빈값 vs continue의 본문 복사는 news.md 직접 근거가 없는 도출이다.
  //  - followUp(후속): 주제만 이어받아 새로 작성 → 본문 빈값.
  //  - continue(계속): 원문에서 이어쓰기 → 본문 복사.
  // overrides.author만 신뢰 가능 값으로 취급한다(HTTP가 세션 사용자로 stamp — step4, ADR-004).
  // 클라이언트가 보낸 status/sender/articleId 등은 무시한다(create가 강제·새 발급).
  function deriveArticle(sourceArticleId, mode, overrides = {}) {
    if (mode !== 'followUp' && mode !== 'continue') return { ok: false, reason: 'unknown-mode' };

    const src = articleModel.getById(sourceArticleId);
    if (!src || !src.contents) return { ok: false, reason: 'not-found' };

    const srcArticle = src.article ?? {};
    const srcContents = src.contents ?? {};

    const dto = {
      // 제목은 둘 다 출발점으로 복사한다(작성자가 수정).
      title: srcArticle.title,
      // followUp=빈 본문(새로 작성) / continue=원본 본문 복사. (news.md 명세 부재 — 합리적 도출)
      markupVersion: mode === 'followUp' ? '' : (srcArticle.markupVersion ?? ''),
      // 새 기사의 작성자는 파생을 실행한 사람 — HTTP가 세션 사용자로 채운다(step4).
      author: overrides.author,
      // 공통정보/메타는 출발점으로 복사한다.
      ...pick(srcContents, [
        'coAuthor', 'category', 'region', 'attribute', 'keyword',
        'internalComment', 'externalComment', 'attachmentFile', 'referenceFile',
      ]),
      // 엠바고는 새 기사에서 새로 설정한다 — 초기화(빈 값).
      embargoAt: '',
      secondEmbargoAt: '',
    };
    // status(RDS)·sender·sentAt·editedAt·distributedAt·잠금 컬럼·articleId는 dto에 넣지 않는다.
    // → create가 새 articleId·RDS를 강제하고, 송고/배부/잠금 이력은 신규 기사에 없다.
    return create(dto);
  }

  // 이력 조회 — 모델에 얇게 위임. 송고이력 필터(sendOnly)는 도메인 규칙이므로 서비스에서 처리.
  function queryHistory(articleId, { sendOnly = false } = {}) {
    if (!historyModel) return [];
    const rows = historyModel.queryByArticle(articleId);
    if (!sendOnly) return rows;
    return rows.filter((r) => r.eventType === 'status' && r.action === 'send');
  }

  // 단건 이력 스냅샷 조회 — 본문(markupVersion) 포함. 기사이력비교가 사용자가 고른 스냅샷만 지연 조회한다.
  // articleId 스코프는 모델이 강제한다(타 기사 스냅샷 유출 방지). 읽기 전용.
  function getHistorySnapshot(articleId, historyId) {
    if (!historyModel) return { ok: false, reason: 'not-found' };
    const item = historyModel.querySnapshotById(articleId, historyId);
    if (!item) return { ok: false, reason: 'not-found' };
    return { ok: true, item };
  }

  // 편집 잠금 — 보유자는 편집 탭(clientId)이다. 잠겨 있어도 stale(30분 무갱신)이면 가져갈 수 있다.
  // 획득 실패 시 누가 잠갔는지는 노출하지 않는다.
  // 일관된 a/b/c 모델:
  //  - 같은 탭(clientId)의 재획득(F5 새로고침)은 허용한다.
  //  - (b) 같은 사용자가 다른 세션으로 재로그인하면(이전 세션 만료) takeover를 허용한다.
  //  - (c) 같은 세션의 "다른 탭"은 차단한다(서로 다른 clientId — 한 사용자가 여러 탭에서 동시 편집 금지).
  //  - 그 외 다른 사용자는 차단한다.
  function acquireEditLock(articleId, { userId, sessionId, clientId } = {}) {
    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };

    const c = row.contents;
    const held = c.lockYN === 'Y' && c.lockerClientId;
    if (held && !isStale(c.lockedAt)) {
      // 같은 탭(clientId)이면 재획득(F5 새로고침) — 허용.
      const sameClient = c.lockerClientId === clientId;
      // (b) 같은 사용자가 다른 세션으로 재로그인 — 이전 세션은 만료된 것으로 보고 takeover 허용.
      const sameUserReLogin = c.lockerUserId === userId && c.lockerSessionId !== sessionId;
      // (c) 같은 세션의 다른 탭 등 그 외는 차단(다른 사용자 포함).
      if (!sameClient && !sameUserReLogin) return { ok: false, reason: 'locked' };
    }

    articleModel.setLock(articleId, {
      lockerUserId: userId ?? null,
      lockerSessionId: sessionId ?? null,
      lockerClientId: clientId ?? null,
      lockedAt: nowISO(),
    });
    return { ok: true };
  }

  // 보유 탭(clientId)만 해제한다. 이미 해제된 잠금 해제는 멱등(ok).
  function releaseEditLock(articleId, { clientId } = {}) {
    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };

    const c = row.contents;
    if (c.lockYN !== 'Y') return { ok: true };
    if (c.lockerClientId && c.lockerClientId !== clientId) return { ok: false, reason: 'not-holder' };

    articleModel.clearLock(articleId);
    return { ok: true };
  }

  // 강제 해제 — 보유자와 무관하게 해제한다. 권한(D/Z) 게이트는 HTTP 계층 책임.
  function forceReleaseEditLock(articleId) {
    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };
    articleModel.clearLock(articleId);
    return { ok: true };
  }

  // 해당 편집 탭(clientId)이 잠금 보유자인지 — 편집 저장 권한 검증에 쓴다.
  // 보유 탭만 저장할 수 있다(같은 세션의 2번째 탭은 저장 차단).
  function assertLockHolder(articleId, { clientId } = {}) {
    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };

    const c = row.contents;
    if (c.lockYN === 'Y' && c.lockerClientId === clientId) return { ok: true };
    return { ok: false, reason: 'not-holder' };
  }

  return {
    create, update, getById, query, search, applyAction, syncEmbargoStatus, deriveArticle, queryHistory,
    getHistorySnapshot,
    acquireEditLock, releaseEditLock, forceReleaseEditLock, assertLockHolder,
  };
}
