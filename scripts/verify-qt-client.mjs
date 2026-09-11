// Qt 네이티브 클라 자동 검증 드라이버 v1 — 부팅 축 (phase 77 step6 · ADR-018 (2)).
// 사용: node scripts/verify-qt-client.mjs [--scenario boot|all] [--server exe|spring] [--client-exe <path>]
//        [--qt-bin <dir>] [--server-exe <path>] [--jar <path>] [--java-home <path>] [--keep] [--timeout <ms>]
//
// 판정은 두 축의 교차다(네이티브 클라에는 CDP 가 없다):
//   (1) 클라가 남긴 diag JSONL — 앱이 무엇을 했다고 신고했는가.
//   (2) 드라이버가 직접 만들고 확인하는 사실 — /api/health {ok:true} · 드라이버가 주입한 서버 origin 이 app-window 로
//       되돌아왔는가(앱이 우리 config 를 읽었다) · 앱이 임시 CLIENT_USER_DATA 폴더를 만들었고 config 를 쓰지 않았는가 ·
//       자식 종료 코드 · 리포/실사용자/배포 데이터 전후 스냅샷 무변.
//   diag 만으로는 green 을 내지 않는다(앱이 거짓말하면 green 이 되는 길). 판정 로직은 scripts/lib/qtClientDiag.mjs 에 있고
//   이 파일은 기동·대기·교차·집계만 한다. step10·11 이 login/list 시나리오를 여기에 덧붙인다.
// 시나리오 boot = verify-client.mjs 시나리오 A/B 이식(그 파일은 import 금지 · 무수정 — Electron 경로는 P8까지 회귀 기준):
//   A 설정 있음 → app-ready → config-loaded{true} → app-window{origin} + 두 번째 인스턴스 즉시 exit 0 · 첫 diag 에 second-instance
//   B 설정 없음 → app-ready → config-loaded{false} → local-window{setup} · setup-shown{no-config}(둘의 순서는 보지 않는다)
//   두 경로 모두 부팅만으로 probe 가 없다.
// 절차: 판정부 자기검사 → 계약 라우트 목록(docs/api-contract/endpoints.json) → 자산 해석(없으면 exit 1 + 빌드 힌트 · skip 금지)
//   → 데이터 안전 사전 스냅샷 → 리포 밖 임시 루트(DATA_DIR 시드 · 스풀 · CLIENT_USER_DATA · diag) → 서버 기동 + health
//   → Qt exe 직접 spawn(run.bat 경유 금지 — 배치를 거치면 종료 제어와 종료 코드가 흐려진다) → 시나리오 → 자식 강제 종료
//   → 사후 스냅샷 비교 → 임시 루트 삭제(--keep 이면 보존) → check() 집계 · exit 0/1. **어떤 실패도 경고로 낮추지 않는다.**
// CRITICAL(데이터 안전): 리포 news.db·uploads/·실사용자 %APPDATA%\기사작성기·기사작성기-qt·dist/*/data 에 바인딩하지 않는다.
//   리포 news.db 는 지문(크기·mtime·md5) 목적으로 바이트만 읽는다 — DB 로 열지 않는다.
// CRITICAL(자식 env): 서버·클라 모두 허용목록 조립(부모 env 통째 상속 금지). Qt 자식 PATH 규칙의 이유는 scripts/lib/qtClientEnv.mjs.
// 주의: scripts/** 는 eslint ignore 대상이다 — 인자 가드와 판정부 자기검사가 정적 안전망이다. import 금지(CLI 즉시 실행).

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
import { listFilesRecursive, osEnvAllowlist, parseServerMode, springServerEnv } from './lib/integrationMode.mjs';
import {
  CLIENT_FORBIDDEN_ROUTE_IDS, bootSequences, diffSnapshots, findSequence, judgeBoot, loadContractRouteIds, parseDiagLines,
} from './lib/qtClientDiag.mjs';
import { qtClientEnv } from './lib/qtClientEnv.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const LIB_DIR = nodePath.join(REPO_ROOT, 'scripts', 'lib');
const ENDPOINTS_JSON = nodePath.join(REPO_ROOT, 'docs', 'api-contract', 'endpoints.json');
const WEB_DIST = nodePath.join(REPO_ROOT, 'web', 'dist');
const DEFAULT_CLIENT_EXE = nodePath.join(REPO_ROOT, 'client-qt', 'release', 'news-client.exe');
const DEFAULT_QT_BIN = 'D:/agents/tools/Qt/6.8.3/msvc2022_64/bin'; // client-qt/env.bat 의 QTDIR\bin 과 같은 값
const DEFAULT_JAVA_HOME = 'D:/agents/tools/jdk-25.0.4.1+1';
const DEFAULT_SPRING_JAR = nodePath.join(REPO_ROOT, 'server-spring', 'target', 'server-spring-0.0.1-SNAPSHOT.jar');
// 서버 SEA exe 후보(verify-integration.mjs 759행과 같은 순서 — 한글 경로는 AC 커맨드를 ASCII 로 두려고 여기서만 다룬다).
const SERVER_EXE_CANDIDATES = ['dist/기사작성기-server/기사작성기-server.exe', 'dist/기사작성기-server/article-server.exe'];
const CLIENT_BUILD_HINT = 'cmd.exe /c client-qt\\build.bat';
const SERVER_EXE_BUILD_HINT = 'npm run dist:server';
const SPRING_BUILD_HINT = `cd server-spring && JAVA_HOME="${DEFAULT_JAVA_HOME}" ./mvnw -B -q package -DskipTests`;
const CONNECT_HOST = '127.0.0.1';
// 서버 포트 [45000, 49000) — verify-integration(20000~34999 · CDP 35000~44999)·spa-parity(15000~19999)와 겹치지 않고
// Windows 동적 포트 기본 범위(49152~) 아래다. 후보는 실제 listen 으로 확인한다(추측 금지).
const PORT_BASE = 45000;
const PORT_SPAN = 4000;
const HEALTH_TIMEOUT_MS = 60000; // JVM 냉기동 포함
const SECOND_INSTANCE_TIMEOUT_MS = 15000;
const SETTLE_MS = 1000; // 시퀀스 관측 뒤 늦게 오는 이벤트(부팅 뒤 비동기 probe 등)를 판정에 넣기 위한 대기
// 실사용자 폴더 — Electron 셸(client/package.json productName)과 Qt 클라(client-qt/src/shell/appidentity.h).
const APPDATA_FOLDERS = ['기사작성기', '기사작성기-qt'];

