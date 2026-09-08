// 배부 스풀 산출물 바이트 대조 하네스 (phase 76 step5 — 로드맵 P3 완료 게이트 ②). Node 서버와 Spring 서버를
// 각각의 임시 DATA_DIR·DIST_SPOOL_DIR 로 나란히 띄우고 **같은 시나리오 5축**(가·나·다·라·마 — scripts/lib/spoolParity.mjs
// buildScenarioPlan)을 기사 1건씩 순차로 재생한 뒤, 두 스풀 루트의 파일을 (수신처 폴더 집합 · 폴더별 파일 수 ·
// 정규화 후 전 바이트)로 대조한다. 계약 하네스는 응답에 스풀 경로가 **없음**을 단언하고(assertNoSpoolPath) --parity 는
// HTTP 만 보므로 이 파일들의 바이트를 보는 자리는 여기뿐이다.
// 사용: node scripts/spool-parity.mjs [--db <sqlite|mysql>] [--jar <path>] [--java-home <path>] [--out-dir <dir>]
//                                     [--keep] [--timeout <ms>]
//
// 절차(spring-contract.mjs·spa-parity.mjs 의 규율을 베꼈고 그 파일들은 고치지 않는다):
//   자기검사(node --test scripts/lib/spoolParity.self-test.mjs) → 리포 밖 임시 루트 → 서버별 임시 DATA_DIR 시드(src/db/**)
//   + 서버별 DIST_SPOOL_DIR → [mysql: ephemeral-create → migrate → Spring DB_KIND=mysql] → 빈 포트 2개 → Node·Spring 기동
//   (env = OS 허용목록 + DATA_DIR·PORT·HOST·DIST_SPOOL_DIR 4키 · SPA_DIR 미주입) → /api/health → 시나리오 재생(D·Z 세션)
//   → 스풀 수집 → 순수 판정부 비교 → 자식 종료 → [mysql: ephemeral-drop] → 임시 디렉토리 삭제.
//
// CRITICAL(DB 비파괴): 리포 news.db·uploads/ 에 쓰지 않는다(실행 전후 스냅샷 무변 단언). DIST_SPOOL_DIR 은 **리포 밖 임시**만 —
//   운영 스풀을 주면 외부 전송기가 테스트 기사를 진짜로 발송한다.
// CRITICAL(두 서버는 서로 다른 DATA_DIR·서로 다른 DIST_SPOOL_DIR): 같은 스풀을 쓰면 짝짓기가 붕괴한다(Q8 — 조립 단계에서 거부).
// CRITICAL(비결정 요소 — decisions (8)): 시각·articleId 는 자리표시자 + 정합 3겹으로 다룬다(판정부 PLACEHOLDER_KEYS 가 단일 출처).
// 로그 규율: 세션 토큰·비밀번호·MySQL 자격을 stdout/stderr/파일 어디에도 쓰지 않는다. 자식 출력은 redactSecrets 로 훑는다.
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
import {
  PLACEHOLDER_KEYS, buildScenarioPlan, compareSpools, expectedFolderCounts, formatCounts, formatDiffLines,
  formatSummary, lookupStep, parseSpoolFileName, pathIsInside, stepsByArticle,
} from './lib/spoolParity.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const NODE_SERVER = nodePath.join(REPO_ROOT, 'server', 'index.js');
const SPRING_TARGET_DIR = nodePath.join(REPO_ROOT, 'server-spring', 'target');
const MIGRATOR_JAR = nodePath.join(REPO_ROOT, 'tools', 'news-migrator', 'target', 'news-migrator.jar');
const SELF_TEST = nodePath.join(nodePath.dirname(SCRIPT_PATH), 'lib', 'spoolParity.self-test.mjs');
const MYSQL_SELF_TEST = nodePath.join(nodePath.dirname(SCRIPT_PATH), 'lib', 'mysqlHarness.test.mjs');
const CONNECT_HOST = '127.0.0.1';
// 포트 [15000,20000) — spring-contract·spa-parity 와 같은 구간(동시 실행 금지 규율이 있으므로 겹침은 문제가 아니다).
const PORT_BASE = 15000;
const PORT_SPAN = 5000;
const JDK_HINT = 'D:/agents/tools/jdk-25.0.4.1+1';
const BUILD_HINT = `cd server-spring && JAVA_HOME="${JDK_HINT}" ./mvnw -B -q package -DskipTests`;
const MIGRATOR_BUILD_HINT = `cd tools/news-migrator && JAVA_HOME="${JDK_HINT}" ./mvnw -B -q package -DskipTests`;
const DB_KINDS = ['sqlite', 'mysql'];

