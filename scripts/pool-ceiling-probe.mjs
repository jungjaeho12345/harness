// 커넥션 풀 1 천장 실측 + 769자 텍스트 PK 축 실측 (phase 76 step9 — 로드맵 P3).
//
// 무엇을 재는가: Spring 은 MySQL 에 붙어도 `NewsDataSource.MAX_POOL_SIZE = 1` 이다(ADR-016 결정 6). SQLite 시절의
// 근거(단일 파일 · 동시 쓰기가 SQLITE_BUSY)는 MySQL 에서 사라졌으므로, 같은 상수는 이제 **네트워크 왕복 위에 얹힌
// 전역 직렬화**를 뜻한다. 이 프로브는 그 천장이 실제로 어디인지를 **숫자로** 남긴다 — 계단마다 2회씩 재고 두 값을
// 모두 적는다(평균 금지 · 천장은 꼬리에서 먼저 보인다). 같은 부하를 Node 에도 걸어 나란히 놓는다: 운영자가 알고
// 싶은 것은 "전환 후 느려지는가"이기 때문이다(Node 는 단일 프로세스·SQLite 라 축이 다르다는 사실도 그대로 적는다).
//
// 사용: node scripts/pool-ceiling-probe.mjs [--axis <all|load|sse|timeout|userid>] [--jar <path>] [--java-home <path>]
//                                          [--out-dir <리포 밖>] [--rounds <n>] [--timeout <ms>] [--keep]
//   자격은 argv 가 아니라 환경변수다: NEWS_CT_MYSQL_URL/_USERNAME/_PASSWORD (docs/ops-mysql.md §3 · 한 줄씩).
//
// CRITICAL: **기본 스위트가 아니다.** `mvnw verify`·`npm test` 는 이 파일을 돌리지 않는다(step9 금지사항 —
//   부하 측정을 매 빌드에 넣으면 사람이 게이트를 건너뛴다). 다른 무거운 작업(mvnw·계약 하네스)과 **동시 실행 금지**:
//   같은 머신에서 겹치면 재는 것이 서버가 아니라 이 머신이 된다.
// CRITICAL(비파괴): 대상은 **임시 DATA_DIR 과 임시 MySQL DB(harness_ct_<16hex>)뿐**이다 — 리포 news.db·uploads/ 무변
//   (실행 전후 스냅샷 단언) · `news`·`news_stage` 를 열지 않는다 · 임시 디렉토리는 리포 밖이다.
// 로그 규율: 세션 토큰·비밀번호·MySQL 자격을 stdout/stderr/파일 어디에도 쓰지 않는다(자식 출력은 redactSecrets).
//   769자 축의 **값 원문도 싣지 않는다** — 글자 수·바이트 수·상태코드만 남긴다.
// 주의: scripts/** 는 eslint ignore 대상이다 — 인자 가드(scripts/lib/cliArgs.mjs)와 자기검사가 정적 안전망이다.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSchema } from '../src/db/schema.js';
import { seedUsers, SAMPLE_USERS } from '../src/db/seed.js';
import { flagValue } from './lib/cliArgs.mjs';
import {
  PASS_KEY_SET, ephemeralDbName, requireEphemeralDbName, urlForDatabase,
  readMysqlCredentials, migratorChildEnv, springMysqlEnv, redactSecrets,
} from './lib/mysqlHarness.mjs';
import { pathIsInside } from './lib/spoolParity.mjs';
import {
  LADDER, buildUserIdCases, formatStageTable, formatUserIdTable,
  judgeLoadSelfCheck, judgeUserIdAxis, queueDepthForTimeout, summarise,
} from './lib/poolProbe.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const NODE_SERVER = nodePath.join(REPO_ROOT, 'server', 'index.js');
const SPRING_TARGET_DIR = nodePath.join(REPO_ROOT, 'server-spring', 'target');
const MIGRATOR_JAR = nodePath.join(REPO_ROOT, 'tools', 'news-migrator', 'target', 'news-migrator.jar');
const SELF_TEST = nodePath.join(nodePath.dirname(SCRIPT_PATH), 'lib', 'poolProbe.self-test.mjs');
const MYSQL_SELF_TEST = nodePath.join(nodePath.dirname(SCRIPT_PATH), 'lib', 'mysqlHarness.test.mjs');
const CONNECT_HOST = '127.0.0.1';
const PORT_BASE = 15000;
const PORT_SPAN = 5000;
const JDK_HINT = 'D:/agents/tools/jdk-25.0.4.1+1';
const BUILD_HINT = `cd server-spring && JAVA_HOME="${JDK_HINT}" ./mvnw -B -q package -DskipTests`;
const MIGRATOR_BUILD_HINT = `cd tools/news-migrator && JAVA_HOME="${JDK_HINT}" ./mvnw -B -q package -DskipTests`;
const AXES = ['all', 'load', 'sse', 'timeout', 'userid'];
// 계단마다 보내는 요청 수 = 동시 수 × 이 값(최소 8) — 분위수가 의미를 가지려면 표본이 여러 개여야 한다.
const REQUESTS_PER_SLOT = 8;
const FIXTURE_ARTICLES = 12;
const SSE_CONNECTIONS = 3;
// Hikari 기본 connectionTimeout(30s) — 이 값을 넘긴 대기가 무엇으로 나가는지가 30초 경계 축이다.
const HIKARI_CONNECTION_TIMEOUT_MS = 30000;
const MYSQL_CLI = 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
// 행 잠금을 쥐고 있는 시간 — 30초 경계를 넘기려면 그보다 넉넉해야 한다(innodb_lock_wait_timeout 기본 50초보다는 짧게).
const LOCK_HOLD_SEC = 45;

