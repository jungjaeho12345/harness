// 통합 실기 스모크 (phase 63 step2) — 서버 exe(임시 DATA_DIR 시드)와 클라이언트 exe(임시 CLIENT_USER_DATA)를
// 함께 기동해 전체 업무 루프를 CDP로 자동 판정한다: secure context/클립보드 표면 → 로그인(desk) →
// 목록 SSE '실시간' → 기사 작성 → 목록 행 등장(SSE) → 상세보기 팝업(720×800) → 송고(RDS→DPS) →
// 행 소멸(SSE) → 클립보드 왕복(best-effort).
// 사용: node scripts/verify-integration.mjs [--scenario loopback|lan|all] [--server-exe <path>] [--client-exe <path>]
//                                           [--cdp-port <n>] [--show] [--keep] [--timeout <ms>]
// 측정 원칙(decisions (10)): 로그인·작성·송고는 렌더러 동일 출처 fetch로, 화면 반영은 DOM으로 단언한다.
// 주의(창 표시): CLIENT_SELFTEST=1이 억제하는 것은 셸이 만드는 창의 show()뿐이다 — SPA가 window.open으로
//   여는 상세보기 자식 창은 Chromium이 만들고 outlivesOpener로 뜨므로 검증 중 720×800 팝업이 잠깐
//   화면에 나타나는 것이 정상이다(스크립트가 단언 후 닫는다). 데스크톱 오염이 아니다.
// LAN 시나리오 3분법(decisions (12)): 서버는 HOST=0.0.0.0으로 바인드한다 — loopback 프로브가 살아 있어야
//   (i) IPv4 없음=skip(exit 0) / (ii) 제품 실패(exit 1) / (iii) loopback 성공+LAN만 도달 불가=환경 차단
//   (방화벽 인바운드, exit 2 + netsh 안내)을 가를 수 있다. HOST=<lanIp> 단독 바인드 금지.
// CRITICAL(데이터 안전, decisions (13)): 리포 news.db·uploads/·실사용자 %APPDATA%\기사작성기·dist/*/data 에
//   절대 바인딩하지 않고, 종료 후 before/after 스냅샷 비교로 무변을 단언한다. dist 판정은 절대 규칙이
//   아니라 비교다 — before에 없던 data/news.db가 after에 생겼을 때만 실패(portable-probe 기존물은 정상).
// CRITICAL(env): ELECTRON_RUN_AS_NODE·NODE_OPTIONS가 상속되면 electron이 플레인 Node로 뜬다 — 반드시 제거.
//   NODE_ENV=production 금지(쿠키 Secure가 켜져 평문 HTTP 세션이 죽는다).
// 의존성 0(decisions (11)): CDP는 /json/list + Node 내장 전역 WebSocket으로만 붙는다(puppeteer 금지).
// 주의: scripts/**는 eslint ignore 대상이다 — 인자 가드가 유일한 정적 안전망이다. import 금지(CLI 즉시 실행).

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSchema } from '../src/db/schema.js';
import { seedUsers } from '../src/db/seed.js';
import { flagValue } from './lib/cliArgs.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');

const USAGE = `사용법: node scripts/verify-integration.mjs [--scenario loopback|lan|all] [--server-exe <path>] [--client-exe <path>]
                                          [--cdp-port <n>] [--show] [--keep] [--timeout <ms>]
  --scenario      loopback | lan | all(기본). lan은 3분법(skip=0 / 제품 실패=1 / 환경 차단=2)으로 끝난다.
  --server-exe    서버 exe 경로(기본: dist/기사작성기-server/의 한글→ASCII 폴백 자동 해석).
  --client-exe    클라이언트 exe 경로(기본: dist/기사작성기/의 한글→ASCII 폴백 자동 해석).
  --cdp-port <n>  원격 디버깅 포트 고정(기본: 35000~44999 랜덤 — 서버 포트 20000~34999와 범위 분리.
                  20000~34999는 서버 범위라 거부한다).
  --show          CLIENT_SELFTEST를 주지 않아 창을 실제로 띄운다(클립보드 왕복·포커스 확인용).
  --keep          임시 디렉토리를 지우지 않는다(디버깅용).
  --timeout <ms>  단계별 대기 한도(기본 45000, 1000 이상 정수).`;

