// 실운영 시나리오 하네스 (phase 76 step1) — 동결된 REST 계약으로 **작성→송고→배부→수집** 전체 루프를
// **한 대상 서버**에 대해 자동 구동하고, 결과 배부 스풀을 step0의 매니페스트로 방출한다.
//
// 이 스크립트는 아키텍처 다이어그램의 「외부 cron / 운영 tick pull」 역할을 하는 **외부 트리거**다
// (index.json decisions (4) · ADR-008): 배부는 `POST /api/distribution/tick`(body 무시)을 **1회** HTTP
// 호출해서만 일으킨다 — 앱 안에 타이머·egress·재시도·큐를 만들지 않는다(앱 코드는 한 줄도 고치지 않는다).
//
// TDD 형태(step1): 이 산출물은 순수 함수가 아니라 실서버 구동 스모크다(verify-integration.mjs·
//   spring-contract.mjs 계열). scripts/**는 eslint ignore라 인자 가드가 유일한 정적 안전망이다.
//   **자체 실행(self-run) 스모크가 곧 이 step의 테스트이자 AC**다 — 각 단계 status·스풀 비어있지 않음을
//   단언하지 못하면 red다. 순수 판정부(스풀 정규화·대조)는 step0(scripts/lib/spoolCanon.mjs)이 소유한다.
//
// 사용: node scripts/operation-scenario.mjs --server node [--keep] [--timeout <ms>] [--out <manifest.json>]
//   --server node   이 step의 유일 모드. Node 서버를 임시 DATA_DIR·임시 DIST_SPOOL_DIR·랜덤 COLLECTION_TOKEN·
//                   HOST=127.0.0.1·랜덤 loopback PORT로 **자체 기동**한다. (step2가 --dual·--server spring·
//                   --db를 더한다 — 이 step은 그 자리를 남겨 두되 만들지 않는다.)
//   --keep          임시 디렉토리를 지우지 않는다(디버깅용).
//   --timeout <ms>  health 대기·단계 한도(기본 45000, 1000 이상 정수).
//   --out <path>    스풀 매니페스트를 쓸 경로. 미지정=stdout으로 방출.
//
// CRITICAL(데이터 안전): 리포 news.db·uploads/·실사용자 데이터에 **절대 바인딩하지 않는다**. 실행 전후
//   스냅샷으로 무변을 단언하고, 부재까지 포함한다(리포 news.db가 실행 전 없으면 실행 후에도 없음=생성 0).
// 위생: 세션 토큰·COLLECTION_TOKEN·시드 비밀번호를 stdout/로그·매니페스트에 싣지 않는다.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import nodePath from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSchema } from '../src/db/schema.js';
import { seedUsers } from '../src/db/seed.js';
import { readSpoolManifest } from './lib/spoolCanon.mjs';
import { flagValue } from './lib/cliArgs.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const SERVER_ENTRY = nodePath.join(REPO_ROOT, 'server', 'index.js');

// 이 step의 유일 모드. step2가 spring·dual을 더한다(자리만 남긴다 — 만들지 않는다).
const SERVER_MODES = ['node'];

const USAGE = `사용법: node scripts/operation-scenario.mjs --server node [--keep] [--timeout <ms>] [--out <manifest.json>]
  --server <mode>  대상 서버 기동 방식(${SERVER_MODES.join('|')}). 이 step은 node만 지원한다.
  --keep           임시 디렉토리를 지우지 않는다(디버깅용).
  --timeout <ms>   health 대기·단계 한도(기본 45000, 1000 이상 정수).
  --out <path>     스풀 매니페스트 출력 경로(미지정=stdout).`;