const USAGE = `사용법: node scripts/verify-qt-client.mjs [--scenario boot|all] [--server exe|spring] [--client-exe <path>]
       [--qt-bin <dir>] [--server-exe <path>] [--jar <path>] [--java-home <path>] [--keep] [--timeout <ms>]
  --scenario      boot | all(기본 — 현재 boot 만). boot = 설정 있음(A, + 두 번째 인스턴스) · 설정 없음(B).
  --server        exe(기본) | spring. exe = 서버 SEA exe(dist/), spring = java -jar server-spring/target/*.jar.
  --client-exe    Qt 클라 exe(기본 client-qt/release/news-client.exe). .exe 만 받는다(run.bat 경유 금지).
  --qt-bin <dir>  Qt bin 디렉토리 — 자식 PATH 맨 앞에 싣는다(기본: env QT_BIN_DIR → ${DEFAULT_QT_BIN}).
  --server-exe    서버 SEA exe 경로(기본: dist/기사작성기-server/ 자동 해석). --server exe 전용.
  --jar <path>    Spring 실행 jar(기본 server-spring/target/server-spring-0.0.1-SNAPSHOT.jar · 자동 빌드 안 함). --server spring 전용.
  --java-home     JDK 홈(기본 ${DEFAULT_JAVA_HOME}). --server spring 전용.
  --keep          임시 루트를 지우지 않고 경로를 출력한다(디버깅용).
  --timeout <ms>  diag 시퀀스 대기 한도(기본 30000, 1000 이상 정수). 서버 health 대기는 별도 ${HEALTH_TIMEOUT_MS}ms.`;

const out = (line) => process.stdout.write(`${line}\n`);

