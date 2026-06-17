// 기사 서비스 — 도메인 로직 (HTTP 비의존, ADR-006). 의존성은 주입(articleModel, db).
// 생애주기 전이는 lifecycle.transition을 따르고, 송고 가드/잠금 정책을 여기서 강제한다.
// role은 항상 인자로 받는다(클라이언트 신뢰 아님 — 신뢰 검증은 step8 HTTP 계층).

import { generateArticleId } from '../db/articleId.js';
import { transition } from './lifecycle.js';

// 30분 무갱신이면 stale 잠금으로 보고 다음 시도자가 가져갈 수 있다.
const LOCK_TTL_MS = 30 * 60 * 1000;

// Article 테이블에 들어가는 필드(본문 마크업).
const ARTICLE_FIELDS = ['title', 'markupVersion', 'modifier'];
// Contents 테이블에 들어가는 공통정보/메타 필드. status·시간·잠금은 서비스가 직접 관리한다.
const CONTENTS_FIELDS = [
  'title', 'author', 'modifier', 'department', 'departmentCode',
  'embargoAt', 'secondEmbargoAt',
  'coAuthor', 'region', 'attribute', 'keyword',
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

export function createArticleService({ articleModel, db, historyModel }) {
  // 이력 기록 헬퍼 — 부가 기록이므로 본 기능(편집/전이)을 막지 않는다.
  // historyModel 미주입 시 건너뛰고, insert 실패는 try/catch로 격리한다.
  function record(rec) {
    if (!historyModel) return;
    try { historyModel.insert({ ...rec, createdAt: nowISO() }); }
    catch { /* 이력 기록 실패는 본 기능을 막지 않는다 */ }
  }

  // 신규 기사 — articleId 생성, status RDS, Article+Contents 트랜잭션 저장.
  function create(dto = {}) {
    const articleId = generateArticleId(db);
    const article = { articleId, ...pick(dto, ARTICLE_FIELDS) };
    const createdAt = nowISO();
    const contents = {
      articleId,
      ...pick(dto, CONTENTS_FIELDS),
      status: 'RDS',
      createdAt,
    };
    const history = historyEntry({
      articleId,
      eventType: 'create',
      actorUserId: dto.modifier ?? dto.author ?? null,
      title: dto.title ?? null,
      toStatus: 'RDS',
      createdAt,
    });
    articleModel.insert({ article, contents, history });
    return { ok: true, articleId };
  }

  // 부분 업데이트(트랜잭션). status 전이는 다루지 않는다(applyAction 전용).
  // 잠금 보유 검증은 호출자(HTTP) 책임.
  function update(articleId, fields = {}) {
    const editedAt = nowISO();
    const history = historyEntry({
      articleId,
      eventType: 'edit',
      actorUserId: fields.modifier ?? null,
      title: fields.title ?? null,
      createdAt: editedAt,
    });
    const changes = articleModel.update(articleId, {
      article: pick(fields, ARTICLE_FIELDS),
      contents: { ...pick(fields, CONTENTS_FIELDS), editedAt },
      history,
    });
    // 편집 성공 후 이력 기록. actor는 호출자가 stamp한 modifier(세션 userId — step2).
    record({ articleId, eventType: 'edit', actorUserId: fields.modifier });
    return { ok: true, changes };
  }

  // 단건 조회 — 본문(Article.markupVersion)을 포함한 { article, contents }(없으면 null). 읽기 전용.
  function getById(articleId) {
    return articleModel.getById(articleId);
  }

  function query(filters) {
    return articleModel.query(filters);
  }

  function search(q) {
    return articleModel.searchByText(q);
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

    const contents = { status: result.status };
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
      toStatus: result.status,
      actorUserId: userId ?? null,
    });
    return { ok: true, status: result.status };
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
        'coAuthor', 'region', 'attribute', 'keyword',
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

  // 편집 잠금 — 보유자는 세션 id. 잠겨 있어도 stale(30분 무갱신)이면 가져갈 수 있다.
  // 획득 실패 시 누가 잠갔는지는 노출하지 않는다.
  function acquireEditLock(articleId, { userId, sessionId } = {}) {
    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };

    const c = row.contents;
    const heldByOther = c.lockYN === 'Y' && c.lockerSessionId && c.lockerSessionId !== sessionId;
    if (heldByOther && !isStale(c.lockedAt)) return { ok: false, reason: 'locked' };

    articleModel.setLock(articleId, {
      lockerUserId: userId ?? null,
      lockerSessionId: sessionId ?? null,
      lockedAt: nowISO(),
    });
    return { ok: true };
  }

  // 보유 세션만 해제한다. 이미 해제된 잠금 해제는 멱등(ok).
  function releaseEditLock(articleId, { sessionId } = {}) {
    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };

    const c = row.contents;
    if (c.lockYN !== 'Y') return { ok: true };
    if (c.lockerSessionId && c.lockerSessionId !== sessionId) return { ok: false, reason: 'not-holder' };

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

  // 해당 세션이 잠금 보유자인지 — 편집 저장 권한 검증에 쓴다.
  function assertLockHolder(articleId, { sessionId } = {}) {
    const row = articleModel.getById(articleId);
    if (!row || !row.contents) return { ok: false, reason: 'not-found' };

    const c = row.contents;
    if (c.lockYN === 'Y' && c.lockerSessionId === sessionId) return { ok: true };
    return { ok: false, reason: 'not-holder' };
  }

  return {
    create, update, getById, query, search, applyAction, deriveArticle, queryHistory,
    acquireEditLock, releaseEditLock, forceReleaseEditLock, assertLockHolder,
  };
}