function die(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const takeValue = (i, flag) => {
    const v = flagValue(argv, i, flag);
    if (!v.ok) die(v.message);
    return v.value;
  };
  const opts = { keep: false, timeout: 45000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--server') { opts.server = takeValue(i, '--server'); i += 1; }
    else if (a === '--out') { opts.out = takeValue(i, '--out'); i += 1; }
    else if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') { opts.timeout = Number(takeValue(i, '--timeout')); i += 1; }
    else die(`알 수 없는 인자: ${a}`);
  }
  if (opts.server === undefined) die('--server <mode>는 필수다(이 step은 node만 지원한다).');
  if (!SERVER_MODES.includes(opts.server)) {
    die(`--server 값이 유효하지 않다(${SERVER_MODES.join('|')}): ${opts.server}`
      + ' — spring·dual 대조는 step2가 소유한다(이 step은 자리만 남긴다).');
  }
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) {
    die(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${opts.timeout}`);
  }
  if (opts.out !== undefined) opts.out = nodePath.resolve(opts.out);
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 자식 env 정리 — 부모 셸의 서버 구성 변수가 새면 우리가 주입한 임시 구성과 충돌한다(verify-integration cleanEnv 동형).
// NODE_ENV=production 금지(쿠키 Secure가 켜지면 평문 HTTP 세션이 죽는다).
function cleanServerEnv() {
  const env = { ...process.env };
  for (const k of [
    'NODE_ENV', 'FORCE_HTTPS', 'ALLOWED_ORIGINS', 'COLLECTION_TOKEN',
    'RCV_SPOOL_DIR', 'DIST_SPOOL_DIR', 'DATA_DIR', 'SPA_DIR', 'PORT', 'HOST',
    'NODE_OPTIONS',
  ]) delete env[k];
  return env;
}

// 빈 포트 확정 — 후보를 실제 listen해 본다(추측 금지 — verify-integration pickFreePort 동형).
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

async function healthOk(origin, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return false; // 자식이 죽었으면 즉시 실패.
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 && (await res.json()).ok === true) return true;
    } catch { /* 기동 전/도달 불가 — 재시도 */ }
    await sleep(100);
  }
  return false;
}

async function killChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await sleep(200);
  if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(200);
}

// 리포 데이터 안전 스냅샷 — 부재까지 잰다(verify-integration repoDataSnapshot 동형).
// 리포 news.db는 .gitignore 대상이라 컨테이너에는 없다 → 실행 후에도 없음(생성 0)을 단언한다.
function repoDataSnapshot() {
  const dbFile = nodePath.join(REPO_ROOT, 'news.db');
  const uploadsDir = nodePath.join(REPO_ROOT, 'uploads');
  const st = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  return {
    db: st ? { size: st.size, mtimeMs: st.mtimeMs } : null,
    uploads: fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : null,
  };
}

// --- HTTP 헬퍼 (계약 스위트 lib/http.js와 동형 — 세션은 x-session-id 헤더로 운반) ---
async function apiCall(origin, method, path, { sid, token, body, query, timeoutMs } = {}) {
  const h = {};
  if (sid) h['x-session-id'] = sid;
  if (token) h['x-collection-token'] = token;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  let qs = '';
  if (query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) sp.append(k, String(v));
    const s = sp.toString();
    if (s) qs = `?${s}`;
  }
  try {
    const res = await fetch(`${origin}${path}${qs}`, {
      method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs ?? 15000),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: undefined, error: err?.message ?? String(err) };
  }
}

// --- 시나리오 시퀀스 (작성→송고→배부→수집) ---
// 요청 순서·shape은 contract/cases/default/{distribution-tick,articles-write,collection}.contract.js의 정본을
// 그대로 미러링한다(추측 금지). 각 단계 응답 status를 단언한다.
async function runScenario(origin, token, opts, checks) {
  const check = (label, ok, detail = '') => {
    checks.push({ label, ok, detail });
    if (!ok) throw new Error(`단계 실패: ${label}${detail ? ` — ${detail}` : ''}`);
  };
  const call = (method, path, o) => apiCall(origin, method, path, { timeoutMs: opts.timeout, ...o });

  // 세션은 로그인으로만 얻는다 — sessionId는 로그·매니페스트에 싣지 않는다(위생).
  async function login(userId, password) {
    const res = await call('POST', '/api/login', { body: { userId, password } });
    if (res.status !== 200 || res.json?.ok !== true || typeof res.json.sessionId !== 'string') {
      throw new Error(`로그인 실패(userId=${userId}): status=${res.status} reason=${res.json?.reason ?? '-'}`);
    }
    return res.json.sessionId;
  }

  const uniq = crypto.randomBytes(4).toString('hex');
  const sidD = await login('desk', 'desk123'); // 작성·송고(D)
  const sidZ = await login('admin', 'admin123'); // 수신처·tick·조회(Z)
  check('로그인(D·Z 시드 계정)', true);

  // --- 2. 배부 준비 — 활성 press 수신처 1곳(Z). spoolDir slug는 소문자 슬러그 규칙을 지킨다. ---
  const spoolSlug = `scn-${uniq}`;
  const target = await call('POST', '/api/distribution-targets', {
    sid: sidZ, body: { name: `scenario-target-${uniq}`, kind: 'press', spoolDir: spoolSlug },
  });
  check('배부 수신처 생성(Z · POST /api/distribution-targets)',
    target.status === 200 && target.json?.ok === true && Number.isInteger(target.json.id),
    `status=${target.status} reason=${target.json?.reason ?? '-'}`);

  // --- 1. 작성 — 엠바고가 이미 도래한(1시간 전) 기사를 D가 작성한다. 본문은 yh-editor 블록 + "(끝)" 마커. ---
  const title = `scenario-article-${uniq}`;
  const embargoAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1시간 전 — 이미 도래.
  const markupVersion = JSON.stringify({
    format: 'yh-editor', version: 1,
    blocks: [{ text: title }, { text: '실운영 시나리오 본문.' }, { text: '(끝)' }],
  });
  const created = await call('POST', '/api/articles', {
    sid: sidD, body: { title, markupVersion, embargoAt },
  });
  check('기사 작성(D · POST /api/articles)',
    created.status === 200 && created.json?.ok === true && typeof created.json.articleId === 'string',
    `status=${created.status} reason=${created.json?.reason ?? '-'}`);
  const { articleId } = created.json;

  // --- 3. 송고 — D의 send. 엠바고 기사는 송고 즉시 배부되지 않고 DES(배부 전 대기)로 진입한다. ---
  const sent = await call('POST', `/api/articles/${articleId}/action`, {
    sid: sidD, body: { action: 'send' },
  });
  check('송고(D · action:send → DES)',
    sent.status === 200 && sent.json?.ok === true && sent.json?.status === 'DES',
    `status=${sent.status} bodyStatus=${sent.json?.status ?? '-'} reason=${sent.json?.reason ?? '-'}`);

  // --- 4. 배부 — 외부 트리거 1회(Z, body 무시). ADR-008: 앱에 타이머 추가 금지. ---
  const tick = await call('POST', '/api/distribution/tick', { sid: sidZ });
  const distributed = Array.isArray(tick.json?.distributed) ? tick.json.distributed : [];
  const mine = distributed.find((d) => d.articleId === articleId);
  check('배부 tick(Z · POST /api/distribution/tick, 외부 트리거 1회)',
    tick.status === 200 && tick.json?.ok === true && !!mine && mine.status === 'DPS',
    `status=${tick.status} scanned=${tick.json?.scanned ?? '-'} distributed=${distributed.length} mineStatus=${mine?.status ?? '-'}`);

  // --- 5. 수집 — 자동기사 1건 인제스트(토큰·loopback) → 200 · GET /api/articles에 나타남. ---
  const sourceId = `scn-source-${uniq}`;
  const rcv = await call('POST', '/api/receiver-config', {
    sid: sidZ, body: { sourceId, type: 'API', name: `scenario-receiver-${uniq}`, active: 'Y' },
  });
  check('수신 설정 등록(Z · POST /api/receiver-config)',
    rcv.status === 200 && rcv.json?.ok === true && Number.isInteger(rcv.json.id),
    `status=${rcv.status} reason=${rcv.json?.reason ?? '-'}`);

  const collectTitle = `scenario-collect-${uniq}`;
  const receive = await call('POST', '/api/collection/receive', {
    token, body: { sourceId, payload: `${collectTitle}\n${collectTitle} 본문` },
  });
  check('수집 인제스트(POST /api/collection/receive · 토큰·loopback → 200)',
    receive.status === 200 && receive.json?.ok === true && typeof receive.json.articleId === 'string',
    `status=${receive.status} reason=${receive.json?.reason ?? '-'}`);
  const collectedId = receive.json.articleId;

  const listed = await call('GET', '/api/articles', { sid: sidZ, query: { articleId: collectedId } });
  const items = Array.isArray(listed.json?.items) ? listed.json.items : [];
  const found = items.filter((row) => row.articleId === collectedId);
  check('인제스트된 기사가 GET /api/articles에 나타남',
    listed.status === 200 && listed.json?.ok === true && found.length === 1,
    `status=${listed.status} matched=${found.length}`);

  return { spoolSlug, articleId };
}

// 임시 디렉토리 추적·정리는 모듈 스코프에 둔다 — main() 이 서버 기동 전(mkTmp·시드·포트 선점)에서
// 던져도 main().catch 가 같은 cleanup() 을 불러 os.tmpdir() 누수를 막는다(--keep 이면 보존).
const tmpDirs = [];
let keepTmp = false;
const mkTmp = (prefix) => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};
const cleanup = () => {
  if (keepTmp) {
    if (tmpDirs.length) process.stdout.write(`keep 임시 디렉토리 보존: ${tmpDirs.join(', ')}\n`);
    return;
  }
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (err) { process.stderr.write(`warn 임시 디렉토리 정리 실패: ${dir} (${err && err.code})\n`); }
  }
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  keepTmp = opts.keep;

  // 사전 스냅샷 — 종료 후 무변(부재 포함) 단언의 기준점.
  const repoBefore = repoDataSnapshot();

  const dataDir = mkTmp('operation-scenario-data-');
  const serverCwd = mkTmp('operation-scenario-cwd-'); // 상대 경로 쓰기가 리포에 닿지 않게 격리.
  const spoolDir = mkTmp('operation-scenario-spool-');

  // 시드 — 임시 DATA_DIR에만 존재한다(스키마·시드 단일 출처는 src/db/**).
  {
    const db = new DatabaseSync(nodePath.join(dataDir, 'news.db'));
    createSchema(db);
    seedUsers(db);
    db.close();
  }

  // 랜덤 COLLECTION_TOKEN — 값은 stdout/로그·매니페스트에 싣지 않는다(위생).
  const collectionToken = crypto.randomBytes(24).toString('hex');
  const host = '127.0.0.1';
  const port = await pickFreePort(host, 20000, 15000);
  const origin = `http://${host}:${port}`;

  const env = cleanServerEnv();
  env.DATA_DIR = dataDir;
  env.PORT = String(port);
  env.HOST = host;
  env.DIST_SPOOL_DIR = spoolDir;
  env.COLLECTION_TOKEN = collectionToken;

  const started = Date.now();
  let child = null;
  let serverOut = '';
  let serverErr = '';
  let failure = null;
  let scenarioResult = null;
  let manifest = null;

  try {
    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: serverCwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => { serverOut += c; });
    child.stderr.on('data', (c) => { serverErr += c; });

    process.stdout.write(`operation-scenario server=node origin=${origin} spool=${spoolDir}\n`);

    const bootStart = Date.now();
    const healthy = await healthOk(origin, Math.min(opts.timeout, 30000), child);
    if (!healthy) {
      throw new Error(`서버가 기동하지 않았다(health 실패): ${origin}\n`
        + `--- server stdout ---\n${serverOut}\n--- server stderr ---\n${serverErr}`);
    }
    process.stdout.write(`ok server boot(health) ${Date.now() - bootStart}ms\n`);

    const checks = [];
    scenarioResult = await runScenario(origin, collectionToken, opts, checks);

    // 종료: step0의 매니페스트로 배부 스풀을 방출한다.
    manifest = await readSpoolManifest(spoolDir);
    // 단언(단일 대상 모드): 활성 수신처에 대한 스풀 매니페스트가 비어 있지 않음.
    const mineEntries = manifest.filter((e) => e.key.startsWith(`${scenarioResult.spoolSlug}/`));
    if (manifest.length === 0) throw new Error('배부 스풀 매니페스트가 비어 있다 — tick이 파일을 쓰지 않았다');
    if (mineEntries.length === 0) {
      throw new Error(`활성 수신처(${scenarioResult.spoolSlug})에 대한 스풀 항목이 없다(매니페스트 ${manifest.length}건)`);
    }
    checks.push({ label: '배부 스풀 매니페스트 비어있지 않음', ok: true, detail: `entries=${manifest.length}` });

    for (const c of checks) {
      process.stdout.write(`  ${c.ok ? 'ok' : 'FAIL'} ${c.label}${c.detail ? ` (${c.detail})` : ''}\n`);
    }
  } catch (err) {
    failure = err;
  } finally {
    await killChild(child);
  }

  // 무변 단언 — 검증이 실 데이터를 건드리지 않았다는 증거(부재 포함).
  const dataFailures = [];
  const repoAfter = repoDataSnapshot();
  if (JSON.stringify(repoBefore) !== JSON.stringify(repoAfter)) {
    dataFailures.push(`리포 news.db/uploads 변동: before=${JSON.stringify(repoBefore)} after=${JSON.stringify(repoAfter)}`);
  }
  // 부재 재확인 — before가 없으면 after도 없어야 한다(생성 0).
  if (repoBefore.db === null && repoAfter.db !== null) dataFailures.push('리포 news.db가 실행 중 새로 생겼다(생성 0 위반)');
  if (repoBefore.uploads === null && repoAfter.uploads !== null) dataFailures.push('리포 uploads/가 실행 중 새로 생겼다(생성 0 위반)');

  if (!failure && dataFailures.length === 0) {
    // 매니페스트 방출 — --out 경로 또는 stdout.
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    if (opts.out) {
      fs.writeFileSync(opts.out, manifestText, 'utf8');
      process.stdout.write(`매니페스트 방출: ${opts.out} (${manifest.length}건)\n`);
    } else {
      process.stdout.write('--- spool manifest ---\n');
      process.stdout.write(manifestText);
    }
    cleanup();
    process.stdout.write(`operation-scenario-ok server=node articleId=${scenarioResult.articleId} `
      + `spoolEntries=${manifest.length} data-safety=ok(무변·부재) elapsed=${Date.now() - started}ms\n`);
    process.exit(0);
  }

  cleanup();
  const lines = ['operation-scenario-FAILED server=node'];
  if (failure) lines.push(`  ${failure.stack ? failure.stack : failure}`);
  for (const f of dataFailures) lines.push(`  [data] ${f}`);
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exit(1);
}

main().catch((err) => {
  // main() 이 서버 기동 전 단계(mkTmp·DatabaseSync·시드·포트 선점)에서 던지면 여기로 온다 —
  // 정상/실패 종료 경로는 이미 cleanup() 을 부른 뒤 process.exit 하므로 이 경로만 남은 누수를 정리한다.
  cleanup();
  process.stderr.write(`operation-scenario 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
