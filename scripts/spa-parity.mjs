// SPA 응답 바이트 패리티 하네스 (phase 76 step3) — Node 서버와 Spring 서버를 **같은 web/dist** 로 나란히 띄우고
// 같은 요청 표(원문 요청줄)를 보내 응답을 대조한다. 계약 하네스(scripts/spring-contract.mjs)는 SPA 를 보지
// 않으므로(SPA_DIR 을 자식에게 넘기지 않는다 — 그리고 그것을 고치면 안 된다) 이 대조는 별도 스크립트다.
// 사용: node scripts/spa-parity.mjs [--jar <path>] [--java-home <path>] [--spa-dir <dir>] [--out-dir <dir>]
//                                   [--keep] [--timeout <ms>]
//
// 절차(spring-contract.mjs 의 규율을 베꼈고 그 파일은 고치지 않는다):
//   자기검사(node --test scripts/lib/spaParity.self-test.mjs) → 리포 밖 임시 루트 → 서버별 임시 DATA_DIR 시드
//   (스키마·시드의 단일 출처 src/db/**) → 빈 포트 2개([15000,20000) 실제 listen 프로브) → Node 기동(node server/index.js)
//   + Spring 기동(java -jar) → /api/health → **SPA 활성 확인(GET / 가 200 + index.html 바이트)** → 요청 표 → 리포트 2벌
//   → 순수 판정부로 비교 → 자식 종료(kill → 확인 → SIGKILL) → 임시 디렉토리 삭제.
//
// CRITICAL(DB 비파괴): 리포 news.db·uploads/·web/dist 에 쓰지 않는다. web/dist 는 두 서버가 **공유하는 입력**이라
//   한쪽이 바꾸면 대조가 무의미해진다(읽기만). 실행 전후 리포 news.db·uploads/ 스냅샷으로 무변을 단언한다.
// CRITICAL(두 서버는 서로 다른 DATA_DIR): Node 는 SQLite 파일과 ADR-012 잠금을 잡는다 — 같은 폴더면 SPA 축과 무관한 실패.
// CRITICAL(리포트 위생): 리포트에는 비밀·절대경로·본문 내용이 없다(순수 판정부 observe 가 그렇게 만든다). 자식의 기동
//   로그는 진단용으로 out-dir 에 남기되 임시 루트·리포 루트 경로는 가려서 남긴다.
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
import { seedUsers } from '../src/db/seed.js';
import { flagValue } from './lib/cliArgs.mjs';
import {
  REQUESTS, UPLOAD_FIXTURE_NAME, compareReports, extractAssetPaths, formatDiffLines, formatSummary, observe,
  parseHttpResponse, resolveRequestTable, sha256Hex,
} from './lib/spaParity.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const NODE_SERVER = nodePath.join(REPO_ROOT, 'server', 'index.js');
const SPRING_TARGET_DIR = nodePath.join(REPO_ROOT, 'server-spring', 'target');
const DEFAULT_SPA_DIR = nodePath.join(REPO_ROOT, 'web', 'dist');
const SELF_TEST = nodePath.join(nodePath.dirname(SCRIPT_PATH), 'lib', 'spaParity.self-test.mjs');
const CONNECT_HOST = '127.0.0.1';
// 포트 [15000,20000) — spring-contract 와 같은 구간(동시 실행 금지 규율이 있으므로 겹침은 문제가 아니다).
const PORT_BASE = 15000;
const PORT_SPAN = 5000;
const JDK_HINT = 'D:/agents/tools/jdk-25.0.4.1+1';
const BUILD_HINT = `cd server-spring && JAVA_HOME="${JDK_HINT}" ./mvnw -B -q package -DskipTests`;
// 1x1 PNG — 두 DATA_DIR 의 uploads/ 에 같은 이름으로 놓는다(/uploads 200 항목 = uploads 경로군 허용 규칙의 실증 항목).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const UPLOAD_FIXTURE_MTIME = new Date('2026-01-01T00:00:00Z');