const USAGE = `사용법: node scripts/pool-ceiling-probe.mjs [--axis <${AXES.join('|')}>] [--jar <path>] [--java-home <path>] [--out-dir <리포 밖>] [--rounds <n>] [--timeout <ms>] [--keep]
  --axis <이름>      재는 축(기본 all). load=읽기·쓰기 계단 · sse=SSE 열린 상태 · timeout=30초 경계 · userid=769자 축.
  --jar <path>       Spring 실행 jar. 미지정=server-spring/target/*.jar 자동 탐색(자동 빌드는 하지 않는다).
  --java-home <path> JDK 홈. 미지정=SPRING_JAVA_HOME → JAVA_HOME 순(시스템 java 폴백 금지).
  --out-dir <dir>    리포트 디렉토리. 미지정=임시 루트 안. **리포 안에는 쓰지 않는다.**
  --rounds <n>       계단마다 재는 회차(기본 2 · 1 이상). 두 값을 **모두** 표에 남긴다.
  --timeout <ms>     기동·요청 대기 한도(기본 60000, 1000 이상 정수).
  --keep             임시 디렉토리를 성공해도 지우지 않는다(실패 시에는 항상 보존).
  Spring 은 언제나 **임시 MySQL DB** 로 붙는다(풀 1 의 천장은 MySQL 축의 질문이다) — CT 3키가 필요하다.`;

