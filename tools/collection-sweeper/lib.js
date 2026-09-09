// tools/collection-sweeper/lib.js — 스위퍼의 **순수 판정부** (phase 76 step6 · ADR-017 결정 4).
// fs·네트워크·process·시계에 의존하지 않는다. 판정 규칙은 전부 여기 있고 sweeper.js 는 배선만 한다.
// 자기검사: node --test tools/collection-sweeper/sweeper.test.js
//
// sourceId 도출은 Node 정본 server/ftpWatcher.js 와 **동형**이다:
//   filename.split(/[/\\]/).filter(Boolean) → 2세그먼트 미만 무시 → parts[0] 이 sourceId.
// 그 밖(안정화·장부·분류·종료코드·argv 가드)은 Node watcher 에 **없는** 것이다 — divergence 로 문서에 적었다
// (docs/cutover-p3.md §5).

import { createHash } from 'node:crypto';

/** 종료코드 규약 — 0 전건 성공/처리 0건 · 1 일부 실패(rejected·failed 가 1건 이상) · 2 설정·환경 오류(파일을 건드리지 않았다). */
export const EXIT = Object.freeze({ OK: 0, PARTIAL: 1, CONFIG: 2 });

/** 토큰은 이 env 이름 **하나**로만 받는다(서버의 COLLECTION_TOKEN 과 같은 값). argv 로는 받지 않는다. */
export const TOKEN_ENV = 'COLLECTION_TOKEN';

/** 서버 계약의 헤더 이름(contract/cases/default/collection.contract.js · CollectionController.TOKEN_HEADER). */
export const TOKEN_HEADER = 'x-collection-token';

/** 서버 응답의 **최종 판정** — 이 둘만 장부에 남는다. failed 는 다음 실행이 다시 시도한다. */
export const FINAL_OUTCOMES = new Set(['ingested', 'rejected']);

/** 선등재(`--seed-ledger`)가 남기는 결과 — 전송하지 않고 「이 파일은 이미 있던 것」만 표시한다. */
export const SEEDED = 'seeded';

/** 재실행이 **건너뛰는** 장부 결과 — 서버 판정 둘 + 선등재. `parseLedger` 가 읽어 들이는 집합이다. */
export const LEDGER_OUTCOMES = new Set([...FINAL_OUTCOMES, SEEDED]);

/** 서버 거부 = 사유 토큰이 있는 4xx 두 가지(403 unregistered·inactive / 400 파서·폴백). 그 밖은 failed(재시도). */
const REJECTED_STATUSES = new Set([400, 403]);

/** argv 에 토큰이 오는 모양 — 플래그(--token · --collection-token=… · -token) / 헤더 표기(x-collection-token: …). */
const TOKEN_FLAG = /^--?(x-)?(collection[-_]?)?token(=|$)/i;
const TOKEN_HEADER_LIKE = /^x-collection-token\s*[:=]/i;
/** env 토큰 값이 argv 안에 부분 문자열로 섞여 오는 것(예: URL 뒤에 붙음)도 잡는다 — 짧은 값은 우연 일치가 잦아 8자 이상만. */
const MIN_SUBSTRING_TOKEN = 8;

/** watcher 동형: `/`·`\` 양쪽 구분자로 나누고 빈 조각(선행·중복 구분자)은 버린다. */
export function splitSegments(rel) {
  if (rel === null || rel === undefined) return [];
  return String(rel).split(/[/\\]/).filter(Boolean);
}

/** `<spool>/<sourceId>/<file>` → { sourceId, rel(구분자 `/` 정규화) }. 2세그먼트 미만은 null(무시). */
export function deriveSourceId(rel) {
  const parts = splitSegments(rel);
  if (parts.length < 2) return null;
  return { sourceId: parts[0], rel: parts.join('/') };
}

/** 스캔 계획 — 상대경로 목록을 후보(sourceId 있음)와 무시(최상위 항목)로 가른다. 순서는 입력 순서다. */
export function planScan(relPaths) {
  const candidates = [];
  const ignored = [];
  for (const rel of relPaths) {
    const derived = deriveSourceId(rel);
    if (derived) candidates.push(derived);
    else ignored.push(rel);
  }
  return { candidates, ignored };
}

/** 부분 파일 방어 — 크기·mtime 이 연속 2회 관측에서 같을 때만 안정. 어느 쪽이든 관측이 없으면(사라짐) 불안정. */
export function sameObservation(a, b) {
  return Boolean(a && b) && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** 장부 키 = 정규화 상대경로 + 내용 지문. 같은 이름에 다른 내용이 다시 오면 새 파일이다. */
export function ledgerKey(rel, sha) {
  return `${splitSegments(rel).join('/')}#${sha}`;
}

/** 장부는 append 전용 JSON Lines 다. */
export function formatLedgerLine(entry) {
  return `${JSON.stringify(entry)}\n`;
}

/** 장부 텍스트 → Map<key, entry>(건너뛸 결과만). 빈 줄·깨진 줄·key 없는 줄은 건너뛴다(장부 일부 손상이 전체를 막지 않는다). */
export function parseLedger(text) {
  const done = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry.key !== 'string' || !LEDGER_OUTCOMES.has(entry.outcome)) continue;
    done.set(entry.key, entry);
  }
  return done;
}

