// 운영 tick 전환 왕복 프로브 (phase 76 step7 — 로드맵 P3 완료 게이트 ③ 「운영 cron tick 전환」의 자동 판정).
// 임시 Node·Spring 을 나란히 띄우고 packaging/server/README-배포.md §6 의 운영 스크립트와 **같은 형태의 호출**
// (POST /api/login → 본문 sessionId → POST /api/distribution/tick + x-session-id 헤더 · Origin/Referer 없음)을 재현해
// 두 대상의 표를 나란히 산출한다(다르면 그것이 발견이다). 멱등은 응답이 아니라 **스풀 파일 수**로 본다.
// 같은 자리에서 Spring 용 스크립트 packaging/server/tick-distribution-spring.ps1 을 실제로 실행해 종료코드·로그 위생을 잰다.
//
// 사용: node scripts/tick-cutover-probe.mjs [--db <sqlite|mysql>] [--jar <path>] [--java-home <path>] [--out-dir <dir>] [--keep]
//                                          [--timeout <ms>] [--rounds <n>]
//   --db mysql 이면 A-2(다중 인스턴스 중복 배부 실측)까지 돈다: Spring 2개(다른 포트 · **같은 MySQL 임시 DB** · 같은 DIST_SPOOL_DIR ·
//   같은 DATA_DIR)와 Node 2개(같은 DATA_DIR — 두 번째가 ADR-012 잠금에 막히는지)를 띄워 스풀 파일 수를 파일시스템에서 센다.
//   sqlite 모드는 A(왕복 표)와 S6(Node 2개)만 재고 A-2 의 Spring 쌍은 **재지 않았다고 명시**한다(조용히 통과하지 않는다).
//
// 절차(scripts/spool-parity.mjs 의 규율을 베꼈고 그 파일은 고치지 않는다):
//   자기검사(node --test scripts/lib/tickCutover.self-test.mjs) → 리포 밖 임시 루트 → 인스턴스별 임시 DATA_DIR 시드(src/db/**) →
//   [mysql: ephemeral-create → migrate → Spring DB_KIND=mysql] → 빈 포트 → 기동(env = OS 허용목록 + DATA_DIR·PORT·HOST[·DIST_SPOOL_DIR] ·
//   SPA_DIR 미주입) → /api/health → 왕복 표(Node·Spring) → ps1 실행 7종 → S6/A-2 → 판정 → 자식 종료 → [mysql: ephemeral-drop] → 정리.
//
// CRITICAL(DB 비파괴): 리포 news.db·uploads/ 에 쓰지 않는다(실행 전후 스냅샷 무변 단언). DIST_SPOOL_DIR 은 리포 밖 임시만.
// CRITICAL(레이트리밋): 인스턴스당 로그인 수를 세어 두었다 — 왕복 대상 7회 · 무스풀 대상 11회(11번째 429 실측이 목적). 행을 더할 때 이 수를 넘기지 마라.
// 로그 규율: 세션 토큰·비밀번호·MySQL 자격·스풀 절대경로를 stdout/stderr/리포트 어디에도 쓰지 않는다. 자식 출력은 redactSecrets 로 훑는다.
// 주의: scripts/** 는 eslint ignore 대상이다 — 인자 가드(scripts/lib/cliArgs.mjs)와 자기검사가 정적 안전망이다.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSchema } from '../src/db/schema.js';
import { seedUsers, SAMPLE_USERS } from '../src/db/seed.js';
import { flagValue } from './lib/cliArgs.mjs';
import {
  CT_KEY_SET, PASS_KEY_SET, ephemeralDbName, requireEphemeralDbName, urlForDatabase,
  readMysqlCredentials, migratorChildEnv, springMysqlEnv, redactSecrets,
} from './lib/mysqlHarness.mjs';
import { pathIsInside } from './lib/spoolParity.mjs';
import {
  PS1_ENV, countSpoolFiles, describeLogin, describeTick, duplicateArticles, formatMultiInstance, formatRateLimitTable,
  formatSideBySide, judgeMultiInstance, judgeRoundtrip, outputLeaks, rateLimitTable, sanitizePs1Sample, spoolPathLeaks, criticalPeriodSec, tokenShapeLeaks,
} from './lib/tickCutover.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const NODE_SERVER = nodePath.join(REPO_ROOT, 'server', 'index.js');
const SPRING_TARGET_DIR = nodePath.join(REPO_ROOT, 'server-spring', 'target');
const MIGRATOR_JAR = nodePath.join(REPO_ROOT, 'tools', 'news-migrator', 'target', 'news-migrator.jar');
const PS1 = nodePath.join(REPO_ROOT, 'packaging', 'server', 'tick-distribution-spring.ps1');
const SELF_TEST = nodePath.join(nodePath.dirname(SCRIPT_PATH), 'lib', 'tickCutover.self-test.mjs');
const MYSQL_SELF_TEST = nodePath.join(nodePath.dirname(SCRIPT_PATH), 'lib', 'mysqlHarness.test.mjs');
const CONNECT_HOST = '127.0.0.1';
const PORT_BASE = 15000; // spring-contract·spa-parity·spool-parity 와 같은 구간(동시 실행 금지 규율)
const PORT_SPAN = 5000;
const JDK_HINT = 'D:/agents/tools/jdk-25.0.4.1+1';
const BUILD_HINT = `cd server-spring && JAVA_HOME="${JDK_HINT}" ./mvnw -B -q clean package -DskipTests`;
const MIGRATOR_BUILD_HINT = `cd tools/news-migrator && JAVA_HOME="${JDK_HINT}" ./mvnw -B -q package -DskipTests`;
const DB_KINDS = ['sqlite', 'mysql'];
const PRESS_SLUG = 'tc-press';
const END_MARKER = '(끝)';
const POWERSHELL = nodePath.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const USAGE = `사용법: node scripts/tick-cutover-probe.mjs [--db <sqlite|mysql>] [--jar <path>] [--java-home <path>] [--out-dir <dir>] [--keep] [--timeout <ms>] [--rounds <n>]
  --db <kind>        Spring 왕복 대상의 저장소(기본 sqlite). mysql 이면 임시 DB(harness_ct_<16hex>)에 시드를 적재하고 **A-2(Spring 2개 · 같은 DB)** 까지 잰다
                     (${CT_KEY_SET}_URL/_USERNAME/_PASSWORD 필요 · 없으면 즉시 실패). sqlite 모드는 A-2 의 Spring 쌍을 재지 않는다(명시 출력).
  --jar <path>       Spring 실행 jar. 미지정=server-spring/target/*.jar 자동 탐색(자동 빌드는 하지 않는다).
  --java-home <path> JDK 홈. 미지정=SPRING_JAVA_HOME → JAVA_HOME 순(시스템 java 폴백 금지).
  --out-dir <dir>    리포트 디렉토리. 미지정=OS 임시 디렉토리. **리포 안에는 쓰지 않는다.**
  --keep             임시 디렉토리(스풀 파일 포함)를 지우지 않는다(실패 시에는 항상 보존).
  --timeout <ms>     기동·조건 대기 한도(기본 60000, 1000 이상 정수).
  --rounds <n>       A-2 동시 tick 회차(기본 5, 1 이상 정수).`;

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
  const opts = { keep: false, timeout: 60000, db: 'sqlite', rounds: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--jar') { opts.jar = take(i, '--jar'); i += 1; }
    else if (a === '--java-home') { opts.javaHome = take(i, '--java-home'); i += 1; }
    else if (a === '--out-dir') { opts.outDir = take(i, '--out-dir'); i += 1; }
    else if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') { opts.timeout = Number(take(i, '--timeout')); i += 1; }
    else if (a === '--rounds') { opts.rounds = Number(take(i, '--rounds')); i += 1; }
    else if (a === '--db') { opts.db = take(i, '--db'); i += 1; }
    else usageDie(`알 수 없는 인자: ${a}`);
  }
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) usageDie(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${opts.timeout}`);
  if (!Number.isInteger(opts.rounds) || opts.rounds < 1) usageDie(`--rounds 값이 유효하지 않다(1 이상 정수): ${opts.rounds}`);
  if (!DB_KINDS.includes(opts.db)) usageDie(`--db 값이 유효하지 않다(${DB_KINDS.join('|')}): ${opts.db}`);
  return opts;
}

// --- 자기검사 — 판정부가 빨간 채로는 서버를 띄우지 않는다 ---
function runSelfTest(file, label) {
  if (!fs.existsSync(file)) usageDie(`판정부 자기검사 파일이 없다: ${file} — 조용히 건너뛰지 않는다.`);
  const result = spawnSync(process.execPath, ['--test', file], { cwd: REPO_ROOT, env: childEnv(), encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(String(result.stdout ?? '') + String(result.stderr ?? ''));
    usageDie(`판정부 자기검사가 실패했다(node --test ${label}) — 판정·ps1 정적 검사가 깨진 채로는 재지 않는다.`);
  }
  process.stdout.write(`  판정부 자기검사 통과 (node --test ${label})\n`);
}

// --- 환경 조립 (spool-parity 동형 — 부모 env 통째 상속 금지) ---
const OS_ENV_ALLOWLIST = process.platform === 'win32'
  ? ['SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']
  : ['PATH', 'HOME', 'LANG', 'TZ'];

function childEnv() {
  const env = {};
  for (const key of OS_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function serverEnv(dataDir, port, spoolDir) {
  const env = { ...childEnv(), DATA_DIR: dataDir, PORT: String(port), HOST: CONNECT_HOST };
  if (spoolDir) env.DIST_SPOOL_DIR = spoolDir; // 미설정 = 배부 비활성(503 spool-disabled 행의 대상)
  return env;
}

// --- 자식 프로세스 유틸 ---
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
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000), headers: { connection: 'close' } });
      if (res.status === 200 && (await res.json()).ok === true) return true;
    } catch { /* 기동 전 — 재시도 */ }
    await sleep(200);
  }
  return false;
}

async function isHealthy(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000), headers: { connection: 'close' } });
    return res.status === 200 && (await res.json()).ok === true;
  } catch { return false; }
}

// --- 리포 데이터 안전 스냅샷 · 파일 지문 ---
function repoDataSnapshot() {
  const dbFile = nodePath.join(REPO_ROOT, 'news.db');
  const uploadsDir = nodePath.join(REPO_ROOT, 'uploads');
  const st = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  return {
    db: st ? { size: st.size, mtimeMs: st.mtimeMs } : null,
    uploads: fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : null,
  };
}

function fileDigest(file) {
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  return { size: bytes.length, md5: createHash('md5').update(bytes).digest('hex') };
}

// --- 실행 자산 해석 ---
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
  if (!fs.existsSync(MIGRATOR_JAR)) usageDie(`--db mysql 에는 마이그레이터 jar 가 필요하다(${MIGRATOR_JAR} 없음). 먼저 빌드하라:\n  ${MIGRATOR_BUILD_HINT}`);
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

// 인스턴스별 임시 DATA_DIR(스키마·시드 = src/db/**). 리포 news.db 는 절대 열지 않는다.
function seedDataDir(root, label) {
  const dataDir = nodePath.join(root, label, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const seedFile = nodePath.join(dataDir, 'news.db');
  const db = new DatabaseSync(seedFile);
  createSchema(db);
  seedUsers(db);
  db.close();
  return { dataDir, seedFile };
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

// --- MySQL 축(--db mysql) — spool-parity 절차 그대로. 마이그레이터 jar 가 유일한 통로다 ---
function runMigrator(ctx, cwd, args, passUrl) {
  return new Promise((resolve) => {
    const child = spawn(ctx.javaBin, ['-jar', ctx.migratorJar, ...args], {
      cwd, env: migratorChildEnv(childEnv(), ctx.mysql, passUrl), stdio: ['ignore', 'pipe', 'pipe'],
    });
    // SIGINT 핸들러가 죽일 수 있게 등록한다 — 등록하지 않으면 ephemeral-create/migrate 진행 중 Ctrl+C 에 java 자식이 고아가 된다.
    // 끝난 자식은 빼지 않아도 killChild 가 무시한다(childDead).
    ctx.children.push(child);
    const buf = collectOutput(child);
    child.once('error', (err) => {
      child.spawnError = err; // childDead → 정리 루프가 죽은 자식을 5초 기다리지 않는다
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
  process.stderr.write(`${scrub(ctx, '[spring] migrator ephemeral-drop(SIGINT)', `${result.stdout ?? ''}${result.stderr ?? ''}`).slice(-2000)}\n`);
  return false;
}

function scrub(ctx, label, text) {
  const result = redactSecrets(text, ctx.secrets);
  if (result.hits > 0) ctx.secretLeaks.push(`${label} 출력에 비밀 값이 ${result.hits}회 섞여 나왔다 — 가려서 남겼지만 원인을 고쳐라.`);
  if (result.unredactable > 0) ctx.secretLeaks.push(`${label}: 가릴 수 없는 짧은 비밀이 ${result.unredactable}건 있다(docs/ops-mysql.md §3-1).`);
  return result.text;
}

/** 리포트·stdout 으로 나가는 표본 줄 정리: 아는 값 마스킹+형식 allowlist(sanitizePs1Sample) → MySQL 비밀(scrub) → 임시·리포 경로(scrubPaths). */
function sanitizeSample(ctx, label, text, secrets) {
  const safe = sanitizePs1Sample(text, secrets);
  return scrubPaths(scrub(ctx, `[${label}] ps1 표본`, safe), [[ctx.root, '<tmp>'], [REPO_ROOT, '<repo>']]);
}

async function migratorStep(ctx, cwd, args, passUrl, failures) {
  const result = await runMigrator(ctx, cwd, args, passUrl);
  const text = scrub(ctx, `[spring] migrator ${args[0]}`, `${result.out}${result.err}`);
  if (!result.ok) failures.push(`[spring] 마이그레이터 실패(${args[0]} exit=${result.code})\n--- migrator 출력 ---\n${text}`);
  return result.ok;
}

// --- HTTP — README 예시와 같은 형태: 쿠키 없음 · x-session-id 헤더 · Origin/Referer 없음(undici 는 붙이지 않는다 — 실측) ---
async function api(baseUrl, method, path, { sid, body, headers: extra } = {}) {
  const headers = { connection: 'close', ...(extra ?? {}) };
  if (sid) headers['x-session-id'] = sid;
  let payload;
  if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, json };
}

function userOf(role) {
  const user = SAMPLE_USERS.find((u) => u.role === role);
  if (!user) throw new Error(`SAMPLE_USERS 에 ${role} 역할 계정이 없다 — src/db/seed.js 확인`);
  return user;
}

async function loginRaw(baseUrl, role) {
  const user = userOf(role);
  return api(baseUrl, 'POST', '/api/login', { body: { userId: user.userId, password: user.password } });
}

async function login(baseUrl, role) {
  const res = await loginRaw(baseUrl, role);
  if (res.status !== 200 || res.json?.ok !== true || typeof res.json.sessionId !== 'string') {
    throw new Error(`login 거부 role=${role} status=${res.status} reason=${res.json?.reason ?? '-'}`);
  }
  return res.json.sessionId;
}

const tick = (baseUrl, sid, headers) => api(baseUrl, 'POST', '/api/distribution/tick', { sid, headers });
const inDistributed = (res, articleId) => Array.isArray(res?.json?.distributed) && res.json.distributed.some((d) => d && d.articleId === articleId);

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

// 엠바고 도래(1시간 전) 기사를 D 가 만들어 송고한다 → DES(즉시 배부 없음 · tick 의 대상).
async function createDueArticle(baseUrl, sidD, label) {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const body = { title: `tick-cutover ${label}`, markupVersion: JSON.stringify({ blocks: [{ text: `${label} 본문.` }, { text: END_MARKER }] }), embargoAt: hourAgo };
  const created = await api(baseUrl, 'POST', '/api/articles', { sid: sidD, body });
  expect(created.status === 200 && created.json?.ok === true && typeof created.json.articleId === 'string', `[${label}] 기사 생성 실패 status=${created.status} reason=${created.json?.reason ?? '-'}`);
  const articleId = created.json.articleId;
  const sent = await api(baseUrl, 'POST', `/api/articles/${articleId}/action`, { sid: sidD, body: { action: 'send' } });
  expect(sent.status === 200 && sent.json?.ok === true, `[${label}] 송고 실패 status=${sent.status} reason=${sent.json?.reason ?? '-'}`);
  expect(sent.json.status === 'DES', `[${label}] 송고 직후 status 기대 DES 실제 ${sent.json.status}`);
  return articleId;
}

async function createPressTarget(baseUrl, sidZ) {
  const res = await api(baseUrl, 'POST', '/api/distribution-targets', { sid: sidZ, body: { name: 'tick-cutover press', kind: 'press', spoolDir: PRESS_SLUG } });
  expect(res.status === 200 && res.json?.ok === true && Number.isInteger(res.json.id), `수신처 생성 실패 status=${res.status} reason=${res.json?.reason ?? '-'}`);
  return res.json.id;
}

// 스풀 파일 수 — **파일시스템에서 센다**(응답 신뢰 금지). 폴더가 아직 없으면 0.
function listPressSpool(spoolDir) {
  const dir = nodePath.join(spoolDir, PRESS_SLUG);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

// 조건 대기 뒤 **정착** 확인 — 값이 settleMs 동안 변하지 않을 때 돌려준다(동시 tick 의 늦은 쪽 파일까지 센다).
async function settledFileCount(spoolDir, articleId, { minimum = 1, timeoutMs = 10000, settleMs = 600 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = countSpoolFiles(listPressSpool(spoolDir), articleId);
  while (last < minimum && Date.now() < deadline) {
    await sleep(50);
    last = countSpoolFiles(listPressSpool(spoolDir), articleId);
  }
  let stableSince = Date.now();
  while (Date.now() - stableSince < settleMs) {
    await sleep(50);
    const now = countSpoolFiles(listPressSpool(spoolDir), articleId);
    if (now !== last) { last = now; stableSince = Date.now(); }
  }
  return last;
}

// --- ps1 실행 — 자격은 자식 env 로만(argv 0 · 출력 0) ---
function runPs1(baseUrl, creds, lockFile, { timeoutMs = 60000 } = {}) {
  const env = { ...childEnv() };
  if (creds) { env[PS1_ENV.user] = creds.userId; env[PS1_ENV.password] = creds.password; }
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-BaseUrl', baseUrl, '-LockFile', lockFile], {
    env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  });
  return { exit: result.status, out: String(result.stdout ?? ''), err: String(result.stderr ?? ''), error: result.error };
}

function spawnLockHolder(lockFile) {
  // 프로브가 직접 독점 열기를 할 수 없어(Node fs 는 공유 모드를 주지 않는다) PowerShell 이 대신 쥔다. 종료는 kill — OS 가 핸들을 푼다.
  // 잡았으면 stdout 에 HELD 를 스스로 알린다(별도 프로브 프로세스로 재지 않는다 — 1차 실행에서 그 방식이 20초 동안 판정을 못 냈다).
  const quoted = lockFile.replace(/'/g, "''");
  const cmd = `try { $f=[System.IO.File]::Open('${quoted}','OpenOrCreate','ReadWrite','None'); [Console]::Out.WriteLine('HELD'); [Console]::Out.Flush(); Start-Sleep -Seconds 120 } catch { [Console]::Error.WriteLine('NOT-HELD ' + $_.Exception.GetType().Name); exit 9 }`;
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', cmd], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.on('error', (err) => { child.spawnError = err; });
  child.buf = collectOutput(child);
  return child;
}

async function waitLockHeld(holder, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (holder.buf.out.includes('HELD')) return { held: true };
    if (childDead(holder)) return { held: false, why: `holder exit=${holder.exitCode} stderr=${holder.buf.err.trim().slice(0, 120)}` };
    await sleep(100);
  }
  return { held: false, why: `timeout ${timeoutMs}ms stdout=${holder.buf.out.trim().slice(0, 60)} stderr=${holder.buf.err.trim().slice(0, 120)}` };
}

function describePs1(result, stage) {
  const m = /stage=([a-z]+)/.exec(result.out);
  const st = /status=(\d+)/.exec(result.out);
  let s = `exit=${result.exit}`;
  if (stage !== 'none') s += ` stage=${m ? m[1] : 'none'}`;
  if (stage === 'status') s += ` status=${st ? st[1] : '-'}`;
  return s;
}

// --- A. 왕복 표 1대상 — README 예시 형태 그대로. 로그인 수: 대상 7 · 무스풀 대상 11 ---
async function roundtrip(side, nospool, ctx, log, obs) {
  // obs 는 호출자가 준 객체에 **채워 나간다** — 도중에 예외가 나도 그때까지의 행은 표에 남는다(전부 not-measured 로 지워지지 않는다).
  const base = side.baseUrl;
  const Z = userOf('Z');
  const R = userOf('R');

  const loginZ = await loginRaw(base, 'Z');                                                 // 로그인 #1
  obs['login-z'] = describeLogin(loginZ);
  expect(loginZ.status === 200 && typeof loginZ.json?.sessionId === 'string', `[${side.label}] Z 로그인 실패 status=${loginZ.status}`);
  const sidZ = loginZ.json.sessionId;
  const sidD = await login(base, 'D');                                                       // #2
  const sidR = await login(base, 'R');                                                       // #3
  side.sidZ = sidZ; side.sidD = sidD;
  side.targetId = await createPressTarget(base, sidZ);

  const a1 = await createDueArticle(base, sidD, `${side.label}-a1`);
  const t1 = await tick(base, sidZ);
  obs['tick-header'] = `${t1.status} ok=${t1.json?.ok}`;
  obs['tick-shape'] = describeTick(t1, a1);
  obs['tick-no-path'] = `leaks=${spoolPathLeaks(t1.json, [PRESS_SLUG]).length}`;
  const f1 = await settledFileCount(side.spoolDir, a1, { timeoutMs: ctx.timeout });
  const t2 = await tick(base, sidZ);
  const f2 = await settledFileCount(side.spoolDir, a1, { minimum: 0, timeoutMs: 1000 });
  obs['tick-idempotent-files'] = `tick1=${inDistributed(t1, a1) ? 'distributed' : 'not-distributed'} tick2=${inDistributed(t2, a1) ? 'distributed' : 'not-distributed'} files=${f1}/${f2}`;
  const evil = await tick(base, sidZ, { origin: 'http://evil.example' });
  obs['tick-no-origin'] = `none=${t2.status} evil=${evil.status}:${evil.json?.reason}`;
  const asR = await tick(base, sidR);
  const asD = await tick(base, sidD);
  obs['tick-non-z'] = `R=${asR.status}:${asR.json?.reason} D=${asD.status}:${asD.json?.reason}`;
  const anon = await tick(base, undefined);
  obs['tick-no-session'] = `${anon.status}:${anon.json?.reason}`;
  log(`왕복 6항 완료 (a1 파일 ${f1}/${f2})`);

  // 무스풀 인스턴스 — 503 · 11번째 로그인 429
  const zN = await login(nospool.baseUrl, 'Z');                                              // 무스풀 #1
  const sd = await tick(nospool.baseUrl, zN);
  obs['tick-spool-disabled'] = `${sd.status}:${sd.json?.reason}`;
  let first429 = null;
  for (let i = 2; i <= 12; i += 1) {                                                          // 무스풀 #2..#12
    const r = await loginRaw(nospool.baseUrl, 'Z');
    if (r.status === 429) { first429 = i; break; }
  }
  obs['login-11th'] = first429 === null ? '429@none(12)' : `429@${first429}`;
  log(`무스풀 대상: ${obs['tick-spool-disabled']} · 연속 로그인 ${obs['login-11th']}`);

  // ps1 7종 — 자격은 env 로만. 출력에 비밀·토큰·경로가 있으면 leaks>0.
  const lock = nodePath.join(ctx.root, `${side.label}.lock`);
  const secrets = [
    { label: 'password', value: Z.password }, { label: 'session-z', value: sidZ }, { label: 'session-d', value: sidD },
    { label: 'spool', value: side.spoolDir }, { label: 'spool-fwd', value: side.spoolDir.replace(/\\/g, '/') },
  ];
  const leaksOf = (r) => {
    const l = outputLeaks(`${r.out}\n${r.err}`, secrets);
    // ps1 은 자기 세션을 스스로 발급한다 — 그 토큰 값은 하네스가 모르므로 값 비교로는 잡히지 않는다(변이 실측). 형태로도 본다.
    l.push(...tokenShapeLeaks(r.out));
    if (/sessionId/i.test(r.out)) l.push('sessionId-word');
    if (/\.json\b/.test(r.out)) l.push('.json');
    if (/[\\/]/.test(r.out.replace(/^\S+\s/gm, ''))) l.push('separator'); // 시각(ISO)에는 구분자가 없다 — 첫 토큰 제외 뒤 검사
    return l;
  };
  const a2 = await createDueArticle(base, sidD, `${side.label}-a2`);
  const ok1 = runPs1(base, Z, lock);                                                          // #4
  const fa2 = await settledFileCount(side.spoolDir, a2, { timeoutMs: ctx.timeout });
  obs['ps1-ok'] = `${describePs1(ok1, 'none')} distributed=${/distributed=(\d+)/.exec(ok1.out)?.[1] ?? '-'} files=${fa2} leaks=${leaksOf(ok1).length}`;
  // 표본 줄은 tables.md·stdout 으로 **나간다** — 담기 전에 값을 가린다(다른 자식 출력 경로 2곳과 같은 규율).
  // leaksOf 는 「섞였다」를 실패로 만들 뿐, 이미 리포트에 박힌 토큰을 지워 주지 않는다(리뷰 후속 (1)).
  ctx.ps1Samples.push(`[${side.label}] ${sanitizeSample(ctx, side.label, ok1.out.trim().split('\n').pop(), secrets)}`);

  const holder = spawnLockHolder(lock);
  ctx.children.push(holder);
  const held = await waitLockHeld(holder, 20000);
  expect(held.held, `[${side.label}] 락 보유 프로세스가 락을 잡지 못했다: ${held.why}`);
  const locked = runPs1(base, Z, lock);
  obs['ps1-locked'] = describePs1(locked, 'none');
  await killChild(holder);

  const rerun = runPs1(base, Z, lock);                                                        // #5
  const fa2b = await settledFileCount(side.spoolDir, a2, { minimum: 0, timeoutMs: 1000 });
  obs['ps1-rerun'] = `${describePs1(rerun, 'none')} distributed=${/distributed=(\d+)/.exec(rerun.out)?.[1] ?? '-'} files=${fa2b} leaks=${leaksOf(rerun).length}`;

  const bad = runPs1(base, { userId: Z.userId, password: `${Z.password}-wrong` }, lock);     // #6
  obs['ps1-bad-password'] = `${describePs1(bad, 'stage')}`;
  const nonZ = runPs1(base, R, lock);                                                         // #7
  obs['ps1-non-z'] = describePs1(nonZ, 'status');
  const noEnv = runPs1(base, null, lock);
  obs['ps1-no-env'] = describePs1(noEnv, 'stage');
  const unreachable = runPs1(`http://${CONNECT_HOST}:${ctx.closedPort}`, Z, lock);
  obs['ps1-unreachable'] = describePs1(unreachable, 'stage');
  const allLeaks = [ok1, locked, rerun, bad, nonZ, noEnv, unreachable].flatMap(leaksOf);
  if (allLeaks.length > 0) ctx.failures.push(`[${side.label}] ps1 출력에 비밀·토큰·경로가 섞였다: ${[...new Set(allLeaks)].join(',')}`);
  log(`ps1 7종 완료 (a2 파일 ${fa2}/${fa2b})`);
}