function die(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  // 값 플래그는 flagValue(순수 판정 — missing/empty/flag-like)로 fail-fast(phase 64 step0).
  const takeValue = (i, flag) => {
    const v = flagValue(argv, i, flag);
    if (!v.ok) die(v.message);
    return v.value;
  };
  const opts = { scenario: 'all', show: false, keep: false, timeout: 45000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--scenario') { opts.scenario = takeValue(i, '--scenario'); i += 1; }
    else if (a === '--server-exe') { opts.serverExe = takeValue(i, '--server-exe'); i += 1; }
    else if (a === '--client-exe') { opts.clientExe = takeValue(i, '--client-exe'); i += 1; }
    else if (a === '--cdp-port') { opts.cdpPort = Number(takeValue(i, '--cdp-port')); i += 1; }
    else if (a === '--show') opts.show = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') { opts.timeout = Number(takeValue(i, '--timeout')); i += 1; }
    else die(`알 수 없는 인자: ${a}`);
  }
  if (!['loopback', 'lan', 'all'].includes(opts.scenario)) die(`--scenario 값이 유효하지 않다(loopback|lan|all): ${opts.scenario}`);
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) die(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${opts.timeout}`);
  if (opts.cdpPort !== undefined && (!Number.isInteger(opts.cdpPort) || opts.cdpPort < 1024 || opts.cdpPort > 65535)) {
    die(`--cdp-port 값이 유효하지 않다(1024~65535 정수): ${opts.cdpPort}`);
  }
  // 서버 포트 범위와 겹치는 값은 거부한다 — 아래 서버 포트 선택 호출부(base 20000 · span 15000)와 같은 구간이다.
  // 드리프트는 test/verify-integration-portrange.test.js가 잠근다(가드 숫자 == 서버 호출부 [base, base+span)).
  if (opts.cdpPort !== undefined && opts.cdpPort >= 20000 && opts.cdpPort < 35000) {
    die(`--cdp-port 값이 서버 포트 범위(20000~34999)와 겹친다: ${opts.cdpPort} — 35000~44999에서 고르라.`);
  }
  for (const key of ['serverExe', 'clientExe']) {
    if (opts[key] !== undefined) {
      opts[key] = nodePath.resolve(opts[key]);
      if (!fs.existsSync(opts[key])) die(`경로가 존재하지 않는다: ${opts[key]}`);
    }
  }
  return opts;
}

// 기본 exe 자동 해석 — AC 커맨드를 ASCII로 유지하기 위해 한글 경로는 여기서만 다룬다.
function resolveExe(given, candidates, buildHint) {
  if (given) return given;
  const found = candidates.map((p) => nodePath.join(REPO_ROOT, p)).find((p) => fs.existsSync(p));
  if (!found) die(`실행 파일이 없다(${candidates.join(' | ')}) — ${buildHint} 를 먼저 실행하라.`);
  return found;
}

// 자식 env 정리 — verify-client.mjs cleanEnv()와 동형(그 파일은 import 금지 — CLI 즉시 실행).
function cleanEnv() {
  const env = { ...process.env };
  for (const k of [
    'NODE_ENV', 'FORCE_HTTPS', 'ALLOWED_ORIGINS', 'COLLECTION_TOKEN', 'RCV_SPOOL_DIR', 'DIST_SPOOL_DIR',
    'DATA_DIR', 'SPA_DIR', 'PORT', 'HOST',
    'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', // CRITICAL — 상속되면 electron이 플레인 Node로 뜬다.
    'CLIENT_USER_DATA', 'CLIENT_DIAG_FILE', 'CLIENT_SELFTEST', 'CLIENT_DEV',
  ]) delete env[k];
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function killChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await sleep(200);
  if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(200);
}

function readDiag(diagFile) {
  try {
    return fs.readFileSync(diagFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// 이벤트 이름 시퀀스가 diag에 "그 순서로" 존재하는지(strictly increasing index).
function findSequence(lines, sequence) {
  let from = 0;
  for (const item of sequence) {
    const [name, pred] = Array.isArray(item) ? item : [item, null];
    const idx = lines.findIndex((l, i) => i >= from && l.event === name && (!pred || pred(l)));
    if (idx < 0) return { ok: false, missing: name };
    from = idx + 1;
  }
  return { ok: true };
}

async function waitForSequence(diagFile, sequence, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lines = [];
  while (Date.now() < deadline) {
    lines = readDiag(diagFile);
    if (findSequence(lines, sequence).ok) return { ok: true, lines };
    await sleep(250);
  }
  lines = readDiag(diagFile);
  return { ok: false, lines, missing: findSequence(lines, sequence).missing };
}

// 빈 포트 확정 — 범위 내 랜덤 후보를 실제로 listen해 본다(추측 금지: EADDRINUSE 충돌 실측 — npm 진입점
// 실행에서 25525 충돌로 LAN 시나리오가 오탐 실패했다). test-listen 성공 = 그 host에서 바인드 가능.
async function pickFreePort(host, base, span) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = base + Math.floor(Math.random() * span);
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(candidate, host, () => srv.close(() => resolve(true)));
    });
    if (free) return candidate;
  }
  throw new Error(`빈 포트를 찾지 못했다(host=${host}, 20회 시도) — 환경 이상`);
}

function lanIPv4() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return { name, address: a.address };
    }
  }
  return null;
}

async function healthOk(origin, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return false; // 자식이 죽었으면 즉시 실패 — 30초 낭비 금지.
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 && (await res.json()).ok === true) return true;
    } catch { /* 기동 전/도달 불가 — 재시도 */ }
    await sleep(100);
  }
  return false;
}

// --- 데이터 안전 스냅샷(비교 판정 — 절대 규칙 금지) ---
function repoDataSnapshot() {
  const dbFile = nodePath.join(REPO_ROOT, 'news.db');
  const uploadsDir = nodePath.join(REPO_ROOT, 'uploads');
  const st = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  return {
    db: st ? { size: st.size, mtimeMs: st.mtimeMs } : null,
    uploads: fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : null,
  };
}

function appDataSnapshot() {
  const base = process.env.APPDATA;
  if (!base) return { available: false };
  const dir = nodePath.join(base, '기사작성기');
  const exists = fs.existsSync(dir);
  let config = null;
  let entries = null; // 최상위 엔트리 이름 목록(정렬·비재귀 — phase 64 step2 A-8). 차이는 경고만이다.
  if (exists) {
    entries = fs.readdirSync(dir).sort();
    const cfgFile = nodePath.join(dir, 'config.json');
    if (fs.existsSync(cfgFile)) {
      const st = fs.statSync(cfgFile);
      config = { size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return { available: true, exists, config, entries };
}

// dist/*/data 디렉토리 목록 — before에 없던 news.db가 after에 생겼을 때만 실패다
// (dist/portable-probe/data/news.db는 phase 61 포터블 검증의 정상 산출물 — 절대 규칙로 잠그면 오탐).
function distDataSnapshot() {
  const distDir = nodePath.join(REPO_ROOT, 'dist');
  const out = {};
  if (!fs.existsSync(distDir)) return out;
  for (const name of fs.readdirSync(distDir)) {
    const dataDir = nodePath.join(distDir, name, 'data');
    if (fs.existsSync(dataDir)) out[name] = fs.readdirSync(dataDir).sort();
  }
  return out;
}

// --- CDP (의존성 0 — Node 내장 전역 WebSocket) ---
async function listTargets(cdpPort) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1000) });
  return res.json();
}

async function closeTarget(cdpPort, targetId) {
  try {
    await fetch(`http://127.0.0.1:${cdpPort}/json/close/${targetId}`, { signal: AbortSignal.timeout(2000) });
  } catch { /* 이미 닫혔으면 무해 */ }
}

