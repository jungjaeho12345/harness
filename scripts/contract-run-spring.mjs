// Spring 계약 하네스 (phase 68 step5) — auth/session 부분집합을 Node·Spring 두 대상에 이중 실행해
// (a) Spring subset green · (b) Node subset green · (c) compareReports(node, spring) diff 0 을 게이트한다.
//
// CRITICAL(이중 실행 소유 — phase 68 설계 결함 회피): contract-run.mjs 의 --base-url-map(외부 대상) 경로는
//   서버를 기동·시드하지 않아, 상시 Spring 서버에 겨누면 /api/login IP 레이트리밋 카운터가 프로파일 간
//   누적되어 auth-negative 가 구조적으로 red 가 된다. 그래서 이 하네스가 이중 실행을 직접 소유한다 —
//   대상(node·spring) × 프로파일(3종) 각각 **새 프로세스 + 새 임시 시드 DB + 빈 포트**로 기동·실행·종료한다.
//
// CRITICAL(계약 무수정): contract/lib/**·contract/cases/**·docs/api-contract/**·contract-run.mjs·
//   contract-diff.mjs 를 수정하지 않는다(재사용은 import). 서버가 계약에 맞춘다.
//
// CRITICAL(데이터 안전): 리포 news.db·uploads/ 에 절대 바인딩하지 않는다 — 프로파일마다 임시 DATA_DIR 를
//   새로 만들고 종료 후 before/after 스냅샷으로 무변을 단언한다(contract-run.mjs 동형).
//
// 사용: node scripts/contract-run-spring.mjs [--keep] [--timeout <ms>]

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSchema } from '../src/db/schema.js';
import { seedUsers, SAMPLE_USERS } from '../src/db/seed.js';
import { compareReports, formatDiffLines } from './contract-diff.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const NODE_SERVER_ENTRY = nodePath.join(REPO_ROOT, 'server', 'index.js');
const SPRING_DIR = nodePath.join(REPO_ROOT, 'server-spring');
const SPRING_JAR = nodePath.join(SPRING_DIR, 'target', 'server-spring-0.0.1-SNAPSHOT.jar');
const INVENTORY_FILE = nodePath.join(REPO_ROOT, 'docs', 'api-contract', 'endpoints.json');
const CASES_ROOT = nodePath.join(REPO_ROOT, 'contract', 'cases');
const ROLES = ['R', 'D', 'Z'];

// 포트 범위 — contract-run.mjs 와 동일 구간 [45000,49152)(verify 스크립트 구간과 서로소).
const PORT_BASE = 45000;
const PORT_SPAN = 4152;

// auth/session 부분집합 — 프로파일별 케이스 파일을 이 하네스가 명시 소유한다(한 실행에 프로파일을 섞지 않는다:
// requireProfile 이 불일치를 즉시 실패시킨다). files 는 정렬해 실행한다(auth 가 users 보다 먼저 = 공용 R 세션 복구 선행).
const PROFILES = [
  { name: 'default', files: ['auth', 'health', 'session-guard', 'users'], sessions: true, prodCookie: false, nodeExtraEnv: {} },
  { name: 'auth-negative', files: ['login-negative'], sessions: false, prodCookie: false, nodeExtraEnv: {} },
  { name: 'prod-cookie', files: ['cookie-prod'], sessions: false, prodCookie: true, nodeExtraEnv: { NODE_ENV: 'production', FORCE_HTTPS: 'false' } },
];
const TARGETS = ['node', 'spring'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { keep: false, timeout: 60000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') { opts.timeout = Number(argv[i + 1]); i += 1; }
    else die(`알 수 없는 인자: ${a}`);
  }
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) die(`--timeout 값이 유효하지 않다(ms, 1000 이상): ${opts.timeout}`);
  return opts;
}

// 자식 env 정리 — 외부 API 키·.env·프로파일 관련 env 삭제(결정성 — contract-run.mjs cleanEnv 동형).
function cleanEnv() {
  const env = { ...process.env };
  for (const k of [
    'NODE_ENV', 'FORCE_HTTPS', 'ALLOWED_ORIGINS', 'COLLECTION_TOKEN', 'RCV_SPOOL_DIR', 'DIST_SPOOL_DIR',
    'DATA_DIR', 'SPA_DIR', 'PORT', 'HOST', 'NODE_OPTIONS',
    'GOOGLE_API_KEY', 'GOOGLE_CSE_ID', 'YOUTUBE_API_KEY', 'GOOGLE_TRANSLATE_API_KEY',
    'CONTRACT_BASE_URL', 'CONTRACT_PROFILE', 'CONTRACT_CREDENTIALS', 'CONTRACT_SESSIONS', 'CONTRACT_REPORT_DIR',
    'CONTRACT_COLLECTION_TOKEN',
  ]) delete env[k];
  return env;
}

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