function die(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const take = (i, flag) => {
    const v = flagValue(argv, i, flag);
    if (!v.ok) die(v.message);
    return v.value;
  };
  const opts = { scenario: 'all', server: 'exe', keep: false, timeout: 30000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--scenario') { opts.scenario = take(i, '--scenario'); i += 1; }
    else if (a === '--server') { opts.server = take(i, '--server'); i += 1; }
    else if (a === '--client-exe') { opts.clientExe = take(i, '--client-exe'); i += 1; }
    else if (a === '--qt-bin') { opts.qtBin = take(i, '--qt-bin'); i += 1; }
    else if (a === '--server-exe') { opts.serverExe = take(i, '--server-exe'); i += 1; }
    else if (a === '--jar') { opts.jar = take(i, '--jar'); i += 1; }
    else if (a === '--java-home') { opts.javaHome = take(i, '--java-home'); i += 1; }
    else if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') { opts.timeout = Number(take(i, '--timeout')); i += 1; }
    else die(`알 수 없는 인자: ${a}`);
  }
  if (!['boot', 'all'].includes(opts.scenario)) die(`--scenario 값이 유효하지 않다(boot|all): ${opts.scenario}`);
  const mode = parseServerMode(opts.server);
  if (!mode.ok) die(mode.message);
  // 모드 전용 플래그가 다른 모드에 오면 거부다(값을 줬는데 아무 효과가 없는 실행 금지).
  if (opts.server === 'exe' && (opts.jar !== undefined || opts.javaHome !== undefined)) die('--jar / --java-home 은 --server spring 에서만 유효하다.');
  if (opts.server === 'spring' && opts.serverExe !== undefined) die('--server-exe 는 --server exe 에서만 유효하다.');
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) die(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${opts.timeout}`);
  return opts;
}

// --- 판정부 자기검사 — 판정부가 빨간 채로는 서버도 클라도 띄우지 않는다(spa-parity.mjs 선례) ---
// 0건 통과도 실패로 본다(node --test 는 테스트가 하나도 없는 파일에 exit 0 을 준다).
function runSelfTest(selfTestPath) {
  const rel = nodePath.relative(REPO_ROOT, selfTestPath);
  if (!fs.existsSync(selfTestPath)) die(`판정부 자기검사 파일이 없다: ${rel} — 조용히 건너뛰지 않는다.`);
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', selfTestPath], { cwd: REPO_ROOT, env: osEnvOnly(), encoding: 'utf8' });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const pass = Number(text.match(/^# pass (\d+)$/m)?.[1] ?? 0);
  const fail = Number(text.match(/^# fail (\d+)$/m)?.[1] ?? -1);
  if (r.status !== 0 || fail !== 0 || pass < 1) {
    process.stderr.write(text);
    die(`판정부 자기검사가 실패했다(node --test ${rel} · status=${r.status} pass=${pass} fail=${fail}) — 빨간 판정부로는 검증하지 않는다.`);
  }
  out(`  판정부 자기검사 통과 ${pass}건 (node --test ${rel})`);
}

function osEnvOnly() {
  const env = {};
  for (const key of osEnvAllowlist(process.platform)) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

// --- 자산 해석 — 없으면 exit 1 + 빌드 힌트(skip 금지 · decisions (10)) ---
function resolveServer(opts) {
  if (opts.server === 'exe') {
    let exe;
    if (opts.serverExe !== undefined) {
      exe = nodePath.resolve(opts.serverExe);
      if (!fs.existsSync(exe)) die(`--server-exe 경로가 존재하지 않는다: ${exe}`);
    } else {
      exe = SERVER_EXE_CANDIDATES.map((p) => nodePath.join(REPO_ROOT, p)).find((p) => fs.existsSync(p));
      if (!exe) die(`서버 SEA exe 가 없다(${SERVER_EXE_CANDIDATES.join(' | ')}) — 하네스는 빌드하지 않는다. 먼저 빌드하라:\n  ${SERVER_EXE_BUILD_HINT}`);
    }
    return { mode: 'exe', exe, label: `exe(${nodePath.relative(REPO_ROOT, exe)})` };
  }
  const jar = nodePath.resolve(opts.jar ?? DEFAULT_SPRING_JAR);
  if (!fs.existsSync(jar)) die(`Spring 실행 jar 가 없다: ${jar} — 하네스는 빌드하지 않는다. 먼저 빌드하라:\n  ${SPRING_BUILD_HINT}`);
  const javaHome = nodePath.resolve(opts.javaHome ?? DEFAULT_JAVA_HOME);
  const javaBin = nodePath.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (!fs.existsSync(javaBin)) die(`JDK 홈에 java 실행 파일이 없다: ${javaBin} — --java-home <path> 로 JDK 25 를 지정하라.`);
  // springServerEnv 는 SPA_DIR 이 비면 throw 한다 — Qt 클라는 SPA 를 쓰지 않지만 조립 규칙이 5키 전부를 요구한다.
  if (!fs.existsSync(nodePath.join(WEB_DIST, 'index.html'))) die(`SPA 루트에 index.html 이 없다: ${WEB_DIST} — 'npm run build' 를 먼저 돌려라.`);
  return { mode: 'spring', jar, javaBin, spaDir: WEB_DIST, label: `spring(${nodePath.relative(REPO_ROOT, jar)} · ${javaBin})` };
}

function resolveClient(opts) {
  const exe = nodePath.resolve(opts.clientExe ?? DEFAULT_CLIENT_EXE); // resolve 가 슬래시를 역슬래시로 바꾼다(cmd.exe 는 슬래시 경로로 뜨지 못한다 — step5 실측)
  if (!/\.exe$/i.test(exe)) die(`--client-exe 는 .exe 여야 한다(run.bat 등 배치 경유 금지 — 종료 제어와 종료 코드가 흐려진다): ${exe}`);
  if (!fs.existsSync(exe)) die(`Qt 클라 exe 가 없다: ${exe} — 하네스는 빌드하지 않는다. 먼저 빌드하라:\n  ${CLIENT_BUILD_HINT}`);
  const qtBin = nodePath.resolve(opts.qtBin ?? process.env.QT_BIN_DIR ?? DEFAULT_QT_BIN);
  if (!fs.existsSync(qtBin) || !fs.statSync(qtBin).isDirectory()) {
    die(`Qt bin 디렉토리가 없다: ${qtBin} — --qt-bin <dir> 또는 env QT_BIN_DIR 로 Qt 6.8.3 msvc2022_64\\bin 을 지정하라.`);
  }
  return { exe, qtBin };
}

// --- 자식 프로세스 ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childDead = (child) => child._spawnError !== null || child.exitCode !== null || child.signalCode !== null;

function spawnChild(cmd, args, options) {
  const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  child._out = '';
  child._err = '';
  child._spawnError = null;
  child.stdout.on('data', (c) => { child._out += c; });
  child.stderr.on('data', (c) => { child._err += c; });
  child._done = new Promise((resolve) => {
    child.once('exit', () => resolve());
    // spawn 실패(ENOENT·EINVAL)는 exit 없이 error 만 온다 — 대기가 한도까지 헛돌지 않게 여기서 끝낸다.
    child.once('error', (err) => { child._spawnError = err; resolve(); });
  });
  return child;
}

function waitExit(child, ms) {
  if (childDead(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child._done.then(() => { clearTimeout(timer); resolve(true); });
  });
}

async function killChild(child) {
  if (!child || childDead(child)) return true;
  child.kill();
  if (await waitExit(child, 3000)) return true;
  child.kill('SIGKILL');
  return waitExit(child, 5000);
}

// Windows 는 NTSTATUS 를 부호 없는 32비트 종료 코드로 준다(MSYS 셸은 이것을 127 로 뭉갠다 — Node 는 원값을 준다).
function describeExit(child) {
  if (child._spawnError) return `spawn-error(${child._spawnError.code ?? child._spawnError.message})`;
  const code = child.exitCode;
  if (code === null) return child.signalCode ? `signal(${child.signalCode})` : 'running';
  if (code === 0xC0000135) return `${code}(0xC0000135 STATUS_DLL_NOT_FOUND — Qt bin 이 PATH 에 없다)`;
  if (code > 0x7fffffff) return `${code}(0x${code.toString(16).toUpperCase()})`;
  return String(code);
}

const tail = (text, n = 3000) => (text.length > n ? `…${text.slice(-n)}` : text);

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

async function waitHealthy(origin, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childDead(child)) return { ok: false, reason: `서버 자식이 종료됐다 exit=${describeExit(child)}` };
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 && (await res.json())?.ok === true) return { ok: true };
    } catch { /* 기동 전 — 재시도 */ }
    await sleep(200);
  }
  return { ok: false, reason: `${timeoutMs}ms 안에 /api/health {ok:true} 미응답` };
}

function spawnServer(server, { dataDir, spoolDir, port, cwd }) {
  if (server.mode === 'spring') {
    // 5키 전부 명시 주입(하나라도 비면 throw — 호출부 try 가 명시 실패로 센다) · APP_ENV 는 어떤 경로로도 실리지 않는다.
    const env = springServerEnv({ parentEnv: process.env, platform: process.platform, dataDir, port, host: CONNECT_HOST, spaDir: server.spaDir, spoolDir });
    return spawnChild(server.javaBin, ['-jar', server.jar], { cwd, env });
  }
  // SEA exe 도 허용목록 조립(NODE_ENV=production 이 상속되면 쿠키 Secure 가 켜진다 — verify-integration 주석).
  const env = { ...osEnvOnly(), DATA_DIR: dataDir, PORT: String(port), HOST: CONNECT_HOST, DIST_SPOOL_DIR: spoolDir };
  return spawnChild(server.exe, [], { cwd, env });
}

// --- diag 읽기·대기 ---
function readDiag(diagFile) {
  let text;
  try {
    text = fs.readFileSync(diagFile, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { lines: [], rejected: [] };
    return { lines: [], rejected: [{ lineNo: 0, reason: `read-error:${err && err.code}` }] };
  }
  return parseDiagLines(text);
}

// 시퀀스 전부가 관측될 때까지 폴링한다. 자식이 죽으면 한도를 기다리지 않고 마지막으로 한 번 더 읽고 끝낸다.
async function waitForDiag(diagFile, sequences, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dead = childDead(child);
    const { lines } = readDiag(diagFile);
    const missing = sequences.map((s) => findSequence(lines, s)).find((r) => !r.ok)?.missing;
    if (missing === undefined) return { ok: true, lines };
    if (dead || Date.now() >= deadline) return { ok: false, lines, missing, exitedEarly: dead };
    await sleep(100);
  }
}

const waitDetail = (w, child) => `missing=${w.missing} events=[${w.lines.map((l) => l.event).join(',')}] `
  + (w.exitedEarly ? `클라가 먼저 종료 exit=${describeExit(child)}` : 'timeout');

// --- 데이터 안전 스냅샷 — { 키: 문자열 } 평면 객체(비교는 판정부 diffSnapshots) ---
const SNAPSHOT_GROUPS = [
  { label: '리포 news.db 무변(크기·mtime·md5)', key: 'repo:news.db' },
  { label: '리포 uploads/ 무변(파일 수·총 바이트)', key: 'repo:uploads' },
  ...APPDATA_FOLDERS.map((f) => ({ label: `실사용자 %APPDATA%\\${f} 무변(파일별 크기·mtime)`, key: `appdata:${f}` })),
  { label: 'dist/*/data 무변(파일별 크기·mtime)', key: 'dist:' },
];
const inGroup = (key, group) => (group.key.endsWith(':') ? key.startsWith(group.key) : key === group.key || key.startsWith(`${group.key}/`));

function fileFact(abs) {
  const st = fs.statSync(abs);
  return `size=${st.size} mtimeMs=${st.mtimeMs}`;
}

function addTree(snap, label, root) {
  const files = listFilesRecursive(root);
  if (files === null) { snap[label] = 'absent'; return; }
  snap[label] = `files=${files.length}`;
  for (const rel of files) snap[`${label}/${rel}`] = fileFact(nodePath.join(root, rel));
}

function dataSafetySnapshot() {
  const snap = {};
  const db = nodePath.join(REPO_ROOT, 'news.db');
  snap['repo:news.db'] = fs.existsSync(db)
    ? `${fileFact(db)} md5=${createHash('md5').update(fs.readFileSync(db)).digest('hex')}` // 바이트 지문만 — DB 로 열지 않는다
    : 'absent';
  const uploads = nodePath.join(REPO_ROOT, 'uploads');
  const up = listFilesRecursive(uploads);
  snap['repo:uploads'] = up === null ? 'absent'
    : `files=${up.length} bytes=${up.reduce((sum, rel) => sum + fs.statSync(nodePath.join(uploads, rel)).size, 0)}`;
  for (const folder of APPDATA_FOLDERS) {
    if (process.env.APPDATA) addTree(snap, `appdata:${folder}`, nodePath.join(process.env.APPDATA, folder));
    else snap[`appdata:${folder}`] = 'APPDATA-undefined';
  }
  const distDir = nodePath.join(REPO_ROOT, 'dist');
  if (fs.existsSync(distDir)) {
    for (const name of fs.readdirSync(distDir).sort()) {
      const dataDir = nodePath.join(distDir, name, 'data');
      if (fs.existsSync(dataDir)) addTree(snap, `dist:${name}/data`, dataDir);
    }
  }
  return snap;
}

function groupSummary(snap, group) {
  const keys = Object.keys(snap).filter((k) => inGroup(k, group));
  if (group.key === 'dist:') return `폴더 ${keys.filter((k) => /^dist:[^/]+\/data$/.test(k)).length} · 항목 ${keys.length}`;
  return snap[group.key] ?? '-';
}

// --- 시나리오 boot ---
async function scenarioBootA(ctx) {
  const { tmpRoot, origin, check, opts } = ctx;
  const userData = nodePath.join(tmpRoot, 'ud-a');
  fs.mkdirSync(userData);
  const configFile = nodePath.join(userData, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({ schemaVersion: 1, serverUrl: origin })}\n`);
  const configBytes = fs.readFileSync(configFile);
  const diagFile = nodePath.join(tmpRoot, 'diag-a.jsonl');
  const env = ctx.clientEnv(userData, diagFile);
  const [sequence] = bootSequences('A', { origin });

  const t0 = Date.now();
  const first = ctx.spawnClient(env);
  const booted = await waitForDiag(diagFile, [sequence], opts.timeout, first);
  check('A: 부팅 시퀀스 관측(첫 인스턴스)', booted.ok, booted.ok ? `${Date.now() - t0}ms` : waitDetail(booted, first));

  // 두 번째 인스턴스 — 같은 CLIENT_USER_DATA 면 잠금에 막혀 즉시 exit 0 이고, 첫 인스턴스 diag 에 second-instance 1줄만 는다.
  const t1 = Date.now();
  const second = ctx.spawnClient(env);
  const secondExited = await waitExit(second, SECOND_INSTANCE_TIMEOUT_MS);
  const secondMs = Date.now() - t1;
  check('A: 두 번째 인스턴스 즉시 종료 exit 0', secondExited && second.exitCode === 0, `exit=${describeExit(second)} ${secondMs}ms`);
  await waitForDiag(diagFile, [[...sequence, 'second-instance']], opts.timeout, first); // 판정은 아래 judgeBoot 가 한다
  await sleep(SETTLE_MS);
  check('A: 첫 인스턴스가 판정 시점까지 살아 있다', !childDead(first), childDead(first) ? `exit=${describeExit(first)}` : '');
  await killChild(first);

  const final = readDiag(diagFile);
  for (const c of judgeBoot('A', { ...final, origin, routeIds: ctx.routeIds })) check(c.name, c.ok, c.detail);
  check('A: 주입한 config.json 무변(부팅은 설정을 쓰지 않는다)', fs.existsSync(configFile) && fs.readFileSync(configFile).equals(configBytes));
  return { lines: final.lines, diagFile, children: [first, second] };
}

