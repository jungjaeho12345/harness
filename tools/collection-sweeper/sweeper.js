#!/usr/bin/env node
// tools/collection-sweeper/sweeper.js — FTP 스풀 → POST /api/collection/receive 앱 밖 스위퍼 (phase 76 step6 · ADR-017 결정 4).
//
// Spring 에는 Node 의 FTP 스풀 watcher(server/ftpWatcher.js)가 **없다**(ADR-008: 앱은 스스로 깨어나지 않는다 — WatchService 0건).
// 이 도구가 그 자리를 앱 **밖**에서 맡는다: 스풀 `<RCV_SPOOL_DIR>/<sourceId>/<file>` 을 1회 훑어 각 파일을
// 동결된 HTTP 진입점 `POST <base>/api/collection/receive` {sourceId, payload:<파일 내용 그대로>} 로 넣는다.
// watcher 가 부르던 `controllers.collection.receive(sourceId, payload)` 와 **같은 서비스 진입점**이다.
//
// 사용: node tools/collection-sweeper/sweeper.js --spool <RCV_SPOOL_DIR> --base <서버 origin> [--once]
//        [--move-to <처리완료 폴더>] [--dry-run] [--ledger <파일>] [--stabilize-ms <n>] [--timeout <ms>] [--report <파일>]
// 토큰: 환경변수 COLLECTION_TOKEN 으로만(서버와 같은 값). argv 에 토큰 모양이 오면 실행하지 않는다(exit 2).
//
// 규율(step6.md · 이 파일이 지킨다):
//   · 1회 실행 = 1회 스캔. 자체 루프·타이머·디렉토리 감시가 없다 — 주기는 외부 스케줄러(작업 스케줄러)가 정한다(tick 과 같은 규율).
//     sweeper.test.js 의 정적 스캔이 이 파일에서 그 패턴 0건을 단언한다.
//   · 처리한 파일을 **지우지 않는다** — 장부(append 전용 JSON Lines)로 멱등, --move-to 가 있으면 이동도 한다.
//   · 부분 파일 방어 — 크기·mtime 이 --stabilize-ms 간격의 연속 2회 관측에서 같을 때만 읽는다(Node watcher 는 하지 않는다).
//   · 실패 격리 — 한 파일의 실패가 다음 파일을 막지 않는다. payload·토큰은 stdout/stderr/장부/리포트 어디에도 담지 않는다.
//   · 종료코드 0 = 전건 성공 또는 처리 0건 · 1 = rejected/failed 1건 이상 · 2 = 설정·환경 오류(파일을 건드리지 않았다).

import fs from 'node:fs';
import path from 'node:path';

import {
  EXIT, TOKEN_ENV, TOKEN_HEADER,
  classifyResponse, exitCodeFor, findTokenLikeArgv, formatLedgerLine, ledgerKey, parseLedger, pathIsInside, planScan,
  sameObservation, sha256Hex, summarize,
} from './lib.js';

const DEFAULT_LEDGER_NAME = '.collection-sweeper-ledger.jsonl'; // 스풀 최상위 = 1세그먼트 = watcher·스위퍼 모두 무시하는 자리
const DEFAULT_STABILIZE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const HEALTH_PATH = '/api/health';
const RECEIVE_PATH = '/api/collection/receive';

const USAGE = `사용법: node tools/collection-sweeper/sweeper.js --spool <RCV_SPOOL_DIR> --base <서버 origin> [--once]
        [--move-to <처리완료 폴더>] [--dry-run] [--ledger <파일>] [--stabilize-ms <n>] [--timeout <ms>] [--report <파일>]
  --spool <dir>        수집 스풀 루트(<dir>/<sourceId>/<file>). 최상위 파일은 무시한다.
  --base <origin>      서버 origin(예: http://127.0.0.1:3001). 토큰은 env ${TOKEN_ENV} 로만 받는다 — argv 금지.
  --once               1회 스캔(기본이자 유일한 모드 — 상주 모드는 없다. 주기는 외부 스케줄러가 정한다).
  --move-to <dir>      성공(ingested)한 파일을 이 폴더로 **이동**한다(<dir>/<sourceId>/<file>). 스풀 안은 거부한다.
  --dry-run            읽고 판정만 한다 — 전송·장부·이동 없음.
  --ledger <file>      멱등 장부(JSON Lines · append 전용). 기본 <spool>/${DEFAULT_LEDGER_NAME}.
  --stabilize-ms <n>   부분 파일 방어 간격(기본 ${DEFAULT_STABILIZE_MS} · 0 이상 정수).
  --timeout <ms>       HTTP 한도(기본 ${DEFAULT_TIMEOUT_MS} · 1000 이상 정수).
  --report <file>      파일별 결과 JSON(리포 밖에 두라 — payload·토큰은 담기지 않는다).
종료코드: 0 전건 성공/처리 0건 · 1 rejected/failed 1건 이상 · 2 설정·환경 오류`;