const USAGE = `사용법: node scripts/spa-parity.mjs [--jar <path>] [--java-home <path>] [--spa-dir <dir>] [--out-dir <dir>] [--keep] [--timeout <ms>]
  --jar <path>       Spring 실행 jar. 미지정=server-spring/target/*.jar 자동 탐색(자동 빌드는 하지 않는다).
  --java-home <path> JDK 홈. 미지정=SPRING_JAVA_HOME → JAVA_HOME 순(시스템 java 폴백 금지).
  --spa-dir <dir>    두 서버가 공유할 SPA 루트. 미지정=<리포>/web/dist. <dir>/index.html 이 있어야 한다.
  --out-dir <dir>    리포트 디렉토리. 미지정=OS 임시 디렉토리. **리포 안에는 쓰지 않는다.**
  --keep             임시 디렉토리를 지우지 않는다(실패 시에는 항상 보존).
  --timeout <ms>     기동 대기 한도(기본 60000, 1000 이상 정수).`;

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
  const opts = { keep: false, timeout: 60000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--jar') { opts.jar = take(i, '--jar'); i += 1; }
    else if (a === '--java-home') { opts.javaHome = take(i, '--java-home'); i += 1; }
    else if (a === '--spa-dir') { opts.spaDir = take(i, '--spa-dir'); i += 1; }
    else if (a === '--out-dir') { opts.outDir = take(i, '--out-dir'); i += 1; }
    else if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') { opts.timeout = Number(take(i, '--timeout')); i += 1; }
    else usageDie(`알 수 없는 인자: ${a}`);
  }
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) usageDie(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${opts.timeout}`);
  return opts;
}

// --- 자기검사 — 판정부가 빨간 채로는 서버를 띄우지 않는다 ---
function runSelfTest() {
  if (!fs.existsSync(SELF_TEST)) usageDie(`판정부 자기검사 파일이 없다: ${SELF_TEST} — 조용히 건너뛰지 않는다.`);
  const result = spawnSync(process.execPath, ['--test', SELF_TEST], { cwd: REPO_ROOT, env: childEnv(), encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(String(result.stdout ?? '') + String(result.stderr ?? ''));
    usageDie('판정부 자기검사가 실패했다(node --test scripts/lib/spaParity.self-test.mjs) — 관측 헤더·허용 분류가 깨진 채로는 대조하지 않는다.');
  }
  process.stdout.write('  판정부 자기검사 통과 (node --test scripts/lib/spaParity.self-test.mjs)\n');
}

// --- 환경 조립 (spring-contract.mjs javaChildEnv 동형 — 부모 env 통째 상속 금지) ---
const OS_ENV_ALLOWLIST = process.platform === 'win32'
  ? ['SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']
  : ['PATH', 'HOME', 'LANG', 'TZ'];

function childEnv() {
  const env = {};
  for (const key of OS_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

// 두 서버에 **같은 이름·같은 값** 4키만 준다(구성 차이가 SPA 차이로 위장되지 않게). .env 는 어느 쪽도 읽지 않는다.
function serverEnv(dataDir, port, spaDir) {
  return { ...childEnv(), DATA_DIR: dataDir, PORT: String(port), HOST: CONNECT_HOST, SPA_DIR: spaDir };
}

// --- 자식 프로세스 유틸 ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childDead = (child) => child.exitCode !== null || child.signalCode !== null;

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

// --- 원시 요청 (요청줄 원문 — fetch 는 URL 을 정규화해 '..' 등을 미리 없앤다) ---
function rawRequest(port, entry) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: CONNECT_HOST, port });
    const chunks = [];
    sock.setTimeout(15000, () => { sock.destroy(new Error(`응답 대기 초과: ${entry.name}`)); });
    sock.on('connect', () => {
      let req = `${entry.method} ${entry.rawPath} HTTP/1.1\r\nHost: ${CONNECT_HOST}:${port}\r\nConnection: close\r\n`;
      for (const [k, v] of Object.entries(entry.headers)) req += `${k}: ${v}\r\n`;
      if (entry.method === 'POST') req += 'Content-Length: 0\r\n';
      sock.write(`${req}\r\n`);
    });
    sock.on('data', (d) => chunks.push(d));
    sock.on('error', reject);
    sock.on('close', () => {
      try { resolve(parseHttpResponse(Buffer.concat(chunks), { head: entry.method === 'HEAD' })); } catch (err) { reject(err); }
    });
  });
}

// --- 리포 데이터 안전 스냅샷 (spring-contract repoDataSnapshot 동형 + web/dist 지문) ---
function repoDataSnapshot() {
  const dbFile = nodePath.join(REPO_ROOT, 'news.db');
  const uploadsDir = nodePath.join(REPO_ROOT, 'uploads');
  const st = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  return {
    db: st ? { size: st.size, mtimeMs: st.mtimeMs } : null,
    uploads: fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : null,
  };
}

function distFingerprint(spaDir) {
  const files = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = nodePath.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, relPath);
      else files.push(`${relPath}:${createHash('md5').update(fs.readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(spaDir, '');
  return files.join('\n');
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

function resolveJavaBin(given) {
  const home = given || process.env.SPRING_JAVA_HOME || process.env.JAVA_HOME;
  if (!home || String(home).trim() === '') usageDie(`JDK 홈을 찾지 못했다 — --java-home <path> 또는 SPRING_JAVA_HOME/JAVA_HOME 을 설정하라(예: ${JDK_HINT}).`);
  const bin = nodePath.join(nodePath.resolve(home), 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (!fs.existsSync(bin)) usageDie(`JDK 홈에 java 실행 파일이 없다: ${bin}`);
  return bin;
}

function resolveSpaDir(given) {
  const abs = nodePath.resolve(given || DEFAULT_SPA_DIR);
  if (!fs.existsSync(nodePath.join(abs, 'index.html'))) {
    usageDie(`SPA 루트에 index.html 이 없다: ${abs} — 리포 web/dist 라면 'npm run build' 를 먼저 돌려라.`);
  }
  return abs;
}

function assertOutsideRepo(dir, label) {
  const abs = nodePath.resolve(dir);
  if (abs === REPO_ROOT || abs.startsWith(REPO_ROOT + nodePath.sep)) usageDie(`${label}는 리포 안에 둘 수 없다: ${abs}`);
  return abs;
}

function seedDataDir(root, label) {
  const dataDir = nodePath.join(root, label, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(nodePath.join(dataDir, 'news.db'));
  createSchema(db);
  seedUsers(db);
  db.close();
  fs.mkdirSync(nodePath.join(dataDir, 'uploads'));
  const fixture = nodePath.join(dataDir, 'uploads', UPLOAD_FIXTURE_NAME);
  fs.writeFileSync(fixture, PNG);
  // mtime 을 고정한다 — 두 DATA_DIR 에 1초 차이로 놓이면 Last-Modified 가 갈려 허용 diff 수가 실행마다 흔들린다
  // (2026-09-07 1회차 실측: 516 대 517). 자기 결정성은 연속 2회 같은 요약 줄로 판정하므로 흔들림은 결함이다.
  fs.utimesSync(fixture, UPLOAD_FIXTURE_MTIME, UPLOAD_FIXTURE_MTIME);
  return dataDir;
}

// 진단 로그의 경로 가리기 — 리포트가 아니라 기동 로그지만 임시 루트·리포 루트 절대경로를 그대로 남기지 않는다.
function scrubPaths(text, replacements) {
  let out = String(text ?? '');
  for (const [needle, mask] of replacements) {
    for (const variant of new Set([needle, needle.replace(/\\/g, '/'), needle.replace(/\//g, '\\')])) {
      if (variant) out = out.split(variant).join(mask);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  process.stdout.write('spa-parity 시작\n');
  runSelfTest();

  const jar = resolveJar(opts.jar);
  const javaBin = resolveJavaBin(opts.javaHome);
  const spaDir = resolveSpaDir(opts.spaDir);
  const indexBytes = fs.readFileSync(nodePath.join(spaDir, 'index.html'));
  const indexSha256 = sha256Hex(indexBytes);
  const table = resolveRequestTable(REQUESTS, extractAssetPaths(indexBytes.toString('utf8')));
  for (const asset of ['script', 'style']) {
    const entry = table.find((e) => e.name === `asset-${asset}`);
    if (!fs.existsSync(nodePath.join(spaDir, entry.rawPath))) usageDie(`index.html 이 가리키는 자산이 SPA 루트에 없다: ${entry.rawPath}`);
  }

  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'spa-parity-'));
  const outDir = opts.outDir ? assertOutsideRepo(opts.outDir, '--out-dir') : nodePath.join(root, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const ownsOutDir = !opts.outDir;
  process.stdout.write(`  jar=${nodePath.relative(REPO_ROOT, jar).replace(/\\/g, '/')} spaDir=${nodePath.relative(REPO_ROOT, spaDir).replace(/\\/g, '/') || '.'} index.sha256=${indexSha256.slice(0, 16)} 요청 표=${table.length}건\n  tmp=${root}\n`);

  const repoBefore = repoDataSnapshot();
  const distBefore = distFingerprint(spaDir);
  const failures = [];
  const children = [];
  const targets = [
    { label: 'node', argv: [NODE_SERVER], bin: process.execPath },
    { label: 'spring', argv: ['-jar', jar], bin: javaBin },
  ];
  const reports = {};
  const bootLogs = {};
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) return;
    interrupted = true;
    for (const child of children) { try { child.kill('SIGKILL'); } catch { /* 이미 죽음 */ } }
    process.exit(130);
  });

  try {
    // 1. 시드 + 포트 + 기동 (두 서버를 나란히 — 각각 다른 DATA_DIR · cwd 도 임시 루트)
    const taken = new Set();
    for (const target of targets) {
      target.dataDir = seedDataDir(root, target.label);
      target.port = await pickFreePort(taken);
      target.baseUrl = `http://${CONNECT_HOST}:${target.port}`;
      target.child = spawn(target.bin, target.argv, {
        cwd: nodePath.join(root, target.label), env: serverEnv(target.dataDir, target.port, spaDir), stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(target.child);
      target.buf = collectOutput(target.child);
      process.stdout.write(`  [${target.label}] 기동 pid=${target.child.pid ?? '-'} port=${target.port}\n`);
    }
    // 2. health + SPA 활성 확인 — 한쪽만 켜진 상태로 diffs 0 이 나오면 그건 대조가 아니다(변이 N6).
    for (const target of targets) {
      const bootStart = Date.now();
      if (!await waitHealthy(target.baseUrl, opts.timeout, target.child)) {
        failures.push(`[${target.label}] 기동/health 실패(${Date.now() - bootStart}ms exit=${target.child.exitCode} signal=${target.child.signalCode}) — 기동 로그 참조`);
        // IDE(java language server)가 target/classes 에 남긴 JDT 산출물이 jar 에 섞이면 main 이 이 문구로 즉사한다
        // (2026-09-07 실측: clean 없는 package 는 매번, clean package 도 1회에 1번꼴). 회귀가 아니라 무효 jar 다.
        if (`${target.buf.out}${target.buf.err}`.includes('Unresolved compilation problem')) {
          failures.push(`[${target.label}] jar 에 IDE 가 컴파일한 클래스가 섞여 있다(Unresolved compilation problem) — 회귀가 아니다. ${BUILD_HINT.replace('-q package', '-q clean package')} 로 다시 굽고 재실행하라.`);
        }
        continue;
      }
      const probe = await rawRequest(target.port, { name: 'spa-active-probe', method: 'GET', rawPath: '/', headers: {} });
      const active = probe.status === 200 && sha256Hex(probe.body) === indexSha256;
      process.stdout.write(`  [${target.label}] health ok ${Date.now() - bootStart}ms · SPA ${active ? '활성(GET / = index.html)' : `비활성(GET / = ${probe.status})`}\n`);
      if (!active) failures.push(`[${target.label}] SPA 가 켜져 있지 않다(GET / 가 200 index.html 이 아니다) — SPA_DIR 주입을 확인하라. 한쪽만 켜진 대조는 대조가 아니다.`);
    }
    // 3. 요청 표 → 리포트 2벌
    if (failures.length === 0) {
      for (const target of targets) {
        const observations = [];
        for (const entry of table) {
          const response = await rawRequest(target.port, entry);
          observations.push(observe(entry, response, { indexSha256 }));
        }
        reports[target.label] = { target: target.label, spaIndexSha256: indexSha256, requestCount: table.length, observations };
        const file = nodePath.join(outDir, `${target.label}.json`);
        fs.writeFileSync(file, `${JSON.stringify(reports[target.label], null, 2)}\n`);
        process.stdout.write(`  [${target.label}] 관측 ${observations.length}건 → ${nodePath.basename(file)}\n`);
      }
    }
  } catch (err) {
    failures.push(`실행 예외: ${err && err.stack ? err.stack : err}`);
  } finally {
    // 4. 자식 종료 — 실패해도 반드시 시도한다(잔존 = 다음 실행의 포트·파일 잠금 오염).
    for (const target of targets) {
      if (!target.child) continue;
      const killed = await killChild(target.child);
      if (!killed) failures.push(`[${target.label}] 프로세스 종료 실패(SIGKILL 후에도 잔존) pid=${target.child.pid}`);
      bootLogs[target.label] = scrubPaths(`${target.buf.out}\n--- stderr ---\n${target.buf.err}`, [[root, '<tmp>'], [REPO_ROOT, '<repo>']]);
      fs.writeFileSync(nodePath.join(outDir, `${target.label}-boot.log`), bootLogs[target.label]);
    }
  }

  // 5. 비교 — 규칙은 순수 판정부가 소유한다.
  let result = null;
  if (reports.node && reports.spring) {
    result = compareReports(reports.node, reports.spring);
    fs.writeFileSync(nodePath.join(outDir, 'diff.json'), `${JSON.stringify({ summary: formatSummary(result), failures: result.failures, allowed: result.allowed }, null, 2)}\n`);
    const lines = formatDiffLines(result);
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    if (result.failures.length > 0) failures.push(`실패 diff ${result.failures.length}건 — 위 FAIL 줄 참조(리포트: ${nodePath.join(outDir, 'diff.json')})`);
    if (result.observationCount !== table.length) failures.push(`관측 수 ${result.observationCount} ≠ 요청 표 ${table.length}`);
  }

  // 6. 데이터 안전 — 리포 news.db·uploads/·web/dist 가 변했으면 실패다.
  const repoAfter = repoDataSnapshot();
  if (JSON.stringify(repoBefore) !== JSON.stringify(repoAfter)) failures.push(`리포 news.db/uploads 변동: before=${JSON.stringify(repoBefore)} after=${JSON.stringify(repoAfter)}`);
  if (distFingerprint(spaDir) !== distBefore) failures.push('SPA 루트(web/dist)가 실행 중에 변했다 — 두 서버의 공유 입력이 바뀌면 대조가 무의미하다');
  for (const target of targets) {
    if (target.child && !childDead(target.child)) failures.push(`[${target.label}] 자식 프로세스가 아직 살아 있다 pid=${target.child.pid}`);
  }

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
  process.stdout.write(`${result ? formatSummary(result) : 'spa-parity 비교 불가(리포트 부족)'} → ${ok ? 'ok' : 'FAILED'}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`spa-parity 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