async function pickFreePort(host) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = PORT_BASE + Math.floor(Math.random() * PORT_SPAN);
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(candidate, host, () => srv.close(() => resolve(true)));
    });
    if (free) return candidate;
  }
  throw new Error(`빈 포트를 찾지 못했다(host=${host}) — 환경 이상`);
}

async function healthOk(baseUrl, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && childDead(child)) return false;
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 && (await res.json()).ok === true) return true;
    } catch { /* 기동 전 — 재시도 */ }
    await sleep(100);
  }
  return false;
}

function collectOutput(child) {
  const buf = { out: '', err: '' };
  child.stdout.on('data', (c) => { buf.out += c; });
  child.stderr.on('data', (c) => { buf.err += c; });
  return buf;
}

// 자격증명 — SAMPLE_USERS(시드와 같은 출처). 값은 로그·요약에 남기지 않는다.
function resolveCredentials() {
  const byRole = {};
  for (const u of SAMPLE_USERS) byRole[u.role] = { userId: u.userId, password: u.password };
  for (const role of ROLES) if (!byRole[role]) die(`SAMPLE_USERS에 ${role} 역할 계정이 없다`);
  return byRole;
}

async function prepareSessions(baseUrl, credentials) {
  const sessions = {};
  for (const role of ROLES) {
    const cred = credentials[role];
    let res; let body;
    try {
      res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: cred.userId, password: cred.password }),
        signal: AbortSignal.timeout(5000),
      });
      body = await res.json();
    } catch (e) {
      return { ok: false, detail: `login 요청 실패 role=${role}: ${e?.message ?? e}` };
    }
    if (res.status !== 200 || body?.ok !== true || typeof body.sessionId !== 'string' || !body.user) {
      return { ok: false, detail: `login 거부 role=${role} status=${res.status} reason=${body?.reason ?? '-'}` };
    }
    const u = body.user;
    sessions[role] = {
      sid: body.sessionId, userId: u.userId, name: u.name, role: u.role,
      department: u.department, departmentCode: u.departmentCode,
    };
  }
  return { ok: true, sessions };
}

function readObservations(reportDir) {
  const observations = [];
  if (!fs.existsSync(reportDir)) return observations;
  for (const f of fs.readdirSync(reportDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    const text = fs.readFileSync(nodePath.join(reportDir, f), 'utf8');
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      observations.push(JSON.parse(line));
    }
  }
  return observations;
}

// content-type 대칭 정규화 (옵션 B, 2026-08-19 확정) — HTTP 상 무의미한 바이트만 흡수한다:
//   (a) ';' 주변 OWS 공백, (b) 파라미터명·charset 토큰 대소문자(RFC 7231 case-insensitive).
// 미디어 타입과 charset 값 비교는 유지한다(application/json vs text/plain·charset 유무/불일치는 여전히 잡힌다).
// 배경(forward_notes): record.js 는 Set-Cookie 는 정규화(Expires 제거)하면서 content-type 는 원문 비교한다 —
//   그 정규화 비대칭 때문에 서블릿 컨테이너(Express 와 다른 '; ' 표기)가 diff 를 낸다. cases/lib/record.js·
//   contract-diff.mjs 는 무수정이고, 이 흡수는 Node·Spring 리포트 양쪽에 똑같이 적용한다(대칭).
function canonicalizeContentType(value) {
  if (typeof value !== 'string') return value;
  const parts = value.split(';').map((s) => s.trim()).filter((s, i) => i === 0 || s !== '');
  const mediaType = parts[0]; // 미디어 타입은 그대로(비교 유지) — 트림만.
  const params = parts.slice(1).map((p) => {
    const eq = p.indexOf('=');
    if (eq === -1) return p.toLowerCase();
    const name = p.slice(0, eq).trim().toLowerCase(); // (b) 파라미터명 소문자
    let val = p.slice(eq + 1).trim();
    if (name === 'charset') val = val.toLowerCase(); // (b) charset 토큰 소문자(값 비교는 유지 — utf-8≠euc-kr은 여전히 잡힘)
    return `${name}=${val}`;
  });
  return [mediaType, ...params].join(';'); // (a) '; ' → ';'
}

// 양쪽 리포트에 대칭 적용 — compareReports 직전.
function normalizeContentTypeSymmetric(report) {
  for (const o of report.observations ?? []) {
    if (o.headers && typeof o.headers['content-type'] === 'string') {
      o.headers['content-type'] = canonicalizeContentType(o.headers['content-type']);
    }
  }
  return report;
}