// 설정·환경 오류 — main 이 잡아 exit 2 로 접는다. process.exit() 는 어디서도 부르지 않는다(아래 main 끝 주석).
class ConfigError extends Error {}

function die(msg) {
  throw new ConfigError(msg);
}

// scripts/lib/cliArgs.mjs flagValue 동형(자기완결을 위해 복제하지 않고 최소 규칙만 — 값 누락·플래그 잠식·빈 값 거부).
function takeValue(argv, i, flag) {
  const value = argv[i + 1];
  if (value === undefined) die(`${flag} 값이 없다(플래그가 마지막 인자다).`);
  if (String(value).startsWith('--')) die(`${flag} 값 자리에 다른 플래그가 왔다: ${value}`);
  if (String(value).trim() === '') die(`${flag} 값이 비어 있다.`);
  return value;
}

function parseArgs(argv) {
  const opts = { once: true, dryRun: false, stabilizeMs: DEFAULT_STABILIZE_MS, timeout: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--spool') { opts.spool = takeValue(argv, i, a); i += 1; }
    else if (a === '--base') { opts.base = takeValue(argv, i, a); i += 1; }
    else if (a === '--once') opts.once = true;
    else if (a === '--move-to') { opts.moveTo = takeValue(argv, i, a); i += 1; }
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--ledger') { opts.ledger = takeValue(argv, i, a); i += 1; }
    else if (a === '--stabilize-ms') { opts.stabilizeMs = Number(takeValue(argv, i, a)); i += 1; }
    else if (a === '--timeout') { opts.timeout = Number(takeValue(argv, i, a)); i += 1; }
    else if (a === '--report') { opts.report = takeValue(argv, i, a); i += 1; }
    else die(`알 수 없는 인자: ${a}`);
  }
  if (!opts.spool) die('--spool 이 필요하다.');
  if (!opts.base) die('--base 가 필요하다.');
  if (!Number.isInteger(opts.stabilizeMs) || opts.stabilizeMs < 0) die(`--stabilize-ms 값이 유효하지 않다(0 이상 정수): ${opts.stabilizeMs}`);
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) die(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${opts.timeout}`);
  return opts;
}

function resolveConfig(opts) {
  const spool = path.resolve(opts.spool);
  if (!fs.existsSync(spool) || !fs.statSync(spool).isDirectory()) die(`--spool 이 디렉토리가 아니다: ${spool}`);
  let base;
  try { base = new URL(opts.base); } catch { die(`--base 가 URL 이 아니다: ${opts.base}`); }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') die(`--base 는 http(s) origin 이어야 한다: ${opts.base}`);
  if (base.username || base.password || base.search || base.hash) die('--base 에는 origin 만 쓴다(자격·쿼리·해시 금지).');
  const baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
  let moveTo = null;
  if (opts.moveTo) {
    moveTo = path.resolve(opts.moveTo);
    // 스풀 안으로 옮기면 <spool>/<done>/<sourceId>/<file> 이 2세그먼트 이상이라 다음 스캔(과 롤백 시 Node watcher)이 다시 수집한다.
    if (pathIsInside(moveTo, spool, process.platform)) die(`--move-to 는 --spool 안에 둘 수 없다(이동한 파일이 다시 수집된다): ${moveTo}`);
    if (fs.existsSync(moveTo) && !fs.statSync(moveTo).isDirectory()) die(`--move-to 가 디렉토리가 아니다: ${moveTo}`);
  }
  const ledger = path.resolve(opts.ledger ?? path.join(spool, DEFAULT_LEDGER_NAME));
  if (!fs.existsSync(path.dirname(ledger))) die(`--ledger 의 디렉토리가 없다: ${path.dirname(ledger)}`);
  const report = opts.report ? path.resolve(opts.report) : null;
  return { spool, baseUrl, moveTo, ledger, report, dryRun: opts.dryRun, stabilizeMs: opts.stabilizeMs, timeout: opts.timeout };
}

// 부분 파일 방어의 간격 — 타이머 API 없이 동기 대기한다(이 프로세스는 스캔 1회 말고 할 일이 없다).
function pause(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 스풀 아래 전 파일(재귀). 장부 파일 자신은 제외한다. 순서는 이름순(결정적).
function listFiles(root, skipAbs) {
  const out = [];
  const walk = (dir, rel) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile() && path.resolve(abs) !== skipAbs) out.push({ rel: r, abs });
    }
  };
  walk(root, '');
  return out;
}

function observe(abs) {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

// connection: close — keep-alive 소켓을 남기지 않는다. 소켓이 살아 있는 채 프로세스가 끝나면 Windows 에서 libuv 단언
// (UV_HANDLE_CLOSING · exit 0xC0000409)으로 죽는 플레이크가 실측됐다(왕복 하네스 첫 실행 · docs/cutover-p3.md §5).
async function getJson(url, init, timeoutMs) {
  try {
    const headers = { ...(init.headers ?? {}), connection: 'close' };
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, json };
  } catch (err) {
    return { status: null, json: undefined, error: err && err.code ? err.code : (err && err.name) || 'error' };
  }
}

async function receive(cfg, token, sourceId, payload) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers[TOKEN_HEADER] = token;
  return getJson(`${cfg.baseUrl}${RECEIVE_PATH}`, { method: 'POST', headers, body: JSON.stringify({ sourceId, payload }) }, cfg.timeout);
}

// 이동 — 덮어쓰지 않는다(같은 이름이 있으면 접미사). 드라이브가 다르면(EXDEV) 복사 후 지문이 같을 때만 원본을 정리한다.
function moveOut(abs, rel, moveTo, sha) {
  let dest = path.join(moveTo, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) dest = `${dest}.${Date.now()}.dup`;
  try {
    fs.renameSync(abs, dest);
  } catch (err) {
    if (err && err.code !== 'EXDEV') throw err;
    fs.copyFileSync(abs, dest, fs.constants.COPYFILE_EXCL);
    if (sha256Hex(fs.readFileSync(dest)) !== sha) throw new Error('moved copy digest mismatch');
    fs.unlinkSync(abs);
  }
  return dest;
}

async function main() {
  const argv = process.argv.slice(2);
  const token = process.env.COLLECTION_TOKEN;
  // R5 가드 — 토큰 모양의 argv 는 값을 찍지 않고 위치만 알린다. 가드는 인자 해석보다 앞이다.
  const hit = findTokenLikeArgv(argv, token);
  if (hit) die(`argv[${hit.index}] 에 토큰 모양의 인자가 있다(${hit.rule}) — 토큰은 환경변수 ${TOKEN_ENV} 로만 받는다.`);
  const cfg = resolveConfig(parseArgs(argv));
  if (!token) process.stdout.write(`notice ${TOKEN_ENV} 미설정 — ${TOKEN_HEADER} 헤더 없이 보낸다(토큰이 설정된 서버는 401 unauthenticated 로 failed 가 된다).\n`);

  // 서버 도달성 — 파일을 건드리기 전에 확인한다(닿지 않으면 설정·환경 오류 2 · 장부 무변).
  const health = await getJson(`${cfg.baseUrl}${HEALTH_PATH}`, { method: 'GET' }, cfg.timeout);
  if (health.status !== 200 || !health.json || health.json.ok !== true) {
    die(`서버에 닿지 않는다: GET ${cfg.baseUrl}${HEALTH_PATH} status=${health.status ?? health.error}`);
  }

  const files = listFiles(cfg.spool, cfg.ledger);
  const plan = planScan(files.map((f) => f.rel));
  const absByRel = new Map(files.map((f) => [f.rel, f.abs]));
  for (const rel of plan.ignored) process.stdout.write(`[sweep] ignored(no sourceId): ${rel}\n`);

  // 부분 파일 방어 — 전 후보를 1회 관측 → 간격 → 재관측. 다른 파일은 그 사이에도 바뀔 수 있으므로 판정은 파일마다 독립이다.
  const first = new Map(plan.candidates.map((c) => [c.rel, observe(absByRel.get(c.rel))]));
  if (plan.candidates.length > 0) pause(cfg.stabilizeMs);

  // 장부 preflight — 전송 **전**에 쓸 수 있는지 본다. 장부에 못 올리는 기사는 다음 실행에서 중복이 되므로, 못 쓰면 한 건도 보내지 않는다(exit 2).
  if (!cfg.dryRun) {
    try { fs.appendFileSync(cfg.ledger, ''); } catch (err) { die(`장부를 쓸 수 없다: ${cfg.ledger} (${err && err.code ? err.code : err})`); }
  }
  const done = fs.existsSync(cfg.ledger) ? parseLedger(fs.readFileSync(cfg.ledger, 'utf8')) : new Map();
  const results = [];
  for (const { sourceId, rel } of plan.candidates) {
    const abs = absByRel.get(rel);
    const record = { rel, sourceId, outcome: null, status: null, reason: null, articleId: null, sha256: null, bytes: null };
    results.push(record);
    try {
      if (!sameObservation(first.get(rel), observe(abs))) {
        record.outcome = 'deferred';
        record.reason = 'unstable';
        process.stdout.write(`[sweep] ${rel} sourceId=${sourceId} → deferred(unstable — 다음 실행에)\n`);
        continue;
      }
      const bytes = fs.readFileSync(abs);
      const payload = bytes.toString('utf8'); // watcher 동형: readFile(..., 'utf8') 그대로
      record.sha256 = sha256Hex(bytes);
      record.bytes = bytes.length;
      const key = ledgerKey(rel, record.sha256);
      const prior = done.get(key);
      if (prior) {
        record.outcome = 'skipped';
        record.reason = `ledger:${prior.outcome}`;
        record.articleId = prior.articleId ?? null;
        process.stdout.write(`[sweep] ${rel} sourceId=${sourceId} → skipped(ledger ${prior.outcome}${prior.articleId ? ` articleId=${prior.articleId}` : ''})\n`);
        continue;
      }
      if (cfg.dryRun) {
        record.outcome = 'dry-run';
        process.stdout.write(`[sweep] ${rel} sourceId=${sourceId} → dry-run(${bytes.length}B)\n`);
        continue;
      }
      const res = await receive(cfg, token, sourceId, payload);
      const verdict = classifyResponse(res.status, res.json);
      record.outcome = verdict.outcome;
      record.status = res.status;
      record.reason = verdict.reason ?? (res.error ? `network:${res.error}` : null);
      record.articleId = verdict.articleId;
      if (verdict.outcome === 'ingested' || verdict.outcome === 'rejected') {
        const line = formatLedgerLine({
          t: new Date().toISOString(), key, rel, sourceId, outcome: verdict.outcome, status: res.status, reason: verdict.reason, articleId: verdict.articleId,
        });
        // 장부 실패는 파일 실패가 아니라 환경 실패다 — 계속 가면 장부 없는 기사가 늘어난다(다음 실행의 중복). 여기서 멈춘다(exit 2).
        try { fs.appendFileSync(cfg.ledger, line); } catch (err) { die(`장부 기록 실패(${rel} 은 서버에 ${verdict.outcome} 됐으나 장부에 없다 — 수동 확인): ${err && err.code ? err.code : err}`); }
      }
      if (verdict.outcome === 'ingested') {
        let moved = '';
        if (cfg.moveTo) moved = ` moved=${path.relative(cfg.moveTo, moveOut(abs, rel, cfg.moveTo, record.sha256)).replace(/\\/g, '/')}`;
        process.stdout.write(`[sweep] ${rel} sourceId=${sourceId} → ingested articleId=${verdict.articleId}${moved}\n`);
      } else {
        process.stderr.write(`[sweep] ${rel} sourceId=${sourceId} → ${verdict.outcome} status=${res.status ?? '-'} reason=${record.reason}\n`);
      }
    } catch (err) {
      if (err instanceof ConfigError) throw err; // 환경 실패(장부)는 격리 대상이 아니다 — 실행을 멈춘다.
      // 실패 격리 — 이 파일만 failed 로 남기고 다음 파일로 간다. 메시지는 오류 코드·이름만(payload 없음).
      record.outcome = 'failed';
      record.reason = record.reason ?? `error:${err && err.code ? err.code : (err && err.message) || 'unknown'}`;
      process.stderr.write(`[sweep] ${rel} sourceId=${sourceId} → failed reason=${record.reason}\n`);
    }
  }

  const counts = summarize(results);
  counts.ignored = plan.ignored.length;
  const code = exitCodeFor(counts);
  if (cfg.report) {
    fs.writeFileSync(cfg.report, `${JSON.stringify({ spool: cfg.spool, base: cfg.baseUrl, dryRun: cfg.dryRun, moveTo: cfg.moveTo, counts, exitCode: code, results }, null, 2)}\n`);
  }
  const parts = ['ingested', 'rejected', 'failed', 'skipped', 'deferred', 'dry-run', 'ignored'].map((k) => `${k}=${counts[k] ?? 0}`).join(' ');
  process.stdout.write(`collection-sweeper spool=${cfg.spool} base=${cfg.baseUrl} files=${files.length} ${parts} → exit ${code}\n`);
  return code;
}

// 종료는 자연 종료다 — exitCode 만 놓고 이벤트 루프가 비면 끝난다(process.exit() 금지: 위 getJson 주석의 플레이크).
// 스캔 1회 말고 살아 있을 것이 없으므로(타이머·디렉토리 감시 0건 — sweeper.test.js 정적 스캔) 자연 종료가 곧 즉시 종료다.
main().then((code) => {
  process.exitCode = code;
}, (err) => {
  if (err instanceof ConfigError) process.stderr.write(`${err.message}\n${USAGE}\n`);
  else process.stderr.write(`collection-sweeper 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = EXIT.CONFIG;
});