async function scenarioBootB(ctx) {
  const { tmpRoot, check, opts } = ctx;
  const userData = nodePath.join(tmpRoot, 'ud-b'); // 만들지 않는다 — 앱이 부팅 때 만든다(CLIENT_USER_DATA 적용의 디스크 증거)
  const diagFile = nodePath.join(tmpRoot, 'diag-b.jsonl');
  const env = ctx.clientEnv(userData, diagFile);

  const t0 = Date.now();
  const child = ctx.spawnClient(env);
  const booted = await waitForDiag(diagFile, bootSequences('B'), opts.timeout, child);
  check('B: 부팅 시퀀스 관측', booted.ok, booted.ok ? `${Date.now() - t0}ms` : waitDetail(booted, child));
  await sleep(SETTLE_MS);
  check('B: 인스턴스가 판정 시점까지 살아 있다', !childDead(child), childDead(child) ? `exit=${describeExit(child)}` : '');
  await killChild(child);

  const final = readDiag(diagFile);
  for (const c of judgeBoot('B', { ...final, routeIds: ctx.routeIds })) check(c.name, c.ok, c.detail);
  check('B: 앱이 CLIENT_USER_DATA 폴더를 만들었다(env 적용의 디스크 증거)', fs.existsSync(userData) && fs.statSync(userData).isDirectory());
  check('B: config.json 미생성(부팅은 설정을 쓰지 않는다)', !fs.existsSync(nodePath.join(userData, 'config.json')));
  return { lines: final.lines, diagFile, children: [child] };
}

