// 운영 적재 리허설 (phase 76 step8 작업 A) — **사본 한 개**로 75 의 경로를 끝까지 돌고 수치를 남긴다:
//   부산물 가드 → ephemeral-create → migrate → verify → export → verify(산출물) → **그 산출물로 Node 기동**
//   → 로그인·목록·상세 자동 판정 → 부팅 전후 md5 → ephemeral-drop.
// 마지막 두 줄이 이 리허설의 요점이다: **롤백 자산이 진짜인가**(Node 가 그 파일로 실제로 뜨는가)와
// **소스 사본이 한 바이트도 변하지 않았는가**.
//
// 사용: node scripts/load-rehearsal.mjs --source <사본.db> [--work <리포 밖 디렉토리>] [--java-home <path>]
//                                       [--timeout <ms>]
//   자격은 argv 가 아니라 환경변수다: NEWS_CT_MYSQL_URL/_USERNAME/_PASSWORD (docs/ops-mysql.md §3 · 한 줄씩).
//   로그인 계정은 기본이 src/db/seed.js 의 SAMPLE_USERS 이고, 운영 사본이면 NEWS_REHEARSAL_USER/_PASSWORD 로 준다.
//
// CRITICAL(비파괴): 대상은 **임시 DB(harness_ct_<16hex>) 뿐**이다 — `news`·`news_stage` 를 대상으로 쓰지 않는다
//   (전자는 컷오버 대상이라 비어 있어야 하고 후자는 드리프트했다). 소스는 읽기만 하고(마이그레이터가 읽기 전용으로
//   연다) 실행 전후 크기·md5 를 **바깥에서도** 잰다. 산출물·작업 디렉토리는 **리포 밖**이다.
// 로그 규율: 세션 토큰·비밀번호·MySQL 자격을 stdout/stderr/파일 어디에도 쓰지 않는다(자식 출력은 redactSecrets).
// 주의: scripts/** 는 eslint ignore 대상이다 — 인자 가드(scripts/lib/cliArgs.mjs)와 자기검사가 정적 안전망이다.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SAMPLE_USERS } from '../src/db/seed.js';
import { flagValue } from './lib/cliArgs.mjs';
import {
  PASS_KEY_SET, ephemeralDbName, requireEphemeralDbName, urlForDatabase,
  readMysqlCredentials, migratorChildEnv, redactSecrets,
} from './lib/mysqlHarness.mjs';
import { pathIsInside } from './lib/spoolParity.mjs';
import { cellsOf, digestProblems, parseVerifyReport, sidecarsOf, totalsOf } from './lib/loadRehearsal.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const NODE_SERVER = nodePath.join(REPO_ROOT, 'server', 'index.js');
const MIGRATOR_JAR = nodePath.join(REPO_ROOT, 'tools', 'news-migrator', 'target', 'news-migrator.jar');
const SELF_TEST = nodePath.join(nodePath.dirname(SCRIPT_PATH), 'lib', 'loadRehearsal.self-test.mjs');
const MYSQL_SELF_TEST = nodePath.join(nodePath.dirname(SCRIPT_PATH), 'lib', 'mysqlHarness.test.mjs');
const CONNECT_HOST = '127.0.0.1';
const PORT_BASE = 15000;
const PORT_SPAN = 5000;
const JDK_HINT = 'D:/agents/tools/jdk-25.0.4.1+1';
const MIGRATOR_BUILD_HINT = `cd tools/news-migrator && JAVA_HOME="${JDK_HINT}" ./mvnw -B -q package -DskipTests`;
// 마이그레이터의 한글 메시지는 이 두 옵션이 없으면 깨진다(docs/ops-mysql.md §11-0-5 실측).
const ENCODING_FLAGS = ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'];

