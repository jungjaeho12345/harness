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

export function createArticleService({ articleModel, db }) {
  // 신규 기사 — articleId 생성, status RDS, Article+Contents 트랜잭션 저장.
  function create(dto = {}) {
    const articleId = generateArticleId(db);
    const article = { articleId, ...pick(dto, ARTICLE_FIELDS) };
    const contents = {
      articleId,
      ...pick(dto, CONTENTS_FIELDS),
      status: 'RDS',
      createdAt: nowISO(),
    };
    articleModel.insert({ article, contents });
    return { ok: true, articleId };
  }

  // 부분 업데이트(트랜잭션). status 전이는 다루지 않는다(applyAction 전용).
  // 잠금 보유 검증은 호출자(HTTP) 책임.
  function update(articleId, fields = {}) {
    const changes = articleModel.update(articleId, {
      article: pick(fields, ARTICLE_FIELDS),
      contents: { ...pick(fields, CONTENTS_FIELDS), editedAt: nowISO() },
    });
    return { ok: true, changes };
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
    return { ok: true, status: result.status };
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
    create, update, query, search, applyAction,
    acquireEditLock, releaseEditLock, forceReleaseEditLock, assertLockHolder,
  };
}