const OBS_SORT_KEYS = ['profile', 'routeId', 'tag', 'caseId'];
function sortObs(a, b) {
  for (const k of OBS_SORT_KEYS) {
    const x = String(a?.[k] ?? '');
    const y = String(b?.[k] ?? '');
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
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

// Spring jar 확보 — 없으면 mvnw 로 빌드(skipTests). 빌드 실패는 즉시 실패.
async function ensureSpringJar() {
  if (fs.existsSync(SPRING_JAR)) return;
  process.stdout.write('[build] Spring jar 없음 → ./mvnw -q -DskipTests package\n');
  const mvnw = nodePath.join(SPRING_DIR, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
  const child = spawn(mvnw, ['-q', '-DskipTests', 'package'], { cwd: SPRING_DIR, stdio: 'inherit' });
  const code = await new Promise((r) => child.once('close', r));
  if (code !== 0 || !fs.existsSync(SPRING_JAR)) die(`Spring jar 빌드 실패(exit=${code}) — cd server-spring && ./mvnw -DskipTests package 를 먼저 확인하라.`);
}

// 서버 spawn — target 별로 기동 커맨드만 다르다(나머지 격리 규율은 동일).
function spawnServer(target, { dbFile, port, prodCookie, nodeExtraEnv }) {
  if (target === 'node') {
    const env = cleanEnv();
    env.DATA_DIR = nodePath.dirname(dbFile);
    env.PORT = String(port);
    env.HOST = '127.0.0.1';
    env.SPA_DIR = '';
    Object.assign(env, nodeExtraEnv);
    return spawn(process.execPath, [NODE_SERVER_ENTRY], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  // spring
  return spawn('java', [
    '-jar', SPRING_JAR,
    `--app.db-path=${dbFile}`,
    `--server.port=${port}`,
    '--server.address=127.0.0.1',
    `--app.prod-cookie=${prodCookie}`,
  ], { cwd: REPO_ROOT, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
}

// (target, profile) 1건 실행 — { boot, casesFailed, observations, diagnostics }.
async function runOne(target, profile, opts, ctx) {
  const root = ctx.mkTmp(`spring-${target}-${profile.name}-`);
  const dataDir = nodePath.join(root, 'data');
  fs.mkdirSync(dataDir);
  const dbFile = nodePath.join(dataDir, 'news.db');
  const db = new DatabaseSync(dbFile);
  createSchema(db); seedUsers(db); db.close();

  const reportDir = nodePath.join(root, 'report');
  fs.mkdirSync(reportDir);
  const diagnostics = [];
  let serverChild = null;
  let serverBuf = { out: '', err: '' };
  let credentialsFile = null;
  let sessionsFile = null;

  try {
    const host = '127.0.0.1';
    const port = await pickFreePort(host);
    serverChild = spawnServer(target, { dbFile, port, prodCookie: profile.prodCookie, nodeExtraEnv: profile.nodeExtraEnv });
    serverBuf = collectOutput(serverChild);
    const baseUrl = `http://127.0.0.1:${port}`;

    if (!await healthOk(baseUrl, opts.timeout, serverChild)) {
      diagnostics.push(`[${target}/${profile.name}] health 실패: ${baseUrl}/api/health`);
      return { boot: 'failed', casesFailed: false, observations: [], diagnostics };
    }

    credentialsFile = nodePath.join(root, 'credentials.json');
    fs.writeFileSync(credentialsFile, `${JSON.stringify(ctx.credentials, null, 2)}\n`, { mode: 0o600 });

    if (profile.sessions) {
      const prep = await prepareSessions(baseUrl, ctx.credentials);
      if (!prep.ok) {
        diagnostics.push(`[${target}/${profile.name}] 세션 준비 실패: ${prep.detail}`);
        return { boot: 'failed', casesFailed: false, observations: [], diagnostics };
      }
      sessionsFile = nodePath.join(root, 'sessions.json');
      fs.writeFileSync(sessionsFile, `${JSON.stringify(prep.sessions, null, 2)}\n`, { mode: 0o600 });
    }

    const files = profile.files
      .map((f) => nodePath.join(CASES_ROOT, profile.name, `${f}.contract.js`))
      .sort();
    for (const f of files) if (!fs.existsSync(f)) die(`케이스 파일 없음: ${f}`);

    const caseEnv = cleanEnv();
    caseEnv.CONTRACT_BASE_URL = baseUrl;
    caseEnv.CONTRACT_PROFILE = profile.name;
    caseEnv.CONTRACT_CREDENTIALS = credentialsFile;
    caseEnv.CONTRACT_REPORT_DIR = reportDir;
    if (sessionsFile) caseEnv.CONTRACT_SESSIONS = sessionsFile;

    const testChild = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
      cwd: REPO_ROOT, env: caseEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const testBuf = collectOutput(testChild);
    await new Promise((resolve) => testChild.once('close', resolve));
    if (testChild.exitCode !== 0) {
      process.stdout.write(testBuf.out);
      if (testBuf.err.trim()) process.stderr.write(testBuf.err);
      diagnostics.push(`[${target}/${profile.name}] 케이스 실패(exit=${testChild.exitCode})`);
      return { boot: 'ok', casesFailed: true, observations: readObservations(reportDir), diagnostics };
    }
    return { boot: 'ok', casesFailed: false, observations: readObservations(reportDir), diagnostics };
  } catch (err) {
    diagnostics.push(`[${target}/${profile.name}] 예외: ${err?.stack ?? err}`);
    return { boot: 'failed', casesFailed: false, observations: [], diagnostics };
  } finally {
    if (serverChild) {
      const killed = await killChild(serverChild);
      if (!killed) diagnostics.push(`[${target}/${profile.name}] 서버 종료 실패(SIGKILL 후 잔존)`);
    }
    if (diagnostics.length > 0 && serverChild) {
      diagnostics.push(`--- ${target} stdout ---\n${serverBuf.out}`);
      diagnostics.push(`--- ${target} stderr ---\n${serverBuf.err}`);
    }
    for (const secretFile of [credentialsFile, sessionsFile]) {
      if (!secretFile) continue;
      try { fs.rmSync(secretFile, { force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 남으면 임시 디렉토리째 정리된다 */ }
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await ensureSpringJar();

  const inventory = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
  const routeCount = Array.isArray(inventory?.routes) ? inventory.routes.length : 0;
  const credentials = resolveCredentials();

  const tmpDirs = [];
  const ctx = {
    credentials,
    mkTmp(prefix) { const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; },
  };
  const cleanupTmp = () => {
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 무해 */ } }
  };
  process.on('SIGINT', () => { cleanupTmp(); process.exit(130); });

  const repoBefore = repoDataSnapshot();
  const failures = [];
  const byTarget = { node: [], spring: [] };

  for (const target of TARGETS) {
    for (const profile of PROFILES) {
      process.stdout.write(`[${target}/${profile.name}] 시작\n`);
      const r = await runOne(target, profile, opts, ctx);
      byTarget[target].push(...r.observations);
      if (r.boot === 'failed') failures.push(`부팅 실패:\n${r.diagnostics.join('\n')}`);
      else if (r.casesFailed) failures.push(`케이스 실패:\n${r.diagnostics.join('\n')}`);
      else process.stdout.write(`[${target}/${profile.name}] green (관측 ${r.observations.length})\n`);
    }
  }

  // 리포트 2개(스키마 B) — meta.target 만 다르고 관측은 같아야 한다.
  const mkReport = (target) => ({
    version: 1,
    meta: { target, profiles: PROFILES.map((p) => p.name), routeCount },
    observations: byTarget[target].slice().sort(sortObs),
    skipped: [],
  });
  const nodeReport = normalizeContentTypeSymmetric(mkReport('node'));
  const springReport = normalizeContentTypeSymmetric(mkReport('spring'));
  const diff = compareReports(nodeReport, springReport);
  const diffLines = formatDiffLines(diff);
  if (diffLines.length > 0) process.stdout.write(`${diffLines.join('\n')}\n`);
  if (diff.diffCount > 0) failures.push(`Node/Spring diff ${diff.diffCount}건 — 위 차이의 [type] key A/B 를 보고 서버를 계약에 맞춰라(케이스 수정 금지).`);

  const repoAfter = repoDataSnapshot();
  if (JSON.stringify(repoBefore) !== JSON.stringify(repoAfter)) {
    failures.push(`리포 news.db/uploads 변동: before=${JSON.stringify(repoBefore)} after=${JSON.stringify(repoAfter)}`);
  }

  const ok = failures.length === 0;
  if (ok && !opts.keep) cleanupTmp();
  else if (tmpDirs.length > 0) process.stdout.write(`임시 디렉토리 보존(${ok ? '--keep' : '실패 진단용'}):\n${tmpDirs.map((d) => `  ${d}`).join('\n')}\n`);

  process.stdout.write(
    `contract-run-spring ${ok ? 'ok' : 'FAILED'} `
    + `node_obs=${byTarget.node.length} spring_obs=${springReport.observations.length} diffs=${diff.diffCount}\n`,
  );
  if (!ok) {
    process.stderr.write(`${failures.map((f) => `FAIL ${f}`).join('\n')}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`contract-run-spring 실패: ${err?.stack ?? err}\n`);
  process.exit(1);
});