const USAGE = `사용법: node scripts/spool-parity.mjs [--db <sqlite|mysql>] [--jar <path>] [--java-home <path>] [--out-dir <dir>] [--keep] [--timeout <ms>]
  --db <kind>        Spring 대상 서버의 저장소(기본 sqlite). mysql 이면 임시 DB(harness_ct_<16hex>)에 시드를 마이그레이터로
                     적재하고 Spring 을 DB_KIND=mysql 로 붙인다(${CT_KEY_SET}_URL/_USERNAME/_PASSWORD 필요 · 없으면 즉시 실패).
                     Node 는 언제나 SQLite 다 = mysql green 은 Node(SQLite) vs Spring(MySQL) 의 스풀 바이트 비교다.
  --jar <path>       Spring 실행 jar. 미지정=server-spring/target/*.jar 자동 탐색(자동 빌드는 하지 않는다).
  --java-home <path> JDK 홈. 미지정=SPRING_JAVA_HOME → JAVA_HOME 순(시스템 java 폴백 금지).
  --out-dir <dir>    리포트 디렉토리. 미지정=OS 임시 디렉토리. **리포 안에는 쓰지 않는다.**
  --keep             임시 디렉토리(스풀 파일 포함)를 지우지 않는다(실패 시에는 항상 보존).
  --timeout <ms>     기동·조건 대기 한도(기본 60000, 1000 이상 정수).`;

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
  const opts = { keep: false, timeout: 60000, db: 'sqlite' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--jar') { opts.jar = take(i, '--jar'); i += 1; }
    else if (a === '--java-home') { opts.javaHome = take(i, '--java-home'); i += 1; }
    else if (a === '--out-dir') { opts.outDir = take(i, '--out-dir'); i += 1; }
    else if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') { opts.timeout = Number(take(i, '--timeout')); i += 1; }
    else if (a === '--db') { opts.db = take(i, '--db'); i += 1; }
    else usageDie(`알 수 없는 인자: ${a}`);
  }
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) usageDie(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${opts.timeout}`);
  // 오타가 조용히 sqlite 로 흘러가면 "mysql 로 쟀다"는 거짓 기록이 남는다 — 형태 단계에서 죽인다.
  if (!DB_KINDS.includes(opts.db)) usageDie(`--db 값이 유효하지 않다(${DB_KINDS.join('|')}): ${opts.db}`);
  return opts;
}

// --- 자기검사 — 판정부가 빨간 채로는 서버를 띄우지 않는다 ---
function runSelfTest(file, label) {
  if (!fs.existsSync(file)) usageDie(`판정부 자기검사 파일이 없다: ${file} — 조용히 건너뛰지 않는다.`);
  const result = spawnSync(process.execPath, ['--test', file], { cwd: REPO_ROOT, env: childEnv(), encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(String(result.stdout ?? '') + String(result.stderr ?? ''));
    usageDie(`판정부 자기검사가 실패했다(node --test ${label}) — 자리표시자 집합·정합 단언이 깨진 채로는 대조하지 않는다.`);
  }
  process.stdout.write(`  판정부 자기검사 통과 (node --test ${label})\n`);
}

// --- 환경 조립 (spring-contract javaChildEnv · spa-parity childEnv 동형 — 부모 env 통째 상속 금지) ---
const OS_ENV_ALLOWLIST = process.platform === 'win32'
  ? ['SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']
  : ['PATH', 'HOME', 'LANG', 'TZ'];

function childEnv() {
  const env = {};
  for (const key of OS_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

// 두 서버에 **같은 이름** 4키를 준다(SPA_DIR 미주입 — 이 대조에 화면은 없다). .env 는 어느 쪽도 읽지 않는다.
function serverEnv(dataDir, port, spoolDir) {
  return { ...childEnv(), DATA_DIR: dataDir, PORT: String(port), HOST: CONNECT_HOST, DIST_SPOOL_DIR: spoolDir };
}

// --- 자식 프로세스 유틸 ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// spawn 자체가 실패하면(ENOENT·EACCES) 'error' 이벤트만 오고 exitCode 가 null 로 남을 수 있다 — 리스너가 spawnError 를 남겨 죽은 것으로 본다.
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

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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

// win32 파일시스템은 대소문자를 구분하지 않는다 — `d:\...` 소문자 드라이브가 문자열 startsWith 를 통과해 리포 안에 리포트·기동 로그를
// 쓰는 우회를 막는다(판정은 순수 pathIsInside · 자기검사가 그 케이스를 잠근다).
function assertOutsideRepo(dir, label) {
  const abs = nodePath.resolve(dir);
  if (pathIsInside(abs, REPO_ROOT, process.platform)) usageDie(`${label}는 리포 안에 둘 수 없다: ${abs}`);
  return abs;
}

// 서버별 임시 DATA_DIR(스키마·시드 = src/db/**) + 서버별 스풀 루트. 리포 news.db 는 절대 열지 않는다.
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

// 진단 로그의 경로 가리기 — 임시 루트·리포 루트 절대경로를 그대로 남기지 않는다.
function scrubPaths(text, replacements) {
  let out = String(text ?? '');
  for (const [needle, mask] of replacements) {
    for (const variant of new Set([needle, needle.replace(/\\/g, '/'), needle.replace(/\//g, '\\')])) {
      if (variant) out = out.split(variant).join(mask);
    }
  }
  return out;
}

// --- MySQL 축(--db mysql) — spring-contract.mjs runSpringPass 1-b 절차 그대로. 마이그레이터 jar 가 유일한 통로다 ---
function runMigrator(ctx, cwd, args, passUrl) {
  return new Promise((resolve) => {
    const child = spawn(ctx.javaBin, ['-jar', ctx.migratorJar, ...args], {
      cwd, env: migratorChildEnv(childEnv(), ctx.mysql, passUrl), stdio: ['ignore', 'pipe', 'pipe'],
    });
    const buf = collectOutput(child);
    // spawn 실패('error')는 리스너가 없으면 uncaught 로 프로세스를 죽여 finally 가 돌지 않는다 — 실패 결과로 합류시킨다.
    child.once('error', (err) => resolve({ ok: false, code: null, out: buf.out, err: `${buf.err}\nspawn error: ${err && err.code ? err.code : err}` }));
    child.once('close', (code) => resolve({ ok: code === 0, code, out: buf.out, err: buf.err }));
  });
}

// SIGINT 경로 전용 — **동기** 드롭(process.exit 전에 끝나야 한다). 출력은 실패 시에만 비밀을 가려 stderr 로, 성패만 돌려준다.
function dropEphemeralSync(ctx, cwd, name) {
  const result = spawnSync(ctx.javaBin, ['-jar', ctx.migratorJar, 'ephemeral-drop', '--name', name], {
    cwd, env: migratorChildEnv(childEnv(), ctx.mysql, null), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000,
  });
  if (result.status === 0) return true;
  process.stderr.write(`${scrub(ctx, '[spring] migrator ephemeral-drop(SIGINT)', `${result.stdout ?? ''}${result.stderr ?? ''}`).slice(-2000)}\n`);
  return false;
}

// 자식이 뱉은 글은 우리 통제 밖이다 — 가리고, 섞였다는 사실은 실패로 남긴다(값은 싣지 않는다).
function scrub(ctx, label, text) {
  const result = redactSecrets(text, ctx.secrets);
  if (result.hits > 0) ctx.secretLeaks.push(`${label} 출력에 비밀 값이 ${result.hits}회 섞여 나왔다 — 가려서 남겼지만 원인을 고쳐라.`);
  if (result.unredactable > 0) ctx.secretLeaks.push(`${label}: 가릴 수 없는 짧은 비밀이 ${result.unredactable}건 있다(docs/ops-mysql.md §3-1).`);
  return result.text;
}

async function migratorStep(ctx, cwd, args, passUrl, failures) {
  const result = await runMigrator(ctx, cwd, args, passUrl);
  const text = scrub(ctx, `[spring] migrator ${args[0]}`, `${result.out}${result.err}`);
  if (!result.ok) failures.push(`[spring] 마이그레이터 실패(${args[0]} exit=${result.code})\n--- migrator 출력 ---\n${text}`);
  return result.ok;
}

// --- HTTP(시나리오 재생) — 세션 토큰은 메모리에만 있고 어떤 메시지에도 담지 않는다 ---
async function api(baseUrl, method, path, { sid, body } = {}) {
  const headers = {};
  if (sid) headers['x-session-id'] = sid;
  let payload;
  if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, json };
}

async function login(baseUrl, role) {
  const user = SAMPLE_USERS.find((u) => u.role === role);
  if (!user) throw new Error(`SAMPLE_USERS 에 ${role} 역할 계정이 없다 — src/db/seed.js 확인`);
  const res = await api(baseUrl, 'POST', '/api/login', { body: { userId: user.userId, password: user.password } });
  if (res.status !== 200 || res.json?.ok !== true || typeof res.json.sessionId !== 'string') {
    throw new Error(`login 거부 role=${role} status=${res.status} reason=${res.json?.reason ?? '-'}`);
  }
  return res.json.sessionId;
}

// 조건 대기(고정 sleep 금지) — 비동기 배부(Node 송고 훅은 응답 뒤에 스풀을 쓴다)를 폴링으로 흡수한다.
async function poll(fn, predicate, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await sleep(50);
  }
  throw new Error(`조건 대기 시간 초과(${what}) 한도=${timeoutMs}ms 마지막=${JSON.stringify(last).slice(0, 300)}`);
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

// 시나리오 1회 재생 — 기사 1건씩 순차. 반환 { articles: {순번: articleId}, failureViews: {순번: 실패 원장 투영} }.
async function replay(target, plan, opts, log) {
  const { baseUrl, spoolDir } = target;
  const sidD = await login(baseUrl, 'D');
  const sidZ = await login(baseUrl, 'Z');
  const targetIds = {};
  for (const t of plan.targets) {
    const res = await api(baseUrl, 'POST', '/api/distribution-targets', { sid: sidZ, body: t });
    expect(res.status === 200 && res.json?.ok === true && Number.isInteger(res.json.id), `수신처 생성 실패(${t.spoolDir}) status=${res.status} reason=${res.json?.reason ?? '-'}`);
    targetIds[t.spoolDir] = res.json.id;
  }
  log(`수신처 ${plan.targets.map((t) => `${t.kind}:${t.spoolDir}`).join(' · ')}`);

  const articles = {};
  const failureViews = {};
  const getContents = async (id) => {
    const res = await api(baseUrl, 'GET', `/api/articles/${id}`, { sid: sidZ });
    return res.status === 200 ? res.json.contents : null;
  };

  for (const step of plan.steps) {
    let blockPath = null;
    if (step.retry) {
      // 수신처 폴더 자리에 **일반 파일**을 놓아 mkdir 을 막는다 — 양쪽 다 spool-write-failed 가 결정적으로 난다.
      blockPath = nodePath.join(spoolDir, plan.retryTarget.spoolDir);
      fs.writeFileSync(blockPath, 'not-a-directory');
      const res = await api(baseUrl, 'POST', '/api/distribution-targets', { sid: sidZ, body: plan.retryTarget });
      expect(res.status === 200 && res.json?.ok === true, `재전송 수신처 생성 실패 status=${res.status} reason=${res.json?.reason ?? '-'}`);
      targetIds[plan.retryTarget.spoolDir] = res.json.id;
    }

    const created = await api(baseUrl, 'POST', '/api/articles', { sid: sidD, body: step.body });
    expect(created.status === 200 && created.json?.ok === true && typeof created.json.articleId === 'string', `[${step.id}] 기사 생성 실패 status=${created.status} reason=${created.json?.reason ?? '-'}`);
    const articleId = created.json.articleId;
    articles[step.id] = articleId;
    if (step.roundTrip.length > 0) {
      // **송고 전**에 두 서버가 제어문자·이모지를 동일하게 저장했는지 API 로 되읽는다 — 갈리면 스풀 대조 전에 그것이 발견이다(§4-2 (마)).
      const contents = await getContents(articleId);
      for (const field of step.roundTrip) {
        expect(contents && contents[field] === step.body[field], `[${step.id}] 저장 왕복 불일치(송고 전) ${field}: 보낸 값 ${JSON.stringify(step.body[field])} 되읽은 값 ${JSON.stringify(contents?.[field])}`);
      }
    }

    const sent = await api(baseUrl, 'POST', `/api/articles/${articleId}/action`, { sid: sidD, body: { action: 'send' } });
    expect(sent.status === 200 && sent.json?.ok === true, `[${step.id}] 송고 실패 status=${sent.status} reason=${sent.json?.reason ?? '-'}`);
    expect(sent.json.status === step.afterSend, `[${step.id}] 송고 직후 status 기대 ${step.afterSend} 실제 ${sent.json.status}`);

    if (step.settled) {
      await poll(() => getContents(articleId), (c) => c && c.status === step.settled && Boolean(c.distributedAt), `[${step.id}] 송고 배부 정착(${step.settled}+distributedAt)`, opts.timeout);
    }
    if (step.tickKinds) {
      const tick = await api(baseUrl, 'POST', '/api/distribution/tick', { sid: sidZ });
      expect(tick.status === 200 && tick.json?.ok === true, `[${step.id}] tick 실패 status=${tick.status} reason=${tick.json?.reason ?? '-'}`);
      const mine = (tick.json.distributed ?? []).find((d) => d.articleId === articleId);
      expect(mine, `[${step.id}] tick 응답에 이 기사가 없다(scanned=${tick.json.scanned} distributed=${tick.json.distributed?.length})`);
      expect(JSON.stringify(mine.kinds) === JSON.stringify(step.tickKinds) && mine.status === 'DPS', `[${step.id}] tick 결과 기대 kinds=${JSON.stringify(step.tickKinds)}/DPS 실제 ${JSON.stringify(mine)}`);
      await poll(() => getContents(articleId), (c) => c && c.status === 'DPS' && Boolean(c.distributedAt), `[${step.id}] tick 후 DPS`, opts.timeout);
    }
    if (step.retry) {
      const listed = await poll(
        () => api(baseUrl, 'GET', '/api/distribution/failures', { sid: sidZ }),
        (r) => r.status === 200 && (r.json?.items ?? []).some((it) => it.articleId === articleId),
        `[${step.id}] 실패 원장에 이 기사`, opts.timeout,
      );
      const mine = listed.json.items.filter((it) => it.articleId === articleId);
      expect(mine.length === 1, `[${step.id}] 이 기사의 미해소 실패가 1건이어야 한다: ${mine.length}`);
      const item = mine[0];
      // 원장 투영은 두 서버가 같은 모양이어야 한다 — 식별자·시각 밖의 필드만 남겨 뒤에서 대조한다.
      failureViews[step.id] = {
        reason: item.reason, kind: item.kind, targetKind: item.targetKind, targetActive: item.targetActive,
        targetName: item.targetName, kindDistributed: item.kindDistributed, itemKeys: Object.keys(item).sort(),
        targetIdMatches: item.targetId === targetIds[plan.retryTarget.spoolDir],
      };
      expect(item.reason === 'spool-write-failed', `[${step.id}] 실패 사유 기대 spool-write-failed 실제 ${item.reason}`);
      fs.rmSync(blockPath);
      const retried = await api(baseUrl, 'POST', '/api/distribution/retry', { sid: sidZ, body: { historyId: item.historyId } });
      expect(retried.status === 200 && retried.json?.ok === true, `[${step.id}] 재전송 실패 status=${retried.status} reason=${retried.json?.reason ?? '-'}`);
      expect(retried.json.articleId === articleId && retried.json.kind === 'press', `[${step.id}] 재전송 응답 shape: ${JSON.stringify(Object.keys(retried.json))}`);
      await poll(
        () => api(baseUrl, 'GET', '/api/distribution/failures', { sid: sidZ }),
        (r) => r.status === 200 && !(r.json?.items ?? []).some((it) => it.articleId === articleId),
        `[${step.id}] 재전송 후 원장 해소`, opts.timeout,
      );
      await poll(
        () => fs.existsSync(blockPath) && fs.statSync(blockPath).isDirectory() ? fs.readdirSync(blockPath) : [],
        (names) => names.some((n) => parseSpoolFileName(n)?.articleId === articleId),
        `[${step.id}] 재전송 스풀 파일`, opts.timeout,
      );
    }
    log(`${step.id} ${step.label} → ok`);
  }
  return { articles, failureViews };
}

// 스풀 루트 아래 전 파일(임시 .tmp·엉뚱한 이름 포함 — 판정부가 거른다). 폴더는 루트 바로 아래 1단계만 정상이다.
function collectSpool(rootDir) {
  const files = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = nodePath.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs, rel ? `${rel}/${name}` : name);
      else files.push({ folder: rel || '.', name, text: fs.readFileSync(abs, 'utf8') });
    }
  };
  walk(rootDir, '');
  return files;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  process.stdout.write(`spool-parity 시작 db=${opts.db}\n`);
  runSelfTest(SELF_TEST, 'scripts/lib/spoolParity.self-test.mjs');

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

  // --out-dir 가드는 임시 루트를 만들기 **전**에 — 거부 경로에서 spool-parity-* 디렉토리가 남지 않게.
  const givenOutDir = opts.outDir ? assertOutsideRepo(opts.outDir, '--out-dir') : null;
  const root = assertOutsideRepo(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'spool-parity-')), '임시 루트');
  const outDir = givenOutDir ?? nodePath.join(root, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const ownsOutDir = !opts.outDir;
  const plan = buildScenarioPlan(Date.now());
  const expected = expectedFolderCounts(plan);
  process.stdout.write(`  jar=${nodePath.relative(REPO_ROOT, jar).replace(/\\/g, '/')} 시나리오 ${plan.steps.length}축 · 기대 파일 ${JSON.stringify(expected)} · 자리표시자 ${JSON.stringify([...PLACEHOLDER_KEYS])}+파일명\n  tmp=${root}\n`);

  const ctx = { javaBin, migratorJar, mysql, secrets: mysql ? [mysql.password] : [], secretLeaks: [] };
  const repoBefore = repoDataSnapshot();
  const failures = [];
  const children = [];
  const targets = [
    { label: 'node', argv: [NODE_SERVER], bin: process.execPath },
    { label: 'spring', argv: ['-jar', jar], bin: javaBin },
  ];
  const bootLogs = {};
  const replays = {};
  let ephemeralDb = null;
  let seedDigest = null;
  let result = null;
  let interrupted = false;
  // SIGINT — finally 가 돌지 않는 유일한 경로. 자식은 SIGKILL(연결을 먼저 끊는다), 임시 MySQL DB 는 마이그레이터를 spawnSync 로 돌려
  // **동기** 드롭한다(비동기로는 exit 전에 끝나지 않는다). 드롭이 실패하면 이름만 남긴다(값·출력은 싣지 않는다). 임시 디렉토리는 진단용으로 남는다.
  process.on('SIGINT', () => {
    if (interrupted) return;
    interrupted = true;
    for (const child of children) { try { child.kill('SIGKILL'); } catch { /* 이미 죽음 */ } }
    if (ephemeralDb) {
      if (dropEphemeralSync(ctx, root, ephemeralDb)) process.stderr.write(`warn 중단 — 임시 MySQL DB 드롭 완료: ${ephemeralDb}\n`);
      else process.stderr.write(`warn 중단으로 남은 임시 MySQL DB(드롭 실패 — 직접 지워라): ${ephemeralDb}\n`);
    }
    process.exit(130);
  });

  try {
    // 1. 시드 + [mysql 적재] + 포트 + 기동 (두 서버 나란히 — 각각 다른 DATA_DIR·다른 스풀 · cwd 도 임시 루트)
    const taken = new Set();
    for (const target of targets) Object.assign(target, seedTarget(root, target.label));
    if (targets[0].spoolDir === targets[1].spoolDir) throw new Error('두 서버의 DIST_SPOOL_DIR 이 같다 — 짝짓기가 붕괴한다(조립 거부)');
    for (const target of targets) {
      target.port = await pickFreePort(taken);
      target.baseUrl = `http://${CONNECT_HOST}:${target.port}`;
      const env = serverEnv(target.dataDir, target.port, target.spoolDir);
      if (target.label === 'spring' && mysql) {
        ephemeralDb = requireEphemeralDbName(ephemeralDbName());
        const passUrl = urlForDatabase(mysql.url, ephemeralDb);
        const loadStart = Date.now();
        if (!await migratorStep(ctx, root, ['ephemeral-create', '--name', ephemeralDb], null, failures)) throw new Error('ephemeral-create 실패');
        if (!await migratorStep(ctx, root, ['migrate', '--source', target.seedFile, '--target', PASS_KEY_SET], passUrl, failures)) throw new Error('migrate 실패');
        // 적재가 끝난 **이 시점**이 기준점이다 — 여기서부터 임시 news.db 는 아무도 열지 않아야 한다(7-d 동형 단언).
        seedDigest = fileDigest(target.seedFile);
        process.stdout.write(`  [spring] mysql 적재 db=${ephemeralDb} ${Date.now() - loadStart}ms seedDb=${seedDigest.md5}\n`);
        Object.assign(env, springMysqlEnv(mysql, passUrl));
      }
      target.child = spawn(target.bin, target.argv, { cwd: nodePath.join(root, target.label), env, stdio: ['ignore', 'pipe', 'pipe'] });
      // spawn 실패(ENOENT·EACCES)는 비동기 'error' 로 온다 — 리스너가 없으면 uncaught 로 죽어 finally(자식 종료·임시 DB 드롭)가 돌지 않는다.
      target.child.on('error', (err) => {
        target.child.spawnError = err;
        failures.push(`[${target.label}] 자식 프로세스 오류(spawn/kill): ${err && err.code ? err.code : err}`);
      });
      children.push(target.child);
      target.buf = collectOutput(target.child);
      process.stdout.write(`  [${target.label}] 기동 pid=${target.child.pid ?? '-'} port=${target.port} db=${target.label === 'spring' && ephemeralDb ? ephemeralDb : 'sqlite'} spool=<tmp>/${target.label}/spool\n`);
    }
    // 2. health
    for (const target of targets) {
      const bootStart = Date.now();
      if (!await waitHealthy(target.baseUrl, opts.timeout, target.child)) {
        failures.push(`[${target.label}] 기동/health 실패(${Date.now() - bootStart}ms exit=${target.child.exitCode} signal=${target.child.signalCode}) — 기동 로그 참조`);
        if (`${target.buf.out}${target.buf.err}`.includes('Unresolved compilation problem')) {
          failures.push(`[${target.label}] jar 에 IDE 가 컴파일한 클래스가 섞여 있다(Unresolved compilation problem) — 회귀가 아니다. ${BUILD_HINT.replace('-q package', '-q clean package')} 로 다시 굽고 재실행하라.`);
        }
        continue;
      }
      process.stdout.write(`  [${target.label}] health ok ${Date.now() - bootStart}ms\n`);
    }
    // 3. 같은 시나리오를 두 대상에 순차 재생
    if (failures.length === 0) {
      for (const target of targets) {
        const started = Date.now();
        try {
          replays[target.label] = await replay(target, plan, opts, (line) => process.stdout.write(`  [${target.label}] ${line}\n`));
          process.stdout.write(`  [${target.label}] 재생 완료 ${Date.now() - started}ms\n`);
        } catch (err) {
          failures.push(`[${target.label}] 시나리오 재생 실패: ${err.message} — 구현 차이로 단정하기 전에 시나리오(대상 활성·엠바고 판정·tick 순서)를 먼저 의심하라`);
        }
      }
    }
    // 4. 스풀 수집 → 시나리오 자기 점검(기대 파일 수) → 실패 원장 모양 대조 → 순수 판정부
    if (failures.length === 0) {
      const sides = {};
      for (const target of targets) {
        const files = collectSpool(target.spoolDir);
        const counts = {};
        for (const f of files) counts[f.folder] = (counts[f.folder] ?? 0) + 1;
        const sortedCounts = Object.fromEntries(Object.entries(counts).sort());
        if (JSON.stringify(sortedCounts) !== JSON.stringify(Object.fromEntries(Object.entries(expected).sort()))) {
          failures.push(`[${target.label}] 스풀 파일 수가 시나리오 기대와 다르다: 기대 ${JSON.stringify(expected)} 실제 ${JSON.stringify(sortedCounts)} — 먼저 시나리오를 의심하라`);
        }
        sides[target.label] = { label: target.label, files, steps: stepsByArticle(replays[target.label].articles) };
        process.stdout.write(`  [${target.label}] 스풀 파일 ${files.length}건 ${JSON.stringify(sortedCounts)}\n`);
      }
      const viewA = JSON.stringify(replays.node.failureViews);
      const viewB = JSON.stringify(replays.spring.failureViews);
      if (viewA !== viewB) failures.push(`실패 원장 투영이 두 서버에서 다르다: node=${viewA} spring=${viewB}`);
      result = compareSpools(sides.node, sides.spring);
      for (const target of targets) {
        const report = {
          target: target.label, db: target.label === 'spring' ? opts.db : 'sqlite', placeholders: [...PLACEHOLDER_KEYS],
          files: sides[target.label].files.map((f) => ({ folder: f.folder, name: f.name, step: lookupStep(sides[target.label].steps, parseSpoolFileName(f.name)?.articleId), bytes: Buffer.byteLength(f.text, 'utf8'), sha256: sha256Hex(f.text) })),
        };
        fs.writeFileSync(nodePath.join(outDir, `${target.label}.json`), `${JSON.stringify(report, null, 2)}\n`);
      }
      fs.writeFileSync(nodePath.join(outDir, 'diff.json'), `${JSON.stringify({ summary: formatSummary(result), failures: result.failures, diffs: result.diffs, counts: result.counts, blinded: result.blinded }, null, 2)}\n`);
      const lines = formatDiffLines(result);
      if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
      failures.push(...result.failures);
      if (result.diffs.length > 0) failures.push(`정규화 후 바이트 차이 ${result.diffs.length}건 — 위 DIFF 줄 참조(리포트: ${nodePath.join(outDir, 'diff.json')})`);
      if (result.ok && result.fileCount !== Object.values(expected).reduce((a, b) => a + b, 0)) failures.push(`대조한 파일 수 ${result.fileCount} ≠ 기대 ${Object.values(expected).reduce((a, b) => a + b, 0)}`);
    }
  } catch (err) {
    failures.push(`실행 예외: ${err && err.stack ? err.stack : err}`);
  } finally {
    // finally 안에서 throw 가 나면 그 뒤는 전부 건너뛴다(임시 DB 잔존·md5 단언 누락). 그래서 순서는 5-a 자식 종료 → 5-b md5 단언·드롭 →
    // 5-c 기동 로그 기록이고, 항목마다 try/catch 로 격리한다(실패는 failures 에 남긴다). 드롭은 자식을 죽인 **뒤**다(연결을 쥔 채 DROP 하지 않는다).
    // 5-a. 자식 종료 — 실패해도 반드시 시도한다(잔존 = 다음 실행의 포트·파일 잠금 오염).
    for (const target of targets) {
      if (!target.child) continue;
      try {
        const killed = await killChild(target.child);
        if (!killed) failures.push(`[${target.label}] 프로세스 종료 실패(SIGKILL 후에도 잔존) pid=${target.child.pid}`);
      } catch (err) {
        failures.push(`[${target.label}] 프로세스 종료 중 예외: ${err && err.message ? err.message : err}`);
      }
    }
    // 5-b. mysql: 임시 news.db 무변(= Spring 이 SQLite 를 열지 않았다) · 임시 DB 드롭(성패·--keep 무관)
    if (seedDigest) {
      try {
        const after = fileDigest(targets[1].seedFile);
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
    // 5-c. 기동 로그 — 비밀 가림 + 경로 가림 뒤 파일로. 쓰기 실패는 실패로 남기되 다른 항목을 막지 않는다.
    for (const target of targets) {
      if (!target.child) continue;
      try {
        const text = scrub(ctx, `[${target.label}]`, `${target.buf.out}\n--- stderr ---\n${target.buf.err}`);
        bootLogs[target.label] = scrubPaths(text, [[root, '<tmp>'], [REPO_ROOT, '<repo>']]);
        fs.writeFileSync(nodePath.join(outDir, `${target.label}-boot.log`), bootLogs[target.label]);
      } catch (err) {
        failures.push(`[${target.label}] 기동 로그 기록 실패: ${err && err.code ? err.code : err}`);
      }
    }
  }

  // 7. 데이터 안전 · 잔존 · 비밀 위생
  const repoAfter = repoDataSnapshot();
  if (JSON.stringify(repoBefore) !== JSON.stringify(repoAfter)) failures.push(`리포 news.db/uploads 변동: before=${JSON.stringify(repoBefore)} after=${JSON.stringify(repoAfter)}`);
  for (const target of targets) {
    if (target.child && !childDead(target.child)) failures.push(`[${target.label}] 자식 프로세스가 아직 살아 있다 pid=${target.child.pid}`);
  }
  failures.push(...ctx.secretLeaks);

  const ok = failures.length === 0;
  if (ok && !opts.keep) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      process.stdout.write(`  정리: 자식 ${targets.length} 종료 확인 · 임시 디렉토리 삭제${ownsOutDir ? '(리포트 포함 — 보존하려면 --out-dir 또는 --keep)' : ''}\n`);
    } catch (err) {
      process.stderr.write(`warn 임시 디렉토리 정리 실패(무해 — Windows 파일 잠금): ${root} (${err && err.code})\n`);
    }
  } else {
    process.stdout.write(`keep 임시 디렉토리 보존(${ok ? '--keep' : '실패 진단용'} — 확인 후 삭제하라): ${root}\n`);
    if (!ok) for (const [label, log] of Object.entries(bootLogs)) process.stdout.write(`--- ${label} 기동 로그(끝 20줄) ---\n${log.split('\n').slice(-20).join('\n')}\n`);
  }
  if (!ok) process.stderr.write(`${failures.map((f) => `FAIL ${f}`).join('\n')}\n`);
  // 요약 줄은 판정 **하나**(종합)만 붙인다 — 수치는 formatCounts(다섯 수치), 스풀 수집 전에 실패하면 수치 없이 '비교 불가'.
  process.stdout.write(`${result ? formatCounts(result) : 'spool-parity 비교 불가(스풀 수집 전 실패 — 수치 없음)'} db=${opts.db} → ${ok ? 'ok' : 'FAILED'}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`spool-parity 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