// --- S6. Node 2번째(같은 DATA_DIR · 다른 포트) — ADR-012 잠금에 막혀 exit 1 이어야 한다 ---
async function nodeSecondBoot(nodeA, ctx) {
  const port = await pickFreePort(ctx.taken);
  const started = Date.now();
  const child = spawn(process.execPath, [NODE_SERVER], { cwd: nodePath.join(ctx.root, 'node-dup'), env: serverEnv(nodeA.dataDir, port, nodeA.spoolDir), stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', (err) => { child.spawnError = err; });
  ctx.children.push(child);
  const buf = collectOutput(child);
  const exited = await waitExit(child, 15000);
  const elapsedMs = Date.now() - started;
  if (!exited) await killChild(child);
  const firstStillHealthy = await isHealthy(nodeA.baseUrl);
  ctx.bootLogs['node-dup'] = scrubPaths(`${buf.out}\n--- stderr ---\n${buf.err}`, [[ctx.root, '<tmp>'], [REPO_ROOT, '<repo>']]);
  return { exitCode: exited ? child.exitCode : null, elapsedMs, hint: buf.err.includes('DATA_DIR'), firstStillHealthy, port };
}

// --- A-2. Spring 2개(같은 MySQL · 같은 스풀 · 같은 DATA_DIR) — 교차 세션 · 순차 · 동시 ---
async function multiInstance(springA, springB, ctx, log, obs) {
  obs.springSecondBoot = springB.healthy ? 'health-ok' : `failed:exit=${springB.child?.exitCode ?? '-'}`;
  if (!springB.healthy) return;
  // **세션은 프로세스 로컬이다** — 두 인스턴스는 서로 다른 in-process 스토어를 갖고, 발급은 같은 userId 의 이전 세션을
  // 전부 무효화한다(SessionStore 단일 세션 정책). 그래서 왕복·ps1 이 남긴 낡은 토큰을 재사용하지 않고 **여기서 새로 발급**한다:
  // A 의 토큰은 A 에서만 유효하고 B 에서는 401 이어야 한다(그 사실이 로드밸런서를 앞에 둘 수 없다는 근거다).
  const sidZA = await login(springA.baseUrl, 'Z');
  const sidDA = await login(springA.baseUrl, 'D');
  const sidZB = await login(springB.baseUrl, 'Z');                                           // B #1
  const cross = await tick(springB.baseUrl, sidZA);                                          // A 의 (A 에서 유효한) 토큰을 B 에 → 401 이어야 한다
  const own = await tick(springB.baseUrl, sidZB);
  obs.crossSession = { aTokenOnB: `${cross.status}:${cross.json?.reason}`, bOwnToken: String(own.status) };
  log(`교차 세션 ${obs.crossSession.aTokenOnB} · B 자기 세션 ${obs.crossSession.bOwnToken}`);

  const seq = await createDueArticle(springA.baseUrl, sidDA, 'seq');
  const tA = await tick(springA.baseUrl, sidZA);
  const filesAfterA = await settledFileCount(springA.spoolDir, seq, { timeoutMs: ctx.timeout });
  const tB = await tick(springB.baseUrl, sidZB);
  const filesAfterB = await settledFileCount(springA.spoolDir, seq, { minimum: 0, timeoutMs: 1000 });
  obs.sequential = { tickA: inDistributed(tA, seq) ? 'distributed' : 'not-distributed', tickB: inDistributed(tB, seq) ? 'distributed' : 'not-distributed', filesAfterA, filesAfterB };
  log(`순차 tick A→B: ${obs.sequential.tickA}/${obs.sequential.tickB} 파일 ${filesAfterA}→${filesAfterB}`);

  obs.concurrent = [];
  for (let round = 1; round <= ctx.rounds; round += 1) {
    const id = await createDueArticle(springA.baseUrl, sidDA, `con${round}`);
    const [rA, rB] = await Promise.all([tick(springA.baseUrl, sidZA), tick(springB.baseUrl, sidZB)]);
    const files = await settledFileCount(springA.spoolDir, id, { timeoutMs: ctx.timeout, settleMs: 1000 });
    const entry = { round, files, inA: inDistributed(rA, id), inB: inDistributed(rB, id), statusA: rA.status, statusB: rB.status };
    obs.concurrent.push(entry);
    log(`동시 tick ${round}/${ctx.rounds}: 파일 ${files} (A ${entry.inA ? 'distributed' : '-'} · B ${entry.inB ? 'distributed' : '-'})`);
  }
  obs.spoolDuplicates = duplicateArticles(listPressSpool(springA.spoolDir));
  obs.spoolTotal = listPressSpool(springA.spoolDir).length;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  process.stdout.write(`tick-cutover-probe 시작 db=${opts.db} rounds=${opts.rounds}\n`);
  if (process.platform !== 'win32') usageDie('이 프로브는 Windows PowerShell 5.1 로 ps1 을 실행한다 — win32 에서만 돈다.');
  if (!fs.existsSync(POWERSHELL)) usageDie(`Windows PowerShell 을 찾지 못했다: ${POWERSHELL}`);
  runSelfTest(SELF_TEST, 'scripts/lib/tickCutover.self-test.mjs');

  const jar = resolveJar(opts.jar);
  const javaBin = resolveJavaBin(opts.javaHome);
  let mysql = null;
  let migratorJar = null;
  if (opts.db === 'mysql') {
    runSelfTest(MYSQL_SELF_TEST, 'scripts/lib/mysqlHarness.test.mjs');
    try { mysql = readMysqlCredentials(process.env); } catch (err) { usageDie(err.message); }
    migratorJar = resolveMigratorJar();
    for (const warning of mysql.warnings) process.stderr.write(`${warning}\n`);
  }

  const givenOutDir = opts.outDir ? assertOutsideRepo(opts.outDir, '--out-dir') : null;
  // realpath — 8.3 짧은 경로(JUNGJA~1)를 자식에 주지 않는다(step6 함정 · 여기서는 fs.watch 가 없지만 규율을 따른다).
  const root = assertOutsideRepo(fs.realpathSync.native(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tick-cutover-'))), '임시 루트');
  const outDir = givenOutDir ?? nodePath.join(root, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(nodePath.join(root, 'node-dup'), { recursive: true });
  const ownsOutDir = !opts.outDir;
  process.stdout.write(`  jar=${nodePath.relative(REPO_ROOT, jar).replace(/\\/g, '/')} ps1=${nodePath.relative(REPO_ROOT, PS1).replace(/\\/g, '/')}\n  tmp=${root}\n`);

  const ctx = {
    javaBin, migratorJar, mysql, secrets: mysql ? [mysql.password] : [], secretLeaks: [], failures: [], children: [], taken: new Set(),
    root, timeout: opts.timeout, rounds: opts.rounds, bootLogs: {}, ps1Samples: [],
  };
  const repoBefore = repoDataSnapshot();
  const failures = ctx.failures;
  // 인스턴스 — spring-b 는 mysql 축에서만(같은 DB 를 공유해야 A-2 가 성립한다).
  const instances = [
    { label: 'node-a', kind: 'node', spool: true },
    { label: 'node-nospool', kind: 'node', spool: false },
    { label: 'spring-a', kind: 'spring', spool: true, mysql: Boolean(mysql) },
    { label: 'spring-nospool', kind: 'spring', spool: false },
  ];
  if (mysql) instances.push({ label: 'spring-b', kind: 'spring', spool: true, mysql: true, shareWith: 'spring-a' });
  const byLabel = Object.fromEntries(instances.map((i) => [i.label, i]));
  let ephemeralDb = null;
  let seedDigest = null;
  let roundtripResult = null;
  let multiResult = null;
  let nodeDup = null;
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
    // 1. 시드·스풀·포트·[mysql 적재]·기동 — 전부 나란히(기동 대기는 뒤에서 한꺼번에).
    ctx.closedPort = await pickFreePort(ctx.taken); // ps1 미도달 행의 대상(아무도 listen 하지 않는다)
    for (const inst of instances) {
      if (inst.shareWith) {
        const src = byLabel[inst.shareWith];
        Object.assign(inst, { dataDir: src.dataDir, seedFile: src.seedFile, spoolDir: src.spoolDir });
      } else {
        Object.assign(inst, seedDataDir(root, inst.label));
        inst.spoolDir = inst.spool ? nodePath.join(root, inst.label, 'spool') : null;
        if (inst.spoolDir) fs.mkdirSync(inst.spoolDir);
      }
      inst.port = await pickFreePort(ctx.taken);
      inst.baseUrl = `http://${CONNECT_HOST}:${inst.port}`;
      const env = serverEnv(inst.dataDir, inst.port, inst.spoolDir);
      if (inst.kind === 'spring' && inst.mysql) {
        if (!inst.shareWith) {
          ephemeralDb = requireEphemeralDbName(ephemeralDbName());
          const passUrl = urlForDatabase(mysql.url, ephemeralDb);
          const loadStart = Date.now();
          if (!await migratorStep(ctx, root, ['ephemeral-create', '--name', ephemeralDb], null, failures)) throw new Error('ephemeral-create 실패');
          if (!await migratorStep(ctx, root, ['migrate', '--source', inst.seedFile, '--target', PASS_KEY_SET], passUrl, failures)) throw new Error('migrate 실패');
          seedDigest = fileDigest(inst.seedFile);
          inst.mysqlEnv = springMysqlEnv(mysql, passUrl);
          process.stdout.write(`  [${inst.label}] mysql 적재 db=${ephemeralDb} ${Date.now() - loadStart}ms seedDb=${seedDigest.md5}\n`);
        } else {
          inst.mysqlEnv = byLabel[inst.shareWith].mysqlEnv;
        }
        Object.assign(env, inst.mysqlEnv);
      }
      const bin = inst.kind === 'node' ? process.execPath : javaBin;
      const argv = inst.kind === 'node' ? [NODE_SERVER] : ['-jar', jar];
      inst.child = spawn(bin, argv, { cwd: nodePath.join(root, inst.shareWith ?? inst.label), env, stdio: ['ignore', 'pipe', 'pipe'] });
      inst.child.on('error', (err) => { inst.child.spawnError = err; failures.push(`[${inst.label}] 자식 프로세스 오류(spawn/kill): ${err && err.code ? err.code : err}`); });
      ctx.children.push(inst.child);
      inst.buf = collectOutput(inst.child);
      process.stdout.write(`  [${inst.label}] 기동 pid=${inst.child.pid ?? '-'} port=${inst.port} db=${inst.mysql ? ephemeralDb : 'sqlite'} spool=${inst.spoolDir ? `<tmp>/${inst.shareWith ?? inst.label}/spool` : '(미설정)'}\n`);
    }
    // 2. health
    for (const inst of instances) {
      const bootStart = Date.now();
      inst.healthy = await waitHealthy(inst.baseUrl, opts.timeout, inst.child);
      if (!inst.healthy) {
        failures.push(`[${inst.label}] 기동/health 실패(${Date.now() - bootStart}ms exit=${inst.child.exitCode} signal=${inst.child.signalCode}) — 기동 로그 참조`);
        if (`${inst.buf.out}${inst.buf.err}`.includes('Unresolved compilation problem')) failures.push(`[${inst.label}] jar 에 IDE 가 컴파일한 클래스가 섞여 있다 — ${BUILD_HINT} 로 다시 굽고 재실행하라.`);
        continue;
      }
      process.stdout.write(`  [${inst.label}] health ok ${Date.now() - bootStart}ms\n`);
    }
    const mainUp = ['node-a', 'node-nospool', 'spring-a', 'spring-nospool'].every((l) => byLabel[l].healthy);
    // 3. S6 — Node 2번째(같은 DATA_DIR) 기동 시도. 왕복 전에 잰다(첫 인스턴스가 살아 있음을 뒤에서 다시 확인한다).
    if (mainUp) {
      nodeDup = await nodeSecondBoot(byLabel['node-a'], ctx);
      process.stdout.write(`  [node-dup] 같은 DATA_DIR 2번째 기동: exit=${nodeDup.exitCode} ${nodeDup.elapsedMs}ms 안내=${nodeDup.hint} 첫 인스턴스 health=${nodeDup.firstStillHealthy}\n`);
    }
    // 4. 왕복 표 — Node → Spring 순차
    const observed = {};
    if (mainUp) {
      for (const [label, nospool] of [['node-a', 'node-nospool'], ['spring-a', 'spring-nospool']]) {
        const started = Date.now();
        const obs = {};
        observed[label.split('-')[0]] = obs;
        try {
          await roundtrip(byLabel[label], byLabel[nospool], ctx, (line) => process.stdout.write(`  [${label}] ${line}\n`), obs);
          process.stdout.write(`  [${label}] 왕복 완료 ${Date.now() - started}ms\n`);
        } catch (err) {
          failures.push(`[${label}] 왕복 실패: ${err.message}`);
        }
      }
      roundtripResult = judgeRoundtrip(observed);
      failures.push(...roundtripResult.failures);
    }
    // 5. A-2 — mysql 축에서만 Spring 쌍이 성립한다.
    if (mainUp && mysql) {
      const obs = { nodeSecondBoot: nodeDup };
      try {
        await multiInstance(byLabel['spring-a'], byLabel['spring-b'], ctx, (line) => process.stdout.write(`  [a-2] ${line}\n`), obs);
      } catch (err) {
        failures.push(`[a-2] 다중 인스턴스 실측 실패: ${err.message}`);
      }
      multiResult = judgeMultiInstance(obs);
      failures.push(...multiResult.failures);
    } else if (mainUp && nodeDup && !(nodeDup.exitCode === 1 && nodeDup.hint && nodeDup.firstStillHealthy)) {
      failures.push(`[node-dup] 같은 DATA_DIR 2번째 Node 가 ADR-012 잠금에 막히지 않았다: exit=${nodeDup.exitCode} hint=${nodeDup.hint} first=${nodeDup.firstStillHealthy}`);
    }
  } catch (err) {
    failures.push(`실행 예외: ${err && err.stack ? err.stack : err}`);
  } finally {
    // 5-a 자식 종료 → 5-b md5 단언·드롭 → 5-c 기동 로그. 항목마다 격리.
    for (const child of ctx.children) {
      try {
        const killed = await killChild(child);
        if (!killed) failures.push(`자식 프로세스 종료 실패(SIGKILL 후에도 잔존) pid=${child.pid}`);
      } catch (err) {
        failures.push(`자식 프로세스 종료 중 예외: ${err && err.message ? err.message : err}`);
      }
    }
    if (seedDigest) {
      try {
        const after = fileDigest(byLabel['spring-a'].seedFile);
        if (!after || after.md5 !== seedDigest.md5) failures.push(`--db mysql 인데 Spring 임시 DATA_DIR 의 news.db 가 변했다 — 서버가 MySQL 이 아니라 SQLite 를 열었다. before=${JSON.stringify(seedDigest)} after=${JSON.stringify(after)}`);
      } catch (err) {
        failures.push(`--db mysql 임시 news.db md5 재측정 실패: ${err && err.code ? err.code : err}`);
      }
    }
    if (ephemeralDb) {
      const dropped = await migratorStep(ctx, root, ['ephemeral-drop', '--name', ephemeralDb], null, failures);
      if (dropped) { process.stdout.write(`  [spring] mysql 임시 DB 드롭 ${ephemeralDb}\n`); ephemeralDb = null; }
      else process.stderr.write(`warn 임시 MySQL DB 정리 실패(직접 지워라): ${ephemeralDb}\n`);
    }
    for (const inst of instances) {
      if (!inst.child) continue;
      try {
        ctx.bootLogs[inst.label] = scrubPaths(scrub(ctx, `[${inst.label}]`, `${inst.buf.out}\n--- stderr ---\n${inst.buf.err}`), [[root, '<tmp>'], [REPO_ROOT, '<repo>']]);
      } catch (err) {
        failures.push(`[${inst.label}] 기동 로그 정리 실패: ${err && err.code ? err.code : err}`);
      }
    }
    try {
      for (const [label, text] of Object.entries(ctx.bootLogs)) fs.writeFileSync(nodePath.join(outDir, `${label}-boot.log`), text);
    } catch (err) {
      failures.push(`기동 로그 기록 실패: ${err && err.code ? err.code : err}`);
    }
  }

  // 6. 표 출력 + 리포트(경로·비밀 없음)
  const rate = rateLimitTable();
  const lines = [];
  lines.push('## A. 왕복 표 (README-배포 §6 형태 · Node vs Spring)', '', ...(roundtripResult ? formatSideBySide(roundtripResult.rows) : ['(왕복 미실행 — 기동 실패)']), '');
  if (ctx.ps1Samples.length > 0) lines.push('ps1 출력 표본(마지막 줄):', ...ctx.ps1Samples.map((s) => `  ${s}`), '');
  lines.push('## A-2. 다중 인스턴스 (S6 Node 2개 · Spring 2개)', '');
  if (multiResult) lines.push(...formatMultiInstance(multiResult), '', `스풀 폴더 ${PRESS_SLUG} 총 파일 ${multiResult.obs.spoolTotal} · 기사별 2개 이상 ${JSON.stringify(multiResult.obs.spoolDuplicates)}`);
  else if (nodeDup) lines.push(`| Node 2번째 기동(같은 DATA_DIR) | exit=${nodeDup.exitCode} ${nodeDup.elapsedMs}ms 안내=${nodeDup.hint} 첫 인스턴스 health=${nodeDup.firstStillHealthy} |`, '', '**Spring 쌍은 재지 않았다** — `--db mysql` 로 실행해야 같은 DB 를 공유하는 두 인스턴스가 성립한다.');
  lines.push('', `## 레이트리밋 산술 (로그인 ${'10회/15분'} 고정 창 · 임계 주기 ${criticalPeriodSec()}초)`, '', ...formatRateLimitTable(rate));
  process.stdout.write(`${lines.join('\n')}\n`);
  try {
    fs.writeFileSync(nodePath.join(outDir, 'tables.md'), `${lines.join('\n')}\n`);
    fs.writeFileSync(nodePath.join(outDir, 'report.json'), `${JSON.stringify({ db: opts.db, roundtrip: roundtripResult, multi: multiResult, nodeDup, rateLimit: rate, failures }, null, 2)}\n`);
  } catch (err) {
    failures.push(`리포트 기록 실패: ${err && err.code ? err.code : err}`);
  }

  // 7. 데이터 안전 · 잔존 · 비밀 위생
  const repoAfter = repoDataSnapshot();
  if (JSON.stringify(repoBefore) !== JSON.stringify(repoAfter)) failures.push(`리포 news.db/uploads 변동: before=${JSON.stringify(repoBefore)} after=${JSON.stringify(repoAfter)}`);
  for (const child of ctx.children) if (!childDead(child)) failures.push(`자식 프로세스가 아직 살아 있다 pid=${child.pid}`);
  failures.push(...ctx.secretLeaks);

  const ok = failures.length === 0;
  if (ok && !opts.keep) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      process.stdout.write(`  정리: 자식 ${ctx.children.length} 종료 확인 · 임시 디렉토리 삭제${ownsOutDir ? '(리포트 포함 — 보존하려면 --out-dir 또는 --keep)' : ''}\n`);
    } catch (err) {
      process.stderr.write(`warn 임시 디렉토리 정리 실패(무해 — Windows 파일 잠금): ${root} (${err && err.code})\n`);
    }
  } else {
    process.stdout.write(`keep 임시 디렉토리 보존(${ok ? '--keep' : '실패 진단용'} — 확인 후 삭제하라): ${root}\n`);
    if (!ok) for (const [label, log] of Object.entries(ctx.bootLogs)) process.stdout.write(`--- ${label} 기동 로그(끝 15줄) ---\n${log.split('\n').slice(-15).join('\n')}\n`);
  }
  if (!ok) process.stderr.write(`${failures.map((f) => `FAIL ${f}`).join('\n')}\n`);
  const rt = roundtripResult ? `왕복 ${roundtripResult.rows.length}행 diffs ${roundtripResult.rows.filter((r) => !r.same).length}` : '왕복 비교 불가';
  const mi = multiResult ? `A-2 동시 ${multiResult.rounds}회 중복 ${multiResult.duplicateRounds} 최대파일 ${multiResult.maxFiles}` : 'A-2 Spring 쌍 미측정(sqlite)';
  process.stdout.write(`tick-cutover-probe A=node B=spring ${rt} · ${mi} · Node2 exit=${nodeDup?.exitCode ?? '-'} db=${opts.db} → ${ok ? 'ok' : 'FAILED'}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`tick-cutover-probe 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