function dumpScenario(label, result) {
  if (!result) return;
  process.stderr.write(`--- ${label} diag ---\n${result.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  for (const c of result.children) {
    process.stderr.write(`--- ${label} client pid=${c.pid ?? '-'} exit=${describeExit(c)} stdout ---\n${tail(c._out)}\n--- stderr ---\n${tail(c._err)}\n`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  out(`verify-qt-client 시작 server=${opts.server} scenario=${opts.scenario}`);
  runSelfTest(nodePath.join(LIB_DIR, 'qtClientDiag.self-test.mjs'));

  let routeIds;
  try {
    routeIds = loadContractRouteIds(ENDPOINTS_JSON);
  } catch (err) {
    die(`계약 라우트 목록을 읽지 못했다(${ENDPOINTS_JSON}): ${err && err.message}`);
  }
  const unknownForbidden = CLIENT_FORBIDDEN_ROUTE_IDS.filter((id) => !routeIds.includes(id));
  if (unknownForbidden.length > 0) die(`계약에 없는 클라 금지 라우트: ${unknownForbidden.join(', ')} — 금지 판정이 공허해진다.`);
  out(`  계약 라우트 ${routeIds.length} (docs/api-contract/endpoints.json) · 클라 금지 ${CLIENT_FORBIDDEN_ROUTE_IDS.join('·')}`);

  const server = resolveServer(opts);
  const client = resolveClient(opts);
  const tmpBase = nodePath.resolve(os.tmpdir());
  if (tmpBase === REPO_ROOT || tmpBase.startsWith(REPO_ROOT + nodePath.sep)) die(`OS 임시 폴더가 리포 안이다: ${tmpBase} — 임시 산출물을 리포에 둘 수 없다.`);
  out(`  server ${server.label}`);
  out(`  client ${client.exe} · qt-bin ${client.qtBin}`);

  const failures = [];
  let judged = 0;
  const check = (name, ok, detail = '') => {
    judged += 1;
    out(`  ${ok ? 'ok' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
    if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  };

  const before = dataSafetySnapshot();
  const tmpRoot = fs.mkdtempSync(nodePath.join(tmpBase, 'verify-qt-client-'));
  const children = [];
  const observed = {};
  let serverChild = null;

  try {
    const dataDir = nodePath.join(tmpRoot, 'server-data');
    const spoolDir = nodePath.join(tmpRoot, 'dist-spool');
    const serverCwd = nodePath.join(tmpRoot, 'server-cwd');
    const clientCwd = nodePath.join(tmpRoot, 'client-cwd');
    for (const d of [dataDir, spoolDir, serverCwd, clientCwd]) fs.mkdirSync(d);
    {
      // 시드 — 임시 DATA_DIR 에만 존재한다(스키마·시드의 단일 출처 src/db/**).
      const db = new DatabaseSync(nodePath.join(dataDir, 'news.db'));
      createSchema(db);
      const inserted = seedUsers(db);
      db.close();
      check('임시 DATA_DIR 시드(계정 3)', inserted.length === 3, `inserted=${inserted.length}`);
    }

    const port = await pickFreePort();
    const origin = `http://${CONNECT_HOST}:${port}`;
    const bootStart = Date.now();
    serverChild = spawnServer(server, { dataDir, spoolDir, port, cwd: serverCwd });
    children.push(serverChild);
    const health = await waitHealthy(origin, HEALTH_TIMEOUT_MS, serverChild);
    check(`server(${server.mode}) 기동 + /api/health {ok:true}`, health.ok,
      health.ok ? `${Date.now() - bootStart}ms ${origin} pid=${serverChild.pid}` : `기동/health 실패: ${health.reason}`);
    if (!health.ok) {
      process.stderr.write(`--- server stdout ---\n${tail(serverChild._out)}\n--- server stderr ---\n${tail(serverChild._err)}\n`);
      throw Object.assign(new Error('서버 없이 클라 시나리오를 돌리지 않는다'), { counted: true });
    }

    const ctx = {
      tmpRoot, origin, check, opts, routeIds,
      clientEnv: (userDataDir, diagFile) => qtClientEnv({ parentEnv: process.env, platform: process.platform, qtBinDir: client.qtBin, userDataDir, diagFile }),
      spawnClient: (env) => {
        const child = spawnChild(client.exe, [], { cwd: clientCwd, env });
        children.push(child);
        return child;
      },
    };
    for (const [label, run] of [['A', scenarioBootA], ['B', scenarioBootB]]) {
      const failedBefore = failures.length;
      const result = await run(ctx);
      observed[label] = result.lines.length;
      if (failures.length > failedBefore) dumpScenario(label, result);
    }

    // 서버 측 사실 — 클라 시나리오 뒤에도 우리 서버 자식이 살아서 health 를 준다.
    const still = await waitHealthy(origin, 5000, serverChild);
    check('server 가 시나리오 끝까지 살아 있고 /api/health {ok:true}', still.ok, still.ok ? '' : still.reason);
  } catch (err) {
    if (err && err.counted) out(`  중단: ${err.message}`);
    else failures.push(String(err && err.stack ? err.stack : err));
  } finally {
    const stuck = [];
    for (const child of children) if (!(await killChild(child))) stuck.push(child.pid);
    check('자식 프로세스 전부 종료(강제 종료 포함)', stuck.length === 0, `자식 ${children.length}${stuck.length ? ` 남음 pid=${stuck.join(',')}` : ''}`);
  }

  // 데이터 안전 — 하나라도 변하면 실패(비교 판정 · 절대 규칙 아님).
  const after = dataSafetySnapshot();
  const diffs = diffSnapshots(before, after);
  check('실사용자 %APPDATA% 정의됨(무변 판정 가능)', Boolean(process.env.APPDATA));
  for (const group of SNAPSHOT_GROUPS) {
    const mine = diffs.filter((d) => inGroup(d.key, group));
    check(`데이터 안전: ${group.label}`, mine.length === 0, mine.length ? JSON.stringify(mine) : groupSummary(after, group));
  }
  const stray = diffs.filter((d) => !SNAPSHOT_GROUPS.some((g) => inGroup(d.key, g)));
  if (stray.length > 0) check('데이터 안전: 분류 밖 변화', false, JSON.stringify(stray));

  if (opts.keep) {
    out(`  keep 임시 루트 보존: ${tmpRoot}`);
  } else {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      check('임시 루트 삭제', false, `${tmpRoot} (${err && err.code})`);
    }
  }

  const events = Object.values(observed).reduce((a, b) => a + b, 0);
  const perPath = Object.entries(observed).map(([k, v]) => `${k} ${v}`).join(' · ');
  // 0 이면 실패 — 관측 0건·판정 0항목이 green 이 되는 길을 막는다.
  if (events === 0) failures.push('관측 이벤트 0건 — 클라가 아무것도 신고하지 않았다');
  if (judged === 0) failures.push('판정 항목 0 — 드라이버가 아무것도 판정하지 않았다');
  const summary = `server=${opts.server} scenario=${opts.scenario} · 관측 이벤트 ${events} (${perPath || '-'}) · 판정 항목 ${judged} · 실패 ${failures.length} · ${Date.now() - startedAt}ms`;
  if (failures.length === 0) {
    out(`verify-qt-client-ok ${summary}`);
    process.exit(0);
  }
  process.stderr.write([`verify-qt-client-FAILED ${summary}`, ...failures.map((f) => `  - ${f}`)].join('\n') + '\n');
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`verify-qt-client 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