async function connectCdp(wsUrl) {
  if (typeof WebSocket !== 'function') {
    throw new Error('전역 WebSocket이 없다 — 기준선 Node 24에는 존재한다(환경 이상). npm 의존성으로 우회하지 마라.');
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`CDP WebSocket 연결 실패: ${wsUrl}`));
  });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    nextId += 1;
    const id = nextId;
    // 안전 타임아웃 — 타깃 소멸/ws 단절로 응답이 영영 안 오면 게이트가 무한 대기한다. 에러로 돌려 폴링이 계속 돈다.
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ error: { message: 'cdp-timeout' } }); }
    }, 10000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  return {
    // 평가 실패(컨텍스트 파괴 중 등)는 { error }로 돌려 폴링이 재시도하게 한다.
    async eval(expression, { awaitPromise = false } = {}) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
      if (r.error) return { error: r.error.message ?? 'cdp-error' };
      if (r.result && r.result.exceptionDetails) {
        return { error: r.result.exceptionDetails.exception?.description ?? 'evaluate-exception' };
      }
      return { value: r.result?.result?.value };
    },
    send, // 부가 CDP 호출용(예: --show의 Page.bringToFront) — 평가 외 도메인 호출이 필요할 때만 쓴다.
    close() { try { ws.close(); } catch { /* 무해 */ } },
  };
}

async function findTarget(cdpPort, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(cdpPort);
      const t = targets.find(predicate);
      if (t) return t;
    } catch { /* CDP 기동 전 — 재시도 */ }
    await sleep(250);
  }
  return null;
}

// 팝업 전용 폴링 — 매 시도마다 후보 타깃을 다시 찾아 "새 접속"으로 평가한다. 이유(1회차 실측):
// 상세보기 팝업은 document.open()/write로 문서를 갈아끼우는데, 그 순간 기존 CDP 세션의 기본 실행
// 컨텍스트가 파괴돼 이후 evaluate가 계속 에러를 낸다 → 마지막 성공 샘플(attach 전 값 — 앱 창 크기
// 1440×900가 찍힌 사례)이 최종값으로 남는다. 재접속하면 항상 현재 문서의 컨텍스트에서 평가된다.
async function pollPopup(cdpPort, beforeIds, expression, pred, timeoutMs) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last;
  let lastId = null;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(cdpPort);
      const candidates = targets.filter((t) => t.type === 'page' && !beforeIds.has(t.id) && t.webSocketDebuggerUrl);
      for (const t of candidates) {
        const s = await connectCdp(t.webSocketDebuggerUrl);
        try {
          const r = await s.eval(expression);
          if (!r.error) {
            last = r.value;
            lastId = t.id;
            if (pred(r.value)) return { ok: true, value: r.value, id: t.id, elapsedMs: Date.now() - started };
          }
        } finally { s.close(); }
      }
    } catch { /* 타깃 소멸/전환 중 — 재시도 */ }
    await sleep(250);
  }
  return { ok: false, value: last, id: lastId, elapsedMs: Date.now() - started };
}

// 표현식 폴링 — pred(value)가 참이 될 때까지. 반환 { ok, value, elapsedMs }.
async function pollEval(session, expression, pred, timeoutMs, { awaitPromise = false } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const r = await session.eval(expression, { awaitPromise });
    if (!r.error) {
      last = r.value;
      if (pred(r.value)) return { ok: true, value: r.value, elapsedMs: Date.now() - started };
    }
    await sleep(250);
  }
  return { ok: false, value: last, elapsedMs: Date.now() - started };
}