/**
 * 서버 응답 → 결과. ingested(200 {ok:true, articleId}) / rejected(400·403 + 사유 토큰 — 최종) / failed(그 밖 전부 — 재시도).
 * status 가 null 이면 네트워크 오류다. 사유 토큰이 없는 4xx 는 무엇이 거부됐는지 모르므로 최종으로 못 박지 않는다.
 */
export function classifyResponse(status, json) {
  if (status === null || status === undefined) return { outcome: 'failed', reason: 'network', articleId: null };
  const reason = json && typeof json.reason === 'string' ? json.reason : null;
  if (status === 200) {
    if (json && json.ok === true && typeof json.articleId === 'string') return { outcome: 'ingested', reason: null, articleId: json.articleId };
    return { outcome: 'failed', reason: 'malformed-response', articleId: null };
  }
  if (REJECTED_STATUSES.has(status) && reason) return { outcome: 'rejected', reason, articleId: null };
  return { outcome: 'failed', reason: reason ?? `http-${status}`, articleId: null };
}

/** 결과 배열 → outcome 별 건수. */
export function summarize(results) {
  const counts = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return counts;
}

/** 종료코드 — rejected·failed 가 하나라도 있으면 1, 아니면 0(처리 0건 포함). 설정 오류(2)는 호출부가 직접 낸다. */
export function exitCodeFor(counts) {
  return ((counts.rejected ?? 0) + (counts.failed ?? 0)) > 0 ? EXIT.PARTIAL : EXIT.OK;
}

/**
 * argv 토큰 가드 — 토큰 모양의 인자가 있으면 { index, rule } 을 돌려준다(값은 담지 않는다). 없으면 null.
 * 프로세스 목록·스케줄러 이력에 토큰이 남는 것을 막는다(토큰은 env 로만).
 */
export function findTokenLikeArgv(argv, envToken) {
  const token = typeof envToken === 'string' ? envToken : '';
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (TOKEN_FLAG.test(a)) return { index: i, rule: 'token-flag' };
    if (TOKEN_HEADER_LIKE.test(a)) return { index: i, rule: 'token-header' };
    if (token && (a === token || (token.length >= MIN_SUBSTRING_TOKEN && a.includes(token)))) return { index: i, rule: 'env-token-value' };
  }
  return null;
}

/** 장부 기록 실패 표식 — 파일 실패가 아니라 환경 실패다(격리하지 않고 전파한다). */
const LEDGER_FATAL = Symbol('ledger-fatal');

export function isLedgerFatal(err) {
  return Boolean(err && err[LEDGER_FATAL]);
}

const errorCode = (err) => (err && err.code ? String(err.code) : (err && err.message) || 'unknown');

/** 장부 기록 — 실패는 **격리하지 않고** 표식을 달아 전파한다(장부 없는 기사 = 다음 실행의 중복). */
function appendLedger(deps, entry) {
  try {
    deps.ledgerAppend(entry);
  } catch (err) {
    const fatal = err instanceof Error ? err : new Error(String(err));
    fatal[LEDGER_FATAL] = true;
    throw fatal;
  }
}

/**
 * 파일 루프 1회 — fs·HTTP·시계는 전부 deps 로 주입된다(단위 테스트가 실패 격리를 잠근다 · R4).
 *
 * deps: observe(rel)→{size,mtimeMs}|null · readFile(rel)→Buffer · post(sourceId, payload)→{status,json,error?} ·
 *       ledgerHas(key)→entry|null · ledgerAppend(entry) (던지면 **전파** — isLedgerFatal) · moveOut(rel, sha)→표시용 목적지 ·
 *       log(line, level) · dryRun · seedLedger · moveTo · now()→ISO 문자열(기본 시계).
 * 규칙: 한 파일의 예외는 그 파일만 failed 로 남기고 다음으로 간다. 최종 결과(ingested·rejected)만 장부. 이동 실패는 ingested 를
 * 뒤집지 않는다(기사는 생겼고 장부에도 있다) — moveError 로만 남긴다. payload·토큰은 어떤 로그 줄에도 싣지 않는다.
 * seedLedger 는 **전송·이동 없이** 장부에만 등재한다(dryRun 이 우선 — 그때는 아무것도 쓰지 않는다).
 */