const USAGE = `사용법: node scripts/load-rehearsal.mjs --source <사본.db> [--work <리포 밖 디렉토리>] [--java-home <path>] [--timeout <ms>]
  --source <파일>    리허설 소스 = 운영 news.db 의 **사본**(리포 밖). 원본을 주지 마라.
  --work <디렉토리>  산출물·리포트를 둘 곳. 미지정=OS 임시 디렉토리. **리포 안에는 쓰지 않는다.**
  --java-home <path> JDK 홈. 미지정=SPRING_JAVA_HOME → JAVA_HOME 순(시스템 java 폴백 금지).
  --timeout <ms>     기동·요청 대기 한도(기본 60000, 1000 이상 정수).
  작업 디렉토리·산출물은 **언제나 보존한다**(이 스크립트에는 지우는 경로가 없다 — 임시 MySQL DB 만 드롭한다).`;

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
  const opts = { timeout: 60000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') { opts.source = take(i, '--source'); i += 1; }
    else if (a === '--work') { opts.work = take(i, '--work'); i += 1; }
    else if (a === '--java-home') { opts.javaHome = take(i, '--java-home'); i += 1; }
    else if (a === '--timeout') { opts.timeout = Number(take(i, '--timeout')); i += 1; }
    else usageDie(`알 수 없는 인자: ${a}`);
  }
  if (!opts.source) usageDie('--source <사본.db> 가 필요하다(운영 원본이 아니라 사본이다).');
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) usageDie(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${opts.timeout}`);
  return opts;
}

function runSelfTest(file, label) {
  if (!fs.existsSync(file)) usageDie(`판정부 자기검사 파일이 없다: ${file} — 조용히 건너뛰지 않는다.`);
  const result = spawnSync(process.execPath, ['--test', file], { cwd: REPO_ROOT, env: childEnv(), encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(String(result.stdout ?? '') + String(result.stderr ?? ''));
    usageDie(`판정부 자기검사가 실패했다(node --test ${label}) — 빨간 판정부로는 리허설하지 않는다.`);
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

async function pickFreePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = PORT_BASE + Math.floor(Math.random() * PORT_SPAN);
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(candidate, CONNECT_HOST, () => srv.close(() => resolve(true)));
    });
    if (free) return candidate;
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

function fileDigest(file) {
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  return { size: bytes.length, md5: createHash('md5').update(bytes).digest('hex') };
}

function resolveMigratorJar() {
  if (!fs.existsSync(MIGRATOR_JAR)) usageDie(`마이그레이터 jar 가 없다(${MIGRATOR_JAR}). 먼저 빌드하라:\n  ${MIGRATOR_BUILD_HINT}`);
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

function scrub(ctx, label, text) {
  const result = redactSecrets(text, ctx.secrets);
  if (result.hits > 0) ctx.secretLeaks.push(`${label} 출력에 비밀 값이 ${result.hits}회 섞여 나왔다 — 가려서 남겼지만 원인을 고쳐라.`);
  if (result.unredactable > 0) ctx.secretLeaks.push(`${label}: 가릴 수 없는 짧은 비밀이 ${result.unredactable}건 있다(docs/ops-mysql.md §3-1).`);
  return result.text;
}

function runMigrator(ctx, cwd, args, passUrl) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(ctx.javaBin, [...ENCODING_FLAGS, '-jar', ctx.migratorJar, ...args], {
      cwd, env: migratorChildEnv(childEnv(), ctx.mysql, passUrl), stdio: ['ignore', 'pipe', 'pipe'],
    });
    // SIGINT 핸들러가 죽일 수 있게 등록한다 — 등록하지 않으면 migrate/verify/export 진행 중 Ctrl+C 에 java 자식이
    // 고아가 되고, 그 자식이 JDBC 연결을 쥔 채 동기 드롭이 시도된다. 끝난 자식은 빼지 않아도 killChild 가 무시한다(childDead).
    ctx.children.push(child);
    const buf = collectOutput(child);
    child.once('error', (err) => {
      child.spawnError = err; // childDead → 정리 루프가 죽은 자식을 5초 기다리지 않는다
      resolve({ code: null, ms: Date.now() - started, out: buf.out, err: `${buf.err}\nspawn error: ${err && err.code ? err.code : err}` });
    });
    child.once('close', (code) => resolve({ code, ms: Date.now() - started, out: buf.out, err: buf.err }));
  });
}

// SIGINT 경로 전용 — **동기** 드롭(process.exit 전에 끝나야 한다).
function dropEphemeralSync(ctx, cwd, name) {
  const result = spawnSync(ctx.javaBin, [...ENCODING_FLAGS, '-jar', ctx.migratorJar, 'ephemeral-drop', '--name', name], {
    cwd, env: migratorChildEnv(childEnv(), ctx.mysql, null), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000,
  });
  if (result.status === 0) return true;
  process.stderr.write(`${scrub(ctx, 'migrator ephemeral-drop(SIGINT)', `${result.stdout ?? ''}${result.stderr ?? ''}`).slice(-2000)}\n`);
  return false;
}

/**
 * verify 한 회의 판정. **파싱이 온전한지도 실패 조건**이다 — 표 줄을 못 읽으면 `불일치 0`·`구조 0`이 자동으로
 * 참이 되어(규모 수치는 전부 0인데) 리허설이 green 으로 끝난다.
 */
function verifyProblems(label, parsed) {
  if (parsed.matched && parsed.diffs === 0 && parsed.structural.length === 0) return [];
  const reasons = parsed.parseIncomplete.length > 0 ? ` 파싱=${parsed.parseIncomplete.join(' / ')}` : '';
  return [`${label} 불일치: 판정=${parsed.verdict} 불일치=${parsed.diffs} 구조=${parsed.structural.length}${reasons}`];
}

async function step(ctx, name, args, passUrl, { expect = 0 } = {}) {
  const result = await runMigrator(ctx, ctx.work, args, passUrl);
  const text = scrub(ctx, `migrator ${args[0]}`, `${result.out}${result.err}`);
  const record = { name, command: args[0], exit: result.code, ms: result.ms, text };
  ctx.steps.push(record);
  process.stdout.write(`  ${name}: exit=${result.code} ${result.ms}ms\n`);
  if (expect !== null && result.code !== expect) {
    ctx.failures.push(`${name}: 종료코드 기대 ${expect} 실제 ${result.code}\n--- 출력 ---\n${text.slice(-2000)}`);
  }
  return record;
}

// --- HTTP(Node 판정) — 세션 토큰은 메모리에만 있고 어떤 메시지에도 담지 않는다 ---
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

/**
 * 로그인 계정 후보 — 운영 사본에는 SAMPLE_USERS 가 없으므로 환경변수로 준다(argv 로 받지 않는다: 프로세스
 * 목록은 같은 머신의 누구나 읽는다). 기본은 리포 표본의 개발 계정이다.
 */
function loginCandidates() {
  const user = process.env.NEWS_REHEARSAL_USER;
  const password = process.env.NEWS_REHEARSAL_PASSWORD;
  if (user && password) return [{ userId: user, password, source: 'env' }];
  return SAMPLE_USERS.map((u) => ({ userId: u.userId, password: u.password, source: 'seed' }));
}

async function probeNode(ctx, dataDir, exportFile) {
  const port = await pickFreePort();
  const baseUrl = `http://${CONNECT_HOST}:${port}`;
  const env = { ...childEnv(), DATA_DIR: dataDir, PORT: String(port), HOST: CONNECT_HOST };
  const bootStart = Date.now();
  const child = spawn(process.execPath, [NODE_SERVER], { cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.children.push(child);
  child.on('error', (err) => {
    child.spawnError = err;
    ctx.failures.push(`[node] 자식 프로세스 오류(spawn/kill): ${err && err.code ? err.code : err}`);
  });
  const buf = collectOutput(child);
  const observation = { port, bootMs: null, login: null, list: null, detail: null, listCount: null };
  try {
    if (!await waitHealthy(baseUrl, ctx.timeout, child)) {
      ctx.failures.push(`[node] 기동/health 실패(exit=${child.exitCode} signal=${child.signalCode})\n--- 기동 로그 ---\n${scrub(ctx, '[node]', `${buf.out}${buf.err}`).slice(-2000)}`);
      return observation;
    }
    observation.bootMs = Date.now() - bootStart;
    process.stdout.write(`  [node] health ok ${observation.bootMs}ms port=${port}\n`);

    let sid = null;
    for (const candidate of loginCandidates()) {
      const res = await api(baseUrl, 'POST', '/api/login', { body: { userId: candidate.userId, password: candidate.password } });
      observation.login = res.status;
      if (res.status === 200 && typeof res.json?.sessionId === 'string') {
        sid = res.json.sessionId;
        observation.loginUser = candidate.userId;
        observation.loginSource = candidate.source;
        break;
      }
    }
    if (!sid) {
      ctx.failures.push('[node] 로그인 실패 — 운영 사본이면 NEWS_REHEARSAL_USER/_PASSWORD 환경변수로 계정을 주어라(값은 argv 에 두지 마라).');
      return observation;
    }
    const list = await api(baseUrl, 'GET', '/api/articles', { sid });
    observation.list = list.status;
    const items = list.json?.items ?? list.json?.articles ?? (Array.isArray(list.json) ? list.json : []);
    observation.listCount = Array.isArray(items) ? items.length : null;
    if (list.status !== 200 || !Array.isArray(items)) {
      ctx.failures.push(`[node] 목록 실패 status=${list.status} body keys=${JSON.stringify(Object.keys(list.json ?? {}))}`);
      return observation;
    }
    const first = items[0]?.articleId;
    if (!first) {
      ctx.failures.push('[node] 목록이 비어 있어 상세를 볼 수 없다 — 사본에 기사가 없다(그 사실 자체가 발견이다).');
      return observation;
    }
    const detail = await api(baseUrl, 'GET', `/api/articles/${first}`, { sid });
    observation.detail = detail.status;
    observation.detailHasContents = Boolean(detail.json?.contents);
    if (detail.status !== 200 || !detail.json?.contents) {
      ctx.failures.push(`[node] 상세 실패 status=${detail.status}`);
    }
    process.stdout.write(`  [node] 로그인 ${observation.login} · 목록 ${observation.list}(${observation.listCount}건) · 상세 ${observation.detail}\n`);
  }
  finally {
    await killChild(child);
    ctx.bootLog = scrub(ctx, '[node]', `${buf.out}\n--- stderr ---\n${buf.err}`);
    observation.exportAfterBoot = fileDigest(exportFile);
  }
  return observation;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const source = nodePath.resolve(opts.source);
  process.stdout.write(`load-rehearsal 시작 source=${source}\n`);
  runSelfTest(SELF_TEST, 'scripts/lib/loadRehearsal.self-test.mjs');
  runSelfTest(MYSQL_SELF_TEST, 'scripts/lib/mysqlHarness.test.mjs');

  if (!fs.existsSync(source)) usageDie(`사본이 없다: ${source}`);
  if (pathIsInside(source, REPO_ROOT, process.platform)) {
    usageDie(`소스는 리포 밖 사본이어야 한다(리포 파일을 리허설 대상으로 열지 않는다): ${source}`);
  }
  const sidecars = sidecarsOf(source, (path) => fs.existsSync(path));
  if (sidecars.length > 0) {
    usageDie(`사본 옆에 부산물이 있다 ${JSON.stringify(sidecars)} — 서버를 정상 종료한 뒤 사본을 다시 뜨라(부산물을 지우지 마라).`);
  }

  let mysql = null;
  try { mysql = readMysqlCredentials(process.env); } catch (err) { usageDie(err.message); }
  for (const warning of mysql.warnings) process.stderr.write(`${warning}\n`);
  const javaBin = resolveJavaBin(opts.javaHome);
  const migratorJar = resolveMigratorJar();

  const work = opts.work
    ? assertOutsideRepo(opts.work, '--work')
    : assertOutsideRepo(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'load-rehearsal-')), '작업 디렉토리');
  fs.mkdirSync(work, { recursive: true });
  const rollbackDir = nodePath.join(work, `rollback-${Date.now()}`);
  fs.mkdirSync(rollbackDir, { recursive: true });
  const exportFile = nodePath.join(rollbackDir, 'news.db');

  const ctx = {
    javaBin, migratorJar, mysql, work, timeout: opts.timeout,
    secrets: [mysql.password], secretLeaks: [], failures: [], steps: [], children: [],
  };
  const before = fileDigest(source);
  process.stdout.write(`  소스 사본 ${before.size}B md5 ${before.md5}\n  작업 디렉토리 ${work}\n`);

  let ephemeralDb = null;
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) return;
    interrupted = true;
    for (const child of ctx.children) { try { child.kill('SIGKILL'); } catch { /* 이미 죽음 */ } }
    if (ephemeralDb) {
      if (dropEphemeralSync(ctx, work, ephemeralDb)) process.stderr.write(`warn 중단 — 임시 MySQL DB 드롭 완료: ${ephemeralDb}\n`);
      else process.stderr.write(`warn 중단으로 남은 임시 MySQL DB(드롭 실패 — 직접 지워라): ${ephemeralDb}\n`);
    }
    process.exit(130);
  });

  const report = { source, sourceDigest: before, work, exportFile, steps: [], node: null };
  try {
    ephemeralDb = requireEphemeralDbName(ephemeralDbName());
    const passUrl = urlForDatabase(mysql.url, ephemeralDb);
    process.stdout.write(`  임시 DB ${ephemeralDb}\n`);
    await step(ctx, '1. ephemeral-create', ['ephemeral-create', '--name', ephemeralDb], null);
    if (ctx.failures.length === 0) {
      const migrate = await step(ctx, '2. migrate', ['migrate', '--source', source, '--target', PASS_KEY_SET], passUrl);
      report.migrateOutput = migrate.text;
      const verify1 = await step(ctx, '3. verify(사본 ↔ 임시DB)', ['verify', '--source', source, '--target', PASS_KEY_SET], passUrl);
      report.verify1 = parseVerifyReport(verify1.text);
      ctx.failures.push(...verifyProblems('3. verify', report.verify1));
      await step(ctx, '4. export', ['export', '--target', PASS_KEY_SET, '--out', exportFile], passUrl);
      report.exportDigest = fileDigest(exportFile);
      const verify2 = await step(ctx, '5. verify(산출물 ↔ 임시DB)', ['verify', '--source', exportFile, '--target', PASS_KEY_SET], passUrl);
      report.verify2 = parseVerifyReport(verify2.text);
      ctx.failures.push(...verifyProblems('5. verify', report.verify2));
      if (ctx.failures.length === 0) {
        report.node = await probeNode(ctx, rollbackDir, exportFile);
        ctx.failures.push(...digestProblems('export 산출물(Node 부팅 전후)', report.exportDigest, report.node.exportAfterBoot));
      }
    }
  }
  catch (err) {
    ctx.failures.push(`실행 예외: ${err && err.stack ? err.stack : err}`);
  }
  finally {
    for (const child of ctx.children) {
      try { if (!await killChild(child)) ctx.failures.push(`자식 프로세스 종료 실패 pid=${child.pid}`); }
      catch (err) { ctx.failures.push(`자식 종료 중 예외: ${err && err.message ? err.message : err}`); }
    }
    if (ephemeralDb) {
      const dropped = await step(ctx, '7. ephemeral-drop', ['ephemeral-drop', '--name', ephemeralDb], null);
      if (dropped.exit === 0) { process.stdout.write(`  임시 MySQL DB 드롭 ${ephemeralDb}\n`); ephemeralDb = null; }
      else process.stderr.write(`warn 임시 MySQL DB 정리 실패(직접 지워라): ${ephemeralDb}\n`);
    }
  }

  const after = fileDigest(source);
  ctx.failures.push(...digestProblems('소스 사본', before, after));
  const sidecarsAfter = sidecarsOf(source, (path) => fs.existsSync(path));
  if (sidecarsAfter.length > 0) ctx.failures.push(`리허설 뒤 사본 옆에 부산물이 생겼다 ${JSON.stringify(sidecarsAfter)}`);
  ctx.failures.push(...ctx.secretLeaks);

  // --- 측정 기록 ---
  const totals = report.verify1 ? totalsOf(report.verify1.tables) : null;
  report.totals = totals;
  report.cells = report.verify1 ? cellsOf(report.verify1.tables) : null;
  report.steps = ctx.steps.map(({ name, command, exit, ms }) => ({ name, command, exit, ms }));
  report.sourceDigestAfter = after;
  process.stdout.write('\n--- 측정 ---\n');
  for (const s of report.steps) process.stdout.write(`${s.name.padEnd(28)} exit=${s.exit} ${String(s.ms).padStart(7)}ms\n`);
  if (report.verify1) {
    for (const table of report.verify1.tables) {
      process.stdout.write(`${table.table.padEnd(20)}${String(table.sourceRows).padStart(7)}행 · 컬럼 ${String(table.columns).padStart(2)} · 불일치 ${table.diffs}\n`);
    }
    process.stdout.write(`합계 ${totals.tables}테이블 · ${totals.rows}행 · ${totals.columns}컬럼 · ${report.cells}셀\n`);
  }
  if (report.exportDigest) process.stdout.write(`export 산출물 ${report.exportDigest.size}B md5 ${report.exportDigest.md5}\n`);
  if (report.node) process.stdout.write(`Node 부팅 ${report.node.bootMs}ms · 로그인 ${report.node.login} · 목록 ${report.node.list}(${report.node.listCount}건) · 상세 ${report.node.detail}\n`);
  process.stdout.write(`소스 사본 무변: ${after ? `${after.size}B md5 ${after.md5}` : '재측정 실패'}\n`);

  const reportFile = nodePath.join(work, `rehearsal-${Date.now()}.json`);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (ctx.bootLog) fs.writeFileSync(nodePath.join(rollbackDir, 'node-boot.log'), ctx.bootLog);
  process.stdout.write(`리포트: ${reportFile}\n`);

  const ok = ctx.failures.length === 0;
  if (!ok) process.stderr.write(`${ctx.failures.map((f) => `FAIL ${f}`).join('\n')}\n`);
  process.stdout.write(`load-rehearsal → ${ok ? 'ok' : 'FAILED'}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`load-rehearsal 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