const NETSH_HINT = (serverExe) => `netsh advfirewall firewall add rule name="yh-article-server-verify" dir=in action=allow program="${serverExe}" enable=yes profile=private,domain`;

// 임시 디렉토리 정리 (phase 64 step2 A-8) — 정상 종료와 SIGINT가 같은 함수를 쓴다(중복 구현 금지).
// 중복 실행 가드(1회만) 포함. 이 스크립트는 자신이 만든 임시 경로 밖의 어떤 파일도 지우지 않는다.
// 정리 실패는 warn 1줄이며 종료 코드를 뒤집지 않는다.
function makeTmpCleanup(tmpDirs, keep) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (keep) {
      process.stdout.write(`keep 임시 디렉토리 보존: ${tmpDirs.join(', ')}\n`);
      return;
    }
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        process.stderr.write(`warn 임시 디렉토리 정리 실패(무해 — Windows 파일 잠금): ${dir} (${err && err.code})\n`);
      }
    }
  };
}

// --- 시나리오 실행 ---
async function runScenario(name, opts, ctx) {
  const failures = [];
  const notes = [];
  const unverified = [];
  const started = Date.now();
  const note = (line) => notes.push(line);
  const check = (label, ok, detail = '') => {
    note(`${ok ? 'ok' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
    if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
  };

  // LAN 인터페이스 판정 — 없으면 skip(실패 아님).
  let lanIp = null;
  if (name === 'lan') {
    lanIp = lanIPv4();
    if (!lanIp) return { name, status: 'skip', notes: ['skip LAN 미검증(non-internal IPv4 인터페이스 없음)'], failures: [], unverified: [] };
    note(`lan interface=${lanIp.name} ip=${lanIp.address}`);
  }

  // 임시 디렉토리 — 이 스크립트는 자신이 만든 임시 경로 밖의 어떤 파일도 지우지 않는다.
  const dataDir = ctx.mkTmp(`verify-integ-data-${name}-`);
  const serverCwd = ctx.mkTmp(`verify-integ-cwd-${name}-`);
  const userData = ctx.mkTmp(`verify-integ-ud-${name}-`);

  // 시드 — 임시 dataDir에만 존재한다(verify-server-exe.mjs 85~91행과 동형).
  {
    const db = new DatabaseSync(nodePath.join(dataDir, 'news.db'));
    createSchema(db);
    seedUsers(db);
    db.close();
  }

  const host = name === 'lan' ? '0.0.0.0' : '127.0.0.1'; // LAN도 0.0.0.0 — 3분법 판별식의 전제다.
  // 포트 범위 분리 (phase 64 step2 A-7): 서버 20000~34999 / CDP 35000~44999. cdpPort는 서버 자식
  // spawn 직후(아직 bind 전일 수 있다) 뽑히므로 test-listen이 통과해도 같은 번호 경합이 성립했다.
  // 둘 다 Windows 동적 포트 기본 범위(49152~65535) 아래에 둔다(decisions (9)).
  const port = await pickFreePort(host, 20000, 15000);
  const origin = name === 'lan' ? `http://${lanIp.address}:${port}` : `http://127.0.0.1:${port}`;
  const loopbackOrigin = `http://127.0.0.1:${port}`;

  const serverEnv = cleanEnv();
  serverEnv.PORT = String(port);
  serverEnv.HOST = host;
  serverEnv.DATA_DIR = dataDir; // SPA_DIR은 주지 않는다 — exe 옆 web/ 배포 기본값 자체가 검증 대상.
  const serverChild = spawn(ctx.serverExe, [], { cwd: serverCwd, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOut = '';
  let serverErr = '';
  serverChild.stdout.on('data', (c) => { serverOut += c; });
  serverChild.stderr.on('data', (c) => { serverErr += c; });

  let clientChild = null;
  let popupId = null;
  const cdpPort = opts.cdpPort ?? await pickFreePort('127.0.0.1', 35000, 10000);
  // 선택된 두 포트를 notes로 남긴다 — 범위 분리를 실행 로그로 증명하는 유일한 수단이자 실패 진단
  // 입력이다. 포트 번호는 비밀이 아니다(세션·토큰류는 절대 넣지 않는다 — 로그인 프로브 규율).
  note(`ports server=${port} cdp=${cdpPort}`);
  const diagFile = nodePath.join(userData, 'diag.jsonl');

  try {
    // health — LAN은 loopback과 LAN origin 둘 다 프로브해 3분법으로 가른다(단순 실패로 뭉개지 않는다).
    const bootStart = Date.now();
    const loopbackHealthy = await healthOk(loopbackOrigin, 30000, serverChild);
    if (!loopbackHealthy) {
      failures.push(`서버가 기동하지 않았다(loopback health 실패): ${loopbackOrigin}\n--- server stdout ---\n${serverOut}\n--- server stderr ---\n${serverErr}`);
      return { name, status: 'fail', notes, failures, unverified };
    }
    note(`ok server boot(loopback health) ${Date.now() - bootStart}ms`);
    if (name === 'lan') {
      const lanHealthy = await healthOk(origin, 10000, serverChild);
      if (!lanHealthy) {
        // loopback 성공 + 같은 포트 LAN origin만 도달 불가 = 환경 차단(방화벽 인바운드) — 제품 결함 단정 금지.
        note(`BLOCKED loopback health ok + LAN origin ${origin} 도달 불가 — 방화벽 인바운드 차단으로 판정(exit 2)`);
        note(`허용 커맨드(관리자 권한): ${NETSH_HINT(ctx.serverExe)}`);
        return { name, status: 'blocked', notes, failures, unverified };
      }
      note(`ok LAN origin health ${origin}`);
    }

    // 클라이언트 기동 — config 사전 배치 + CDP 포트.
    fs.writeFileSync(nodePath.join(userData, 'config.json'), `${JSON.stringify({ schemaVersion: 1, serverUrl: origin })}\n`);
    const clientEnv = cleanEnv();
    clientEnv.CLIENT_USER_DATA = userData;
    clientEnv.CLIENT_DIAG_FILE = diagFile;
    if (!opts.show) clientEnv.CLIENT_SELFTEST = '1'; // --show: 창을 실제로 띄운다(클립보드 실왕복 확인용).
    clientChild = spawn(ctx.clientExe, [`--remote-debugging-port=${cdpPort}`], {
      env: clientEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    clientChild._err = '';
    clientChild.stderr.on('data', (c) => { clientChild._err += c; });

    // diag 시퀀스 — 셸 부팅 계약(phase 62 step1 8절).
    const firstPaint = Date.now();
    const seq = await waitForSequence(diagFile, [
      'app-ready',
      ['config-loaded', (l) => l.hasServerUrl === true],
      'app-window',
      ['did-navigate', (l) => l.httpResponseCode === 200],
      ['did-finish-load', (l) => typeof l.title === 'string' && l.title.length > 0],
    ], opts.timeout);
    check('diag: app-ready→config-loaded{true}→app-window→did-navigate 200→did-finish-load(title 有)', seq.ok,
      seq.ok ? `${Date.now() - firstPaint}ms` : `missing=${seq.missing} events=[${seq.lines.map((l) => l.event).join(',')}]`);

    // secure-origin-switch — lan은 양성(그 origin), loopback은 음성(이벤트 부재)이 단언 대상이다.
    const switchLines = readDiag(diagFile).filter((l) => l.event === 'secure-origin-switch');
    if (name === 'lan') {
      check(`diag: secure-origin-switch{origin:${origin}} 존재`, switchLines.some((l) => l.origin === origin), `found=${JSON.stringify(switchLines)}`);
    } else {
      check('diag: secure-origin-switch 부재(loopback 음성 증거)', switchLines.length === 0, `found=${JSON.stringify(switchLines)}`);
    }

    // CDP 접속 — 서버 origin의 page 타깃.
    const target = await findTarget(cdpPort, (t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(origin), opts.timeout);
    if (!target) {
      failures.push(`CDP page 타깃을 찾지 못했다(origin=${origin}, cdpPort=${cdpPort})`);
      return { name, status: 'fail', notes, failures, unverified };
    }
    const page = await connectCdp(target.webSocketDebuggerUrl);
    try {
      // 1. secure context / 클립보드 표면 — 두 시나리오 모두 참이어야 한다(LAN 거짓 = step0 스위치 실효 없음).
      const surface = await pollEval(page, `({
        isSecureContext: window.isSecureContext,
        clipboardType: typeof navigator.clipboard,
        readTextType: typeof (navigator.clipboard && navigator.clipboard.readText),
        readType: typeof (navigator.clipboard && navigator.clipboard.read),
        url: location.href, readyState: document.readyState,
      })`, (v) => v && typeof v.url === 'string' && v.url.startsWith(origin) && v.readyState === 'complete', opts.timeout);
      check('isSecureContext === true', surface.ok && surface.value.isSecureContext === true, JSON.stringify(surface.value));
      check('navigator.clipboard 표면(object/readText/read)', surface.ok
        && surface.value.clipboardType === 'object'
        && surface.value.readTextType === 'function'
        && surface.value.readType === 'function', `clipboard=${surface.value?.clipboardType} readText=${surface.value?.readTextType} read=${surface.value?.readType}`);

      // 2. 로그인 — desk(D): 송고가 RDS→DPS라는 관측 가능한 전이를 만든다.
      const login = await page.eval(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ userId: 'desk', password: 'desk123' }) }).then((r) => r.json())`, { awaitPromise: true });
      // detail에 응답 body 전체를 넣지 않는다 — sessionId(1시간 유효 토큰)가 스모크 로그에 평문으로
      // 남는다(diag FORBIDDEN_KEYS와 같은 규율). 실패 진단에는 ok/reason이면 충분하다.
      check('POST /api/login ok(desk)', !login.error && login.value?.ok === true,
        login.error ?? `ok=${login.value?.ok} reason=${login.value?.reason ?? '-'}`);

      // 3. 목록 진입 + SSE 연결('실시간') — HttpOnly 쿠키로 SSE가 붙었다는 증거.
      await page.eval("location.replace('/list.do')");
      const live = await pollEval(page, `(function(){ const el = document.querySelector('[data-testid="live-status"]'); return el ? el.textContent : ''; })()`,
        (v) => typeof v === 'string' && v.includes('실시간'), opts.timeout);
      check("목록 [data-testid=live-status] = '실시간'", live.ok, live.ok ? `${live.elapsedMs}ms` : `last=${JSON.stringify(live.value)}`);

      // 4. 기사 작성 — 고유 제목 + "(끝)" 마커(send의 no-end-marker 게이트 통과 조건).
      // 본문 첫 줄에도 고유 제목을 넣는다: 상세보기는 title 필드를 <title>에만 싣고 body는 본문 블록만
      // 그린다("본문 첫 줄이 곧 제목" — articleDetail.js 설계). body innerText 단언은 이 첫 줄이 잡는다.
      const title = `통합검증-${Date.now()}`;
      const markup = `${title}\n통합검증 본문 (끝)`;
      const created = await page.eval(`fetch('/api/articles', { method: 'POST', headers: { 'content-type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ title: ${JSON.stringify(title)}, markupVersion: ${JSON.stringify(markup)} }) }).then((r) => r.json())`, { awaitPromise: true });
      const articleId = created.value?.articleId;
      check('POST /api/articles ok + articleId', !created.error && created.value?.ok === true && !!articleId, created.error ?? JSON.stringify(created.value));

      // 5. 화면 반영(SSE 1차) — 재조회를 유발하지 않는다(새로고침·버튼 클릭 금지). SSE 무효화가 단언 대상.
      const rowExpr = `[...document.querySelectorAll('tbody tr')].some((tr) => tr.textContent.includes(${JSON.stringify(title)}))`;
      const appeared = await pollEval(page, rowExpr, (v) => v === true, opts.timeout);
      check('목록 행 등장(SSE 무효화→재조회)', appeared.ok, appeared.ok ? `${appeared.elapsedMs}ms` : 'timeout');

      // 6. 상세보기 팝업 — 행 클릭 → 새 타깃 → 제목 + 크기(폭 720 엄격 / 높이 700~800 허용) → 닫기.
      // 크기는 hasTitle이 참이 된 "같은 샘플"에서 읽는다 — attach 전 과도기 값이 판정에 섞이지 않게.
      if (appeared.ok) {
        const beforeIds = new Set((await listTargets(cdpPort)).map((t) => t.id));
        // opener(앱 창) 치수 — 팝업 attach 판정의 기준. window.open 직후 guest WebContents가 자기
        // BrowserWindow에 붙기 전에는 outerWidth/Height가 opener 값(예: 1440×900)을 상속한다(2회차 실측:
        // 본문이 이미 쓰인 29ms 시점에도 1440×900). 팝업 요청 크기는 720×800이라 opener와 같을 수 없으므로
        // "opener 치수와 다르다 = attach 완료"로 과도기만 배제한다(720 가정 없음 — 실측값은 그대로 단언).
        const openerDims = await page.eval('({ w: window.outerWidth, h: window.outerHeight })');
        const opener = openerDims.value ?? {};
        await page.eval(`[...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(title)})).click()`);
        const popup = await findTarget(cdpPort, (t) => t.type === 'page' && !beforeIds.has(t.id), opts.timeout);
        check('상세보기 새 창 타깃 등장', !!popup, popup ? popup.url : 'timeout');
        if (popup) {
          popupId = popup.id;
          try {
            const detail = await pollPopup(cdpPort, beforeIds, `({
              hasTitle: !!(document.body && document.body.innerText.includes(${JSON.stringify(title)})),
              w: window.outerWidth, h: window.outerHeight,
            })`, (v) => v && v.hasTitle === true && !(v.w === opener.w && v.h === opener.h), opts.timeout);
            const v = detail.value ?? {};
            check('팝업 본문에 제목 표시', v.hasTitle === true, JSON.stringify(detail.value));
            if (detail.ok) {
              check('팝업 폭 outerWidth === 720(엄격)', v.w === 720, `실측 w=${v.w}`);
              check('팝업 높이 700 <= outerHeight <= 800', typeof v.h === 'number' && v.h >= 700 && v.h <= 800, `실측 h=${v.h}`);
              note(`popup size 실측 w=${v.w} h=${v.h} (${detail.elapsedMs}ms)`);
            } else if (!opts.show && v.hasTitle === true) {
              // §5 사전 승인 재판정(비표시 창 스로틀): 본문은 쓰였는데(hasTitle=true) 창 attach(치수 반영)만
              // 폴링 한도 내 미완 — 실측: 비표시 attach 소요 35ms~11s 산포, 1회 45085ms 타임아웃 /
              // --show 재실행 1607ms 통과(2026-08-14). 제품 결함이 아니라 비표시 모드 한계로 판정하고
              // 크기 검증은 --show 실행이 소유한다. --show 모드에서는 이 분기를 타지 않는다(아래 else = 실패).
              unverified.push(`팝업 크기 미검증(비표시 창 스로틀 — attach 미완 ${detail.elapsedMs}ms, 마지막 샘플 w=${v.w} h=${v.h}=opener 상속값): --show 재실행이 검증 소유`);
              note(`unverified 팝업 크기 — 비표시 창 스로틀(hasTitle=true, dims=opener, ${detail.elapsedMs}ms)`);
            } else {
              check('팝업 크기(창 attach)', false, `timeout ${detail.elapsedMs}ms last=${JSON.stringify(detail.value)}`);
            }
          } finally {
            // 단언 후 반드시 닫는다 — 검증 전 없던 page 타깃 전부(팝업 + 혹시 남은 과도기 타깃).
            for (const t of await listTargets(cdpPort)) {
              if (t.type === 'page' && !beforeIds.has(t.id)) await closeTarget(cdpPort, t.id);
            }
            popupId = null;
          }
        }
        const windowOpen = readDiag(diagFile).some((l) => l.event === 'window-open' && l.action === 'allow');
        check("diag: window-open{action:'allow'} 기록", windowOpen);
      }

      // 7. 송고 — D의 send는 RDS→DPS(lifecycle DESK_TABLE).
      const sent = await page.eval(`fetch('/api/articles/' + ${JSON.stringify(articleId ?? '')} + '/action', { method: 'POST',
        headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ action: 'send' }) }).then((r) => r.json())`, { awaitPromise: true });
      check("송고 ok + status='DPS'", !sent.error && sent.value?.ok === true && sent.value?.status === 'DPS', sent.error ?? JSON.stringify(sent.value));

      // 8. 화면 반영(SSE 2차) — DPS는 기본 메뉴 deskUnsent 필터{RDS,DDH} 밖 → 행이 사라져야 한다.
      const disappeared = await pollEval(page, rowExpr, (v) => v === false, opts.timeout);
      check('목록 행 소멸(송고 후 deskUnsent 밖)', disappeared.ok, disappeared.ok ? `${disappeared.elapsedMs}ms` : 'timeout');

      // 9. 클립보드 왕복(best-effort) — 비표시 창은 포커스가 없어 거부될 수 있다(open (d)).
      if (opts.show) {
        // 표시 모드 — 앱 창을 전면·포커스로 올린다. 창이 화면에 떠 있어도 포커스가 터미널에 있으면
        // writeText가 'Document is not focused'로 거부된다(실측). 비표시 모드에서는 부르지 않는다 —
        // 숨겨 둔 창이 활성화되어 데스크톱을 건드릴 수 있다(SELFTEST 계약 위반).
        await page.send('Page.bringToFront');
        await sleep(300);
      }
      const nonce = `verify-integ-${Date.now()}`;
      const clip = await page.eval(`(async () => {
        try {
          await navigator.clipboard.writeText(${JSON.stringify(nonce)});
          const back = await navigator.clipboard.readText();
          return { ok: back === ${JSON.stringify(nonce)} };
        } catch (e) { return { ok: false, reason: String(e) }; }
      })()`, { awaitPromise: true });
      if (!clip.error && clip.value?.ok === true) {
        note('ok 클립보드 왕복(writeText→readText 일치)');
      } else if (opts.show) {
        check('클립보드 왕복(--show)', false, clip.error ?? JSON.stringify(clip.value)); // 표시 모드 실패는 그대로 보고.
      } else {
        const why = clip.value?.reason ?? clip.error ?? 'unknown';
        unverified.push(`클립보드 왕복 미검증(비표시 창 포커스 없음 추정): ${why}`);
        note(`unverified 클립보드 왕복 — ${why} (자동 판정은 표면 존재까지 — 실왕복은 --show/육안 체크리스트 소유)`);
      }
    } finally {
      page.close();
    }
  } catch (err) {
    failures.push(String(err && err.stack ? err.stack : err));
  } finally {
    if (popupId) await closeTarget(cdpPort, popupId);
    await killChild(clientChild);
    await killChild(serverChild);
  }
  if (failures.length > 0) {
    // 실패 시 자식 stdout/stderr + diag 전부 첨부한다(§4) — 원인 격리는 로그 없이는 불가능하다.
    note(`--- server stdout ---\n${serverOut}`);
    note(`--- server stderr ---\n${serverErr}`);
    if (clientChild) {
      note(`--- client stderr ---\n${clientChild._err ?? ''}`);
      note(`--- diag ---\n${readDiag(diagFile).map((l) => JSON.stringify(l)).join('\n')}`);
    }
  }
  note(`elapsed ${Date.now() - started}ms`);
  return { name, status: failures.length === 0 ? 'ok' : 'fail', notes, failures, unverified };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const serverExe = resolveExe(opts.serverExe, [
    'dist/기사작성기-server/기사작성기-server.exe', 'dist/기사작성기-server/article-server.exe',
  ], 'npm run dist:server && npm run dist:client');
  const clientExe = resolveExe(opts.clientExe, [
    'dist/기사작성기/기사작성기.exe', 'dist/기사작성기/article-client.exe',
  ], 'npm run dist:server && npm run dist:client');

  const tmpDirs = [];
  const ctx = {
    serverExe,
    clientExe,
    mkTmp(prefix) {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
      tmpDirs.push(dir);
      return dir;
    },
  };

  // SIGINT(콘솔 Ctrl+C) — 임시 디렉토리 정리만 소유한다. 자식 킬은 넣지 않는다(decisions (11):
  // 콘솔 Ctrl+C는 프로세스 그룹에 함께 전달되고, 전역 자식 레지스트리는 시나리오 루프와 이중 소유가
  // 된다). Windows에서 프로그램적 SIGINT는 TerminateProcess라 이 경로의 자동 판정은 불가능하다.
  const cleanupTmp = makeTmpCleanup(tmpDirs, opts.keep);
  process.on('SIGINT', () => {
    cleanupTmp();
    const remaining = tmpDirs.filter((d) => fs.existsSync(d));
    if (remaining.length > 0) process.stderr.write(`잔존 임시 디렉토리: ${remaining.join(', ')}\n`);
    process.exit(130);
  });

  // 사전 스냅샷 — 종료 후 무변 단언 4종의 기준점(before/after 비교, 절대 조건 아님).
  const repoBefore = repoDataSnapshot();
  const appBefore = appDataSnapshot();
  const distBefore = distDataSnapshot();

  const scenarios = opts.scenario === 'all' ? ['loopback', 'lan'] : [opts.scenario];
  const results = [];
  const startedAt = Date.now();
  for (const name of scenarios) {
    results.push(await runScenario(name, opts, ctx));
  }

  // 무변 단언 4종 — 검증이 실 데이터를 건드리지 않았다는 증거.
  const dataFailures = [];
  const repoAfter = repoDataSnapshot();
  if (JSON.stringify(repoBefore) !== JSON.stringify(repoAfter)) {
    dataFailures.push(`리포 news.db/uploads 변동: before=${JSON.stringify(repoBefore)} after=${JSON.stringify(repoAfter)}`);
  }
  const appAfter = appDataSnapshot();
  if (appBefore.available && appAfter.available
    && JSON.stringify({ e: appBefore.exists, c: appBefore.config }) !== JSON.stringify({ e: appAfter.exists, c: appAfter.config })) {
    dataFailures.push(`실사용자 %APPDATA%\\기사작성기 변동: before=${JSON.stringify(appBefore)} after=${JSON.stringify(appAfter)}`);
  }
  const distAfter = distDataSnapshot();
  for (const [folder, entries] of Object.entries(distAfter)) {
    if (entries.includes('news.db') && !((distBefore[folder] ?? []).includes('news.db'))) {
      // before에 없던 data/news.db가 생겼다 = DATA_DIR 주입 실패로 시드 계정 DB가 배포물에 남았다(자격증명 유출).
      dataFailures.push(`dist/${folder}/data/news.db 가 검증 중 새로 생겼다(before=${JSON.stringify(distBefore[folder] ?? [])})`);
    }
  }

  cleanupTmp();

  const failed = results.filter((r) => r.status === 'fail');
  const blocked = results.filter((r) => r.status === 'blocked');
  const lines = [];
  for (const r of results) {
    lines.push(`[${r.name}] ${r.status}`);
    for (const n of r.notes) lines.push(`  ${n}`);
    for (const u of r.unverified) lines.push(`  unverified ${u}`);
  }
  // A-8 엔트리 목록 확장 — 차이는 경고로만 남긴다(게이트 ② 확정: exit 계약은 기존 4종 유지 —
  // 사용자가 실클라이언트를 병행 실행하면 프로필 엔트리가 정상적으로 바뀔 수 있어, 실패로 올리면
  // 제품 결함으로 둔갑하는 오탐이 된다). 검증 전에는 실클라이언트 종료를 확인하라.
  if (appBefore.available && appAfter.available
    && JSON.stringify(appBefore.entries) !== JSON.stringify(appAfter.entries)) {
    lines.push(`warn 실사용자 %APPDATA%\\기사작성기 최상위 엔트리 변화(경고만 — 실클라이언트 병행 실행 가능성): before=${JSON.stringify(appBefore.entries)} after=${JSON.stringify(appAfter.entries)}`);
  }
  lines.push(`data-safety ${dataFailures.length === 0 ? 'ok(무변 4종)' : `FAIL ${dataFailures.join(' | ')}`}`);
  lines.push(`elapsed total ${Date.now() - startedAt}ms mode=${opts.show ? 'show' : 'selftest(비표시 — 상세보기 팝업만 잠깐 표시되는 것이 정상)'}`);

  if (failed.length === 0 && dataFailures.length === 0 && blocked.length === 0) {
    process.stdout.write(`verify-integration-ok scenario=${opts.scenario}\n${lines.join('\n')}\n`);
    process.exit(0);
  }
  if (failed.length === 0 && dataFailures.length === 0 && blocked.length > 0) {
    // 환경 차단(방화벽) — 제품 결함이 아니다. 허용 후 재실행해 exit 0을 받는 것이 목표.
    process.stderr.write(`verify-integration-BLOCKED(환경 차단) scenario=${opts.scenario}\n${lines.join('\n')}\n`);
    process.exit(2);
  }
  process.stderr.write([
    `verify-integration-FAILED scenario=${opts.scenario}`,
    ...failed.flatMap((r) => r.failures.map((f) => `  [${r.name}] ${f}`)),
    ...dataFailures.map((f) => `  [data] ${f}`),
    ...lines,
  ].join('\n') + '\n');
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`verify-integration 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