export async function sweepOnce(candidates, firstObservations, deps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const results = [];
  for (const { sourceId, rel } of candidates) {
    const record = { rel, sourceId, outcome: null, status: null, reason: null, articleId: null, sha256: null, bytes: null, movedTo: null, moveError: null };
    results.push(record);
    try {
      if (!sameObservation(firstObservations.get(rel), deps.observe(rel))) {
        record.outcome = 'deferred';
        record.reason = 'unstable';
        deps.log(`[sweep] ${rel} sourceId=${sourceId} → deferred(unstable — 다음 실행에)`, 'info');
        continue;
      }
      const bytes = deps.readFile(rel);
      const payload = bytes.toString('utf8'); // watcher 동형: readFile(..., 'utf8') 그대로
      record.sha256 = sha256Hex(bytes);
      record.bytes = bytes.length;
      const key = ledgerKey(rel, record.sha256);
      const prior = deps.ledgerHas(key);
      if (prior) {
        record.outcome = 'skipped';
        record.reason = `ledger:${prior.outcome}`;
        record.articleId = prior.articleId ?? null;
        deps.log(`[sweep] ${rel} sourceId=${sourceId} → skipped(ledger ${prior.outcome}${prior.articleId ? ` articleId=${prior.articleId}` : ''})`, 'info');
        continue;
      }
      if (deps.dryRun) {
        record.outcome = 'dry-run';
        deps.log(`[sweep] ${rel} sourceId=${sourceId} → dry-run(${bytes.length}B)`, 'info');
        continue;
      }
      // 선등재(--seed-ledger) — **전송하지 않고** 장부에만 올린다. 컷오버 첫 실행이 스풀에 이미 쌓여 있던
      // 파일을 전건 재수집하는 것을 막는 유일한 앱 밖 수단이다(수집 서비스에 중복 판정이 없고 기사는 지울 수
      // 없다). 이동도 하지 않는다: 선등재는 「이미 있던 것」의 표시이지 처리한 것이 아니다.
      if (deps.seedLedger) {
        record.outcome = SEEDED;
        record.reason = 'seed-ledger';
        appendLedger(deps, { t: now(), key, rel, sourceId, outcome: SEEDED, status: null, reason: 'seed-ledger', articleId: null });
        deps.log(`[sweep] ${rel} sourceId=${sourceId} → seeded(장부 선등재 · 전송 없음 · ${bytes.length}B)`, 'info');
        continue;
      }
      const res = await deps.post(sourceId, payload);
      const verdict = classifyResponse(res.status, res.json);
      record.outcome = verdict.outcome;
      record.status = res.status ?? null;
      record.reason = verdict.reason ?? (res.error ? `network:${res.error}` : null);
      record.articleId = verdict.articleId;
      if (FINAL_OUTCOMES.has(verdict.outcome)) {
        appendLedger(deps, { t: now(), key, rel, sourceId, outcome: verdict.outcome, status: record.status, reason: verdict.reason, articleId: verdict.articleId });
      }
      if (verdict.outcome === 'ingested') {
        if (deps.moveTo) {
          try { record.movedTo = deps.moveOut(rel, record.sha256); } catch (err) { record.moveError = errorCode(err); }
        }
        const tail = record.movedTo ? ` moved=${record.movedTo}` : (record.moveError ? ` move-failed=${record.moveError}` : '');
        deps.log(`[sweep] ${rel} sourceId=${sourceId} → ingested articleId=${verdict.articleId}${tail}`, record.moveError ? 'warn' : 'info');
      } else {
        deps.log(`[sweep] ${rel} sourceId=${sourceId} → ${verdict.outcome} status=${record.status ?? '-'} reason=${record.reason}`, 'warn');
      }
    } catch (err) {
      if (isLedgerFatal(err)) throw err; // 환경 실패 — 계속 가면 장부 없는 기사가 는다(다음 실행의 중복).
      // 실패 격리 — 이 파일만 failed 로 남기고 다음 파일로 간다. 메시지는 오류 코드·이름만(payload 없음).
      record.outcome = 'failed';
      record.reason = record.reason ?? `error:${errorCode(err)}`;
      deps.log(`[sweep] ${rel} sourceId=${sourceId} → failed reason=${record.reason}`, 'warn');
    }
  }
  return results;
}

/** candidate 가 root 자신이거나 그 아래인가. win32 는 대소문자·구분자 무시(scripts/lib/spoolParity.mjs pathIsInside 동형). */
export function pathIsInside(candidate, root, platform) {
  const norm = platform === 'win32'
    ? (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    : (p) => String(p).replace(/\/+$/, '');
  const sep = platform === 'win32' ? '\\' : '/';
  const c = norm(candidate);
  const r = norm(root);
  return c === r || c.startsWith(r + sep);
}