function usageDie(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const take = (i, flag) => {
    const v = flagValue(argv, i, flag);
    if (!v.ok) usageDie(v.message);
    return v.value;
  };
  const opts = { axis: 'all', rounds: 2, timeout: 60000, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--axis') { opts.axis = take(i, '--axis'); i += 1; }
    else if (a === '--jar') { opts.jar = take(i, '--jar'); i += 1; }
    else if (a === '--java-home') { opts.javaHome = take(i, '--java-home'); i += 1; }
    else if (a === '--out-dir') { opts.outDir = take(i, '--out-dir'); i += 1; }
    else if (a === '--rounds') { opts.rounds = Number(take(i, '--rounds')); i += 1; }
    else if (a === '--timeout') { opts.timeout = Number(take(i, '--timeout')); i += 1; }
    else if (a === '--keep') opts.keep = true;
    else usageDie(`알 수 없는 인자: ${a}`);
  }
  if (!AXES.includes(opts.axis)) usageDie(`--axis 값이 유효하지 않다(${AXES.join('|')}): ${opts.axis}`);
  if (!Number.isInteger(opts.rounds) || opts.rounds < 1) usageDie(`--rounds 값이 유효하지 않다(1 이상 정수): ${opts.rounds}`);
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) usageDie(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${opts.timeout}`);
  return opts;
}

function runSelfTest(file, label) {
  if (!fs.existsSync(file)) usageDie(`판정부 자기검사 파일이 없다: ${file} — 조용히 건너뛰지 않는다.`);
  const result = spawnSync(process.execPath, ['--test', file], { cwd: REPO_ROOT, env: childEnv(), encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(String(result.stdout ?? '') + String(result.stderr ?? ''));
    usageDie(`판정부 자기검사가 실패했다(node --test ${label}) — 빨간 판정부로는 부하를 걸지 않는다.`);
  }
  process.stdout.write(`  판정부 자기검사 통과 (node --test ${label})\n`);
}

// --- 환경 조립 (spool-parity childEnv 동형 — 부모 env 통째 상속 금지) ---
const OS_ENV_ALLOWLIST = process.platform === 'win32'
  ? ['SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']
  : ['PATH', 'HOME', 'LANG', 'TZ'];

function childEnv() {
  const env = {};
  for (const key of OS_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function serverEnv(dataDir, port, spoolDir) {
  return { ...childEnv(), DATA_DIR: dataDir, PORT: String(port), HOST: CONNECT_HOST, DIST_SPOOL_DIR: spoolDir };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childDead = (child) => child.exitCode !== null || child.signalCode !== null || child.spawnError !== undefined;

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (childDead(child)) return resolve(true);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, ms);
    child.once('exit', onExit);
  });
}

async function killChild(child) {
  if (!child || childDead(child)) return true;
  child.kill();
  if (await waitExit(child, 2000)) return true;
  child.kill('SIGKILL');
  return waitExit(child, 3000);
}

function collectOutput(child) {
  const buf = { out: '', err: '' };
  child.stdout.on('data', (c) => { buf.out += c; });
  child.stderr.on('data', (c) => { buf.err += c; });
  return buf;
}

async function pickFreePort(taken) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = PORT_BASE + Math.floor(Math.random() * PORT_SPAN);
    if (taken.has(candidate)) continue;
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(candidate, CONNECT_HOST, () => srv.close(() => resolve(true)));
    });
    if (free) { taken.add(candidate); return candidate; }
  }
  throw new Error(`빈 포트를 찾지 못했다([${PORT_BASE}, ${PORT_BASE + PORT_SPAN}) 20회 시도) — 환경 이상`);
}

async function waitHealthy(baseUrl, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childDead(child)) return false;
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 && (await res.json()).ok === true) return true;
    } catch { /* 기동 전 — 재시도 */ }
    await sleep(200);
  }
  return false;
}

function repoDataSnapshot() {
  const dbFile = nodePath.join(REPO_ROOT, 'news.db');
  const uploadsDir = nodePath.join(REPO_ROOT, 'uploads');
  const st = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  return {
    db: st ? { size: st.size, mtimeMs: st.mtimeMs } : null,
    uploads: fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : null,
  };
}

function resolveJar(given) {
  if (given) {
    const abs = nodePath.resolve(given);
    if (!fs.existsSync(abs)) usageDie(`--jar 파일이 존재하지 않는다: ${abs}`);
    return abs;
  }
  if (!fs.existsSync(SPRING_TARGET_DIR)) usageDie(`Spring 실행 jar가 없다(${SPRING_TARGET_DIR} 없음). 먼저 빌드하라:\n  ${BUILD_HINT}`);
  const candidates = fs.readdirSync(SPRING_TARGET_DIR).filter((f) => f.endsWith('.jar') && !/-(sources|javadoc|tests)\.jar$/.test(f)).sort();
  if (candidates.length === 0) usageDie(`Spring 실행 jar가 없다(${SPRING_TARGET_DIR}). 먼저 빌드하라:\n  ${BUILD_HINT}`);
  if (candidates.length > 1) usageDie(`Spring 실행 jar 후보가 여럿이다 — --jar로 지정하라: ${candidates.join(', ')}`);
  return nodePath.join(SPRING_TARGET_DIR, candidates[0]);
}

function resolveMigratorJar() {
  if (!fs.existsSync(MIGRATOR_JAR)) usageDie(`마이그레이터 jar 가 필요하다(${MIGRATOR_JAR} 없음). 먼저 빌드하라:\n  ${MIGRATOR_BUILD_HINT}`);
  return MIGRATOR_JAR;
}

function resolveJavaBin(given) {
  const home = given || process.env.SPRING_JAVA_HOME || process.env.JAVA_HOME;
  if (!home || String(home).trim() === '') usageDie(`JDK 홈을 찾지 못했다 — --java-home <path> 또는 SPRING_JAVA_HOME/JAVA_HOME 을 설정하라(예: ${JDK_HINT}).`);
  const bin = nodePath.join(nodePath.resolve(home), 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (!fs.existsSync(bin)) usageDie(`JDK 홈에 java 실행 파일이 없다: ${bin}`);
  return bin;
}

function assertOutsideRepo(dir, label) {
  const abs = nodePath.resolve(dir);
  if (pathIsInside(abs, REPO_ROOT, process.platform)) usageDie(`${label}는 리포 안에 둘 수 없다: ${abs}`);
  return abs;
}

function seedTarget(root, label) {
  const dataDir = nodePath.join(root, label, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const seedFile = nodePath.join(dataDir, 'news.db');
  const db = new DatabaseSync(seedFile);
  createSchema(db);
  seedUsers(db);
  db.close();
  const spoolDir = nodePath.join(root, label, 'spool');
  fs.mkdirSync(spoolDir);
  return { dataDir, seedFile, spoolDir };
}

function scrubPaths(text, replacements) {
  let out = String(text ?? '');
  for (const [needle, mask] of replacements) {
    for (const variant of new Set([needle, needle.replace(/\\/g, '/'), needle.replace(/\//g, '\\')])) {
      if (variant) out = out.split(variant).join(mask);
    }
  }
  return out;
}

function scrub(ctx, label, text) {
  const result = redactSecrets(text, ctx.secrets);
  if (result.hits > 0) ctx.secretLeaks.push(`${label} 출력에 비밀 값이 ${result.hits}회 섞여 나왔다 — 가려서 남겼지만 원인을 고쳐라.`);
  if (result.unredactable > 0) ctx.secretLeaks.push(`${label}: 가릴 수 없는 짧은 비밀이 ${result.unredactable}건 있다(docs/ops-mysql.md §3-1).`);
  return result.text;
}

// --- MySQL 축 — 마이그레이터 jar 가 유일한 통로다(spool-parity 동형) ---
function runMigrator(ctx, cwd, args, passUrl) {
  return new Promise((resolve) => {
    const child = spawn(ctx.javaBin, ['-jar', ctx.migratorJar, ...args], {
      cwd, env: migratorChildEnv(childEnv(), ctx.mysql, passUrl), stdio: ['ignore', 'pipe', 'pipe'],
    });
    // SIGINT 핸들러가 죽일 수 있게 등록한다(step7·step8 리뷰가 확정한 형태).
    ctx.children.push(child);
    const buf = collectOutput(child);
    child.once('error', (err) => {
      child.spawnError = err;
      resolve({ ok: false, code: null, out: buf.out, err: `${buf.err}\nspawn error: ${err && err.code ? err.code : err}` });
    });
    child.once('close', (code) => resolve({ ok: code === 0, code, out: buf.out, err: buf.err }));
  });
}

function dropEphemeralSync(ctx, cwd, name) {
  const result = spawnSync(ctx.javaBin, ['-jar', ctx.migratorJar, 'ephemeral-drop', '--name', name], {
    cwd, env: migratorChildEnv(childEnv(), ctx.mysql, null), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000,
  });
  if (result.status === 0) return true;
  process.stderr.write(`${scrub(ctx, 'migrator ephemeral-drop(SIGINT)', `${result.stdout ?? ''}${result.stderr ?? ''}`).slice(-2000)}\n`);
  return false;
}

async function migratorStep(ctx, cwd, args, passUrl, failures) {
  const result = await runMigrator(ctx, cwd, args, passUrl);
  const text = scrub(ctx, `[spring] migrator ${args[0]}`, `${result.out}${result.err}`);
  if (!result.ok) failures.push(`[spring] 마이그레이터 실패(${args[0]} exit=${result.code})\n--- migrator 출력 ---\n${text}`);
  return result.ok;
}

// --- HTTP — 세션 토큰은 메모리에만 있고 어떤 메시지에도 담지 않는다 ---
async function api(baseUrl, method, path, { sid, body, timeoutMs = 15000 } = {}) {
  const headers = {};
  if (sid) headers['x-session-id'] = sid;
  let payload;
  if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, json, ms: Date.now() - started, bodyBytes: Buffer.byteLength(text, 'utf8') };
  }
  catch (err) {
    // 클라이언트 타임아웃·소켓 오류도 관측이다 — 상태코드 0 으로 남긴다(조용히 버리지 않는다).
    return { status: 0, json: undefined, ms: Date.now() - started, error: err && err.name ? err.name : String(err) };
  }
}

async function login(baseUrl, role) {
  const user = SAMPLE_USERS.find((u) => u.role === role);
  if (!user) throw new Error(`SAMPLE_USERS 에 ${role} 역할 계정이 없다 — src/db/seed.js 확인`);
  const res = await api(baseUrl, 'POST', '/api/login', { body: { userId: user.userId, password: user.password } });
  if (res.status !== 200 || typeof res.json?.sessionId !== 'string') {
    throw new Error(`login 거부 role=${role} status=${res.status} reason=${res.json?.reason ?? '-'}`);
  }
  return res.json.sessionId;
}

// --- 부하 실행부 -------------------------------------------------------------------------------

/**
 * 동시 요청 수를 고정한 채 `total` 건을 흘려보낸다. **실제 동시 실행 최댓값을 함께 재는 것**이 핵심이다 —
 * 그 값이 목표에 못 미치면 그 계단의 수치는 "그 부하에서의 값"이 아니다(판정부 judgeLoadSelfCheck).
 */
async function runStage(makeRequest, concurrency, total) {
  const samples = [];
  let issued = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const worker = async () => {
    while (issued < total) {
      issued += 1;
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      const res = await makeRequest(issued);
      inFlight -= 1;
      samples.push({ ms: res.ms, status: res.status });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { samples, maxInFlight };
}

/** 읽기 위주 — 목록과 상세를 번갈아 친다(둘 다 DB 를 읽는다). */
function readRequest(target) {
  return (n) => (n % 2 === 0
    ? api(target.baseUrl, 'GET', '/api/articles', { sid: target.sidZ, timeoutMs: 60000 })
    : api(target.baseUrl, 'GET', `/api/articles/${target.fixtures[n % target.fixtures.length]}`, { sid: target.sidZ, timeoutMs: 60000 }));
}

/** 쓰기 혼합 — 생성·수정·잠금. 송고(action)는 넣지 않는다: 스풀 파일을 만들면 재는 것이 디스크가 된다. */
function writeRequest(target) {
  return (n) => {
    const pick = n % 3;
    const id = target.fixtures[n % target.fixtures.length];
    if (pick === 0) {
      return api(target.baseUrl, 'POST', '/api/articles', {
        sid: target.sidD, timeoutMs: 60000,
        body: { title: `부하 ${n}`, author: 'load', department: '편집', markupVersion: '1' },
      });
    }
    if (pick === 1) {
      return api(target.baseUrl, 'PUT', `/api/articles/${id}`, { sid: target.sidD, timeoutMs: 60000, body: { keyword: `k${n}` } });
    }
    return api(target.baseUrl, 'POST', `/api/articles/${id}/lock`, { sid: target.sidD, timeoutMs: 60000 });
  };
}

/** SSE 를 연다 — 열어 두는 것이 목적이라 프레임은 읽어서 버린다. 반환값의 close() 로 닫는다. */
function openStream(target) {
  const controller = new AbortController();
  const done = fetch(`${target.baseUrl}/api/stream`, {
    headers: { 'x-session-id': target.sidZ, accept: 'text/event-stream' },
    signal: controller.signal,
  }).then(async (res) => {
    if (res.status !== 200 || !res.body) throw new Error(`SSE 연결 실패 status=${res.status}`);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done: end } = await reader.read();
        if (end) break;
      }
    }
    catch { /* abort 로 끊는다 — 정상 경로다 */ }
  }).catch(() => { /* abort */ });
  return { close: () => { controller.abort(); return done; } };
}

async function measureAxis(ctx, targets, axisName, makeRequest, opts, rows) {
  for (const target of targets) {
    for (const concurrency of LADDER) {
      for (let round = 1; round <= opts.rounds; round += 1) {
        const total = concurrency * REQUESTS_PER_SLOT;
        const { samples, maxInFlight } = await runStage(makeRequest(target), concurrency, total);
        const summary = summarise(samples);
        rows.push({ axis: axisName, target: target.label, concurrency, round, summary, maxInFlight });
        ctx.stages.push({ axis: axisName, target: target.label, concurrency, round, summary, maxInFlight });
        process.stdout.write(`  [${target.label}] ${axisName} 동시 ${String(concurrency).padStart(2)} 회차 ${round}`
          + ` → 요청 ${summary.count} p50 ${summary.p50}ms p95 ${summary.p95}ms 최대 ${summary.max}ms 5xx ${summary.errors5xx} 실제동시 ${maxInFlight}\n`);
      }
    }
  }
}

// --- 30초 경계 축 — 외부 세션이 행 잠금을 쥐고 Spring 의 유일 커넥션을 묶는다 ---------------------

/**
 * MySQL CLI 로 **행 잠금을 쥔 세션**을 띄운다(자격은 argv 가 아니라 임시 defaults 파일 · 리포 밖 · 끝나면 지운다).
 *
 * 왜 이 방법인가: 풀 1 의 30초 천장은 "요청이 많아서"가 아니라 **커넥션 하나가 오래 잡히면** 닿는다. 라우트만으로는
 * 그 상태를 만들 수 없어서(178행짜리 DB 는 밀리초에 끝난다) 저장소 쪽에서 잠금을 만든다 — 이것이 실제 운영에서
 * 일어나는 일(느린 쿼리·잠금 대기)의 가장 단순한 재현이다.
 */
function holdRowLock(ctx, root, dbName, articleId) {
  if (!fs.existsSync(MYSQL_CLI)) return null;
  const cnf = nodePath.join(root, `probe-${Date.now()}.cnf`);
  const url = new URL(ctx.mysql.url.replace(/^jdbc:mysql:/, 'mysql:'));
  fs.writeFileSync(cnf, `[client]\nuser=${ctx.mysql.username}\npassword=${ctx.mysql.password}\nhost=${url.hostname || '127.0.0.1'}\nport=${url.port || '3306'}\n`);
  const sql = `USE \`${dbName}\`; START TRANSACTION;`
    + ` SELECT articleId FROM Contents WHERE articleId = '${articleId}' FOR UPDATE;`
    + ` SELECT SLEEP(${LOCK_HOLD_SEC}); COMMIT;`;
  const child = spawn(MYSQL_CLI, [`--defaults-extra-file=${cnf}`, '-N', '-e', sql], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.children.push(child);
  const buf = collectOutput(child);
  child.once('error', (err) => { child.spawnError = err; });
  return {
    child,
    buf,
    release: async () => {
      await killChild(child);
      try { fs.rmSync(cnf, { force: true }); } catch { /* 지워지지 않아도 리포 밖이다 */ }
    },
  };
}

// --- 리포트 ------------------------------------------------------------------------------------

function stageRowsFor(rows, axis) {
  return rows.filter((r) => r.axis === axis).map((r) => ({ target: r.target, concurrency: r.concurrency, round: r.round, summary: r.summary, maxInFlight: r.maxInFlight }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  process.stdout.write(`pool-ceiling-probe 시작 axis=${opts.axis} rounds=${opts.rounds}\n`);
  runSelfTest(SELF_TEST, 'scripts/lib/poolProbe.self-test.mjs');
  runSelfTest(MYSQL_SELF_TEST, 'scripts/lib/mysqlHarness.test.mjs');

  const jar = resolveJar(opts.jar);
  const javaBin = resolveJavaBin(opts.javaHome);
  const migratorJar = resolveMigratorJar();
  let mysql = null;
  try { mysql = readMysqlCredentials(process.env); } catch (err) { usageDie(err.message); }
  for (const warning of mysql.warnings) process.stderr.write(`${warning}\n`);

  const givenOutDir = opts.outDir ? assertOutsideRepo(opts.outDir, '--out-dir') : null;
  const root = assertOutsideRepo(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pool-ceiling-')), '임시 루트');
  const outDir = givenOutDir ?? nodePath.join(root, 'reports');
  fs.mkdirSync(outDir, { recursive: true });

  const ctx = { javaBin, migratorJar, mysql, secrets: [mysql.password], secretLeaks: [], children: [], stages: [] };
  const repoBefore = repoDataSnapshot();
  const failures = [];
  const report = { axis: opts.axis, rounds: opts.rounds, ladder: [...LADDER], stages: [], userId: [], timeout: null };
  const targets = [
    { label: 'node', bin: process.execPath, argv: [NODE_SERVER], db: 'sqlite' },
    { label: 'spring', bin: javaBin, argv: ['-jar', jar], db: 'mysql' },
  ];
  const bootLogs = {};
  const rows = [];
  let ephemeralDb = null;
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) return;
    interrupted = true;
    for (const child of ctx.children) { try { child.kill('SIGKILL'); } catch { /* 이미 죽음 */ } }
    if (ephemeralDb) {
      if (dropEphemeralSync(ctx, root, ephemeralDb)) process.stderr.write(`warn 중단 — 임시 MySQL DB 드롭 완료: ${ephemeralDb}\n`);
      else process.stderr.write(`warn 중단으로 남은 임시 MySQL DB(드롭 실패 — 직접 지워라): ${ephemeralDb}\n`);
    }
    process.exit(130);
  });

  try {
    // 1. 시드 → [mysql 적재] → 기동
    const taken = new Set();
    for (const target of targets) Object.assign(target, seedTarget(root, target.label));
    for (const target of targets) {
      target.port = await pickFreePort(taken);
      target.baseUrl = `http://${CONNECT_HOST}:${target.port}`;
      const env = serverEnv(target.dataDir, target.port, target.spoolDir);
      if (target.label === 'spring') {
        ephemeralDb = requireEphemeralDbName(ephemeralDbName());
        const passUrl = urlForDatabase(mysql.url, ephemeralDb);
        if (!await migratorStep(ctx, root, ['ephemeral-create', '--name', ephemeralDb], null, failures)) throw new Error('ephemeral-create 실패');
        if (!await migratorStep(ctx, root, ['migrate', '--source', target.seedFile, '--target', PASS_KEY_SET], passUrl, failures)) throw new Error('migrate 실패');
        Object.assign(env, springMysqlEnv(mysql, passUrl));
        process.stdout.write(`  [spring] mysql 적재 db=${ephemeralDb}\n`);
      }
      target.child = spawn(target.bin, target.argv, { cwd: nodePath.join(root, target.label), env, stdio: ['ignore', 'pipe', 'pipe'] });
      target.child.on('error', (err) => {
        target.child.spawnError = err;
        failures.push(`[${target.label}] 자식 프로세스 오류(spawn/kill): ${err && err.code ? err.code : err}`);
      });
      ctx.children.push(target.child);
      target.buf = collectOutput(target.child);
      process.stdout.write(`  [${target.label}] 기동 pid=${target.child.pid ?? '-'} port=${target.port} db=${target.db}\n`);
    }
    for (const target of targets) {
      const bootStart = Date.now();
      if (!await waitHealthy(target.baseUrl, opts.timeout, target.child)) {
        failures.push(`[${target.label}] 기동/health 실패(${Date.now() - bootStart}ms exit=${target.child.exitCode})`);
        continue;
      }
      process.stdout.write(`  [${target.label}] health ok ${Date.now() - bootStart}ms\n`);
    }
    if (failures.length > 0) throw new Error('서버 기동 실패 — 부하를 걸지 않는다');

    // 2. 세션·고정 기사(두 서버에 같은 수를 만든다 — 목록 길이가 다르면 읽기 축이 다른 일을 재게 된다)
    for (const target of targets) {
      target.sidD = await login(target.baseUrl, 'D');
      target.sidZ = await login(target.baseUrl, 'Z');
      target.fixtures = [];
      for (let i = 0; i < FIXTURE_ARTICLES; i += 1) {
        const created = await api(target.baseUrl, 'POST', '/api/articles', {
          sid: target.sidD, body: { title: `고정 ${i}`, author: 'probe', department: '편집', markupVersion: '1' },
        });
        if (created.status !== 200 || typeof created.json?.articleId !== 'string') {
          throw new Error(`[${target.label}] 고정 기사 생성 실패 status=${created.status}`);
        }
        target.fixtures.push(created.json.articleId);
      }
      process.stdout.write(`  [${target.label}] 고정 기사 ${target.fixtures.length}건\n`);
    }

    // 3. 부하 축
    if (opts.axis === 'all' || opts.axis === 'load') {
      await measureAxis(ctx, targets, 'read', readRequest, opts, rows);
      await measureAxis(ctx, targets, 'write', writeRequest, opts, rows);
    }
    if (opts.axis === 'all' || opts.axis === 'sse') {
      const streams = [];
      for (const target of targets) {
        for (let i = 0; i < SSE_CONNECTIONS; i += 1) streams.push(openStream(target));
      }
      await sleep(1000); // 연결이 실제로 서 있는 상태에서 재기 위한 정착 대기
      try {
        await measureAxis(ctx, targets, 'read+sse', readRequest, opts, rows);
        await measureAxis(ctx, targets, 'write+sse', writeRequest, opts, rows);
      } finally {
        for (const s of streams) await s.close();
      }
    }

    // 4. 30초 경계 축(Spring · MySQL 전용) — Node 는 풀이라는 개념이 없다(대응물 없음을 기록한다)
    if ((opts.axis === 'all' || opts.axis === 'timeout') && ephemeralDb) {
      const spring = targets.find((t) => t.label === 'spring');
      const victim = spring.fixtures[0];
      const holder = holdRowLock(ctx, root, ephemeralDb, victim);
      if (!holder) {
        report.timeout = { measured: false, reason: `MySQL CLI 가 없다(${MYSQL_CLI}) — 30초 경계는 재지 못했다` };
        process.stdout.write(`  [spring] 30초 경계 미측정: MySQL CLI 없음\n`);
      }
      else {
        await sleep(2000); // 잠금 세션이 실제로 행을 쥘 때까지
        const blocked = api(spring.baseUrl, 'POST', `/api/articles/${victim}/lock`, { sid: spring.sidD, timeoutMs: 120000 });
        await sleep(1500); // 그 요청이 커넥션을 쥔 상태를 만든다
        const started = Date.now();
        const waiter = await api(spring.baseUrl, 'GET', '/api/articles', { sid: spring.sidZ, timeoutMs: 120000 });
        const blockedResult = await blocked;
        report.timeout = {
          measured: true,
          waitMs: Date.now() - started,
          waiterStatus: waiter.status,
          waiterReason: waiter.json?.reason ?? null,
          waiterBodyKeys: waiter.json ? Object.keys(waiter.json).sort() : null,
          blockedStatus: blockedResult.status,
          blockedMs: blockedResult.ms,
          hikariTimeoutMs: HIKARI_CONNECTION_TIMEOUT_MS,
        };
        process.stdout.write(`  [spring] 30초 경계: 뒤 요청 ${report.timeout.waitMs}ms → status ${waiter.status}`
          + ` reason ${report.timeout.waiterReason ?? '-'} · 앞 요청(잠금 대기) ${blockedResult.ms}ms → status ${blockedResult.status}\n`);
        await holder.release();
      }
      // Node 축은 구조적으로 없다 — "재지 않았다"가 아니라 "그 개념이 없다"를 남긴다.
      report.timeoutNode = 'Node 는 단일 프로세스·동기 SQLite 라 커넥션 풀·획득 대기가 없다(대응물 없음).';
    }

    // 5. 769자 텍스트 PK 축(U3·U4) — 값은 싣지 않고 길이와 상태코드만 남긴다
    if (opts.axis === 'all' || opts.axis === 'userid') {
      for (const c of buildUserIdCases()) {
        const observed = { id: c.id, chars: c.chars, bytes: c.bytes };
        for (const target of targets) {
          const res = await api(target.baseUrl, 'POST', '/api/users', {
            sid: target.sidZ, timeoutMs: 30000,
            body: { userId: c.userId, password: 'probe-pw', name: 'probe', role: 'D', department: '편집', departmentCode: '01' },
          });
          observed[target.label] = res.status;
          observed[`${target.label}Reason`] = res.json?.reason ?? null;
        }
        report.userId.push(observed);
        process.stdout.write(`  769축 ${c.id.padEnd(11)} 글자 ${c.chars} 바이트 ${String(c.bytes).padStart(4)}`
          + ` → node ${observed.node} spring ${observed.spring}(${observed.springReason ?? '-'})\n`);
      }
      const verdict = judgeUserIdAxis(report.userId);
      if (!verdict.ok) failures.push(...verdict.failures.map((f) => `769자 축: ${f}`));
    }

    // 6. 부하 자기검사(U2) — 프로브가 실제로 부하를 걸었는가
    const selfCheck = judgeLoadSelfCheck(ctx.stages);
    if (selfCheck.length > 0) failures.push(...selfCheck.map((p) => `부하 자기검사: ${p}`));
  }
  catch (err) {
    failures.push(`실행 예외: ${err && err.stack ? err.stack : err}`);
  }
  finally {
    for (const child of ctx.children) {
      try { if (!await killChild(child)) failures.push(`자식 프로세스 종료 실패 pid=${child.pid}`); }
      catch (err) { failures.push(`자식 종료 중 예외: ${err && err.message ? err.message : err}`); }
    }
    if (ephemeralDb) {
      const dropped = await migratorStep(ctx, root, ['ephemeral-drop', '--name', ephemeralDb], null, failures);
      if (dropped) { process.stdout.write(`  [spring] mysql 임시 DB 드롭 ${ephemeralDb}\n`); ephemeralDb = null; }
      else process.stderr.write(`warn 임시 MySQL DB 정리 실패(직접 지워라): ${ephemeralDb}\n`);
    }
    for (const target of targets) {
      if (!target.child) continue;
      try {
        const text = scrub(ctx, `[${target.label}]`, `${target.buf.out}\n--- stderr ---\n${target.buf.err}`);
        bootLogs[target.label] = scrubPaths(text, [[root, '<tmp>'], [REPO_ROOT, '<repo>']]);
        fs.writeFileSync(nodePath.join(outDir, `${target.label}-boot.log`), bootLogs[target.label]);
      }
      catch (err) { failures.push(`[${target.label}] 기동 로그 기록 실패: ${err && err.code ? err.code : err}`); }
    }
  }

  // 7. 진단 가능성 — 769자 실패가 **조용하지 않은지**(값이 아니라 표식의 유무만 센다)
  const springLog = bootLogs.spring ?? '';
  report.springLogMarkers = {
    dataTooLong: (springLog.match(/Data too long/gi) ?? []).length,
    code1406: (springLog.match(/1406/g) ?? []).length,
    userIdColumn: (springLog.match(/'userId'/g) ?? []).length,
    mysqlDataException: (springLog.match(/MysqlDataTruncation|DataException|SQLException/g) ?? []).length,
  };

  // 8. 데이터 안전 · 잔존 · 비밀 위생
  const repoAfter = repoDataSnapshot();
  if (JSON.stringify(repoBefore) !== JSON.stringify(repoAfter)) failures.push(`리포 news.db/uploads 변동: before=${JSON.stringify(repoBefore)} after=${JSON.stringify(repoAfter)}`);
  failures.push(...ctx.secretLeaks);

  report.stages = rows.map((r) => ({ axis: r.axis, target: r.target, concurrency: r.concurrency, round: r.round, maxInFlight: r.maxInFlight, ...r.summary }));
  const readRows = stageRowsFor(rows, 'read');
  const serviceMs = readRows.find((r) => r.target === 'spring' && r.concurrency === 1)?.summary.p50 ?? null;
  report.queueDepthForTimeout = serviceMs === null ? null : queueDepthForTimeout({ serviceMs, timeoutMs: HIKARI_CONNECTION_TIMEOUT_MS, poolSize: 1 });
  fs.writeFileSync(nodePath.join(outDir, 'pool-ceiling.json'), `${JSON.stringify(report, null, 2)}\n`);

  const axesSeen = [...new Set(rows.map((r) => r.axis))];
  for (const axis of axesSeen) {
    process.stdout.write(`\n### 축 ${axis}\n${formatStageTable(stageRowsFor(rows, axis))}\n`);
  }
  if (report.userId.length > 0) {
    process.stdout.write(`\n### 769자 텍스트 PK 축\n${formatUserIdTable(report.userId)}\n`);
    process.stdout.write(`Spring 로그 표식: ${JSON.stringify(report.springLogMarkers)}\n`);
  }
  if (report.timeout) process.stdout.write(`\n### 30초 경계\n${JSON.stringify(report.timeout)}\n`);
  if (report.queueDepthForTimeout !== null) {
    process.stdout.write(`\n30초 천장까지 필요한 큐 깊이(풀 1 · 읽기 p50 ${serviceMs}ms 기준): 약 ${report.queueDepthForTimeout} 건\n`);
  }

  const ok = failures.length === 0;
  if (ok && !opts.keep) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (err) { process.stderr.write(`warn 임시 디렉토리 정리 실패(무해): ${root} (${err && err.code})\n`); }
  }
  else process.stdout.write(`keep 임시 디렉토리 보존(${ok ? '--keep' : '실패 진단용'}): ${root}\n`);
  if (!ok) process.stderr.write(`${failures.map((f) => `FAIL ${f}`).join('\n')}\n`);
  process.stdout.write(`pool-ceiling-probe 관측 ${rows.length}계단 · 769축 ${report.userId.length} → ${ok ? 'ok' : 'FAILED'}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`pool-ceiling-probe 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
