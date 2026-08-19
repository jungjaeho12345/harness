// 계약 스위트 러너 (phase 67 step1) — 프로파일별 서버 기동/시드/세션·자격증명 준비/케이스 spawn/
// 리포트 병합·커버리지 판정/데이터 안전 단언을 소유한다. Node 서버를 어떻게 띄우는지 아는 코드는
// 이 파일뿐이다(decisions (4)) — 케이스·lib(step2)은 CONTRACT_BASE_URL 하나로만 서버에 접근한다.
// 사용: node scripts/contract-run.mjs [--profile <name>]... [--files <path>[,<path>]...]
//                                     [--out <report.json>] [--base-url-map <file.json>] [--credentials <file.json>]
//                                     [--boot-check] [--require-full-coverage] [--require-spec-paths]
//                                     [--dual-run] [--keep] [--timeout <ms>]
// CRITICAL(데이터 안전, decisions (14)): 리포 news.db·uploads/에 절대 바인딩하지 않는다 — 프로파일마다
//   임시 DATA_DIR를 새로 만들고(ADR-012 데이터 폴더당 인스턴스 1), 종료 후 before/after 스냅샷으로 무변을 단언한다.
// CRITICAL(결정성, decisions (9)): 자식 env는 명시 조립한다 — 외부 API 키 4종 삭제(egress 0),
//   `.env` 미로드(node server/index.js 직접 spawn), SPA_DIR=''(정적 서빙 off), RCV_SPOOL_DIR 미설정.
// CRITICAL(오탐 방지, decisions (25)): 프로파일 기동 실패(health/세션 준비)는 조용한 skip이 아니다 —
//   skipped:{reason:'profile-boot-failed'} 기록 + 자식 stdout/stderr 첨부 + 나머지 프로파일 계속 + 종합 exit 1.
// 자격증명(decisions (22)): 케이스는 비밀번호를 모른다 — 러너가 credentials.json을 만들어
//   CONTRACT_CREDENTIALS로 넘긴다. 외부 대상(--base-url-map)은 --credentials가 필수다(비밀번호 추측 금지).
// 포트(decisions (24)): [45000, 49152) — verify-integration의 서버 [20000,35000)·CDP [35000,45000)와
//   서로소(병행 실행 경합 방지, test/verify-integration-portrange.test.js가 잠근 불변식), 동적 포트(49152~) 아래.
// 로그 규율: 세션 토큰·비밀번호·쿠키 값은 stdout/stderr/리포트 어디에도 남기지 않는다(ADR-004·LOGS.md).
// 주의: scripts/**는 eslint ignore 대상이다 — 인자 가드가 유일한 정적 안전망이다. import 금지(CLI 즉시 실행).

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSchema } from '../src/db/schema.js';
import { seedUsers, SAMPLE_USERS } from '../src/db/seed.js';
import { flagValue } from './lib/cliArgs.mjs';
// --dual-run은 비교 규칙을 자체 구현하지 않고 contract-diff.mjs의 함수를 그대로 쓴다(step12) —
// 규칙이 두 벌로 갈라지면 CLI diff와 러너 내부 판정이 서로 다른 답을 내는 순간 패리티 판정이 무의미해진다.
import { compareReports, formatDiffLines } from './contract-diff.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const SERVER_ENTRY = nodePath.join(REPO_ROOT, 'server', 'index.js');
const INVENTORY_FILE = nodePath.join(REPO_ROOT, 'docs', 'api-contract', 'endpoints.json');
const CASES_ROOT = nodePath.join(REPO_ROOT, 'contract', 'cases');
const ROLES = ['R', 'D', 'Z'];

// 수집 토큰 프로파일용 고정 테스트 토큰 — 비밀이 아니다(임시 서버 전용, 케이스에 CONTRACT_COLLECTION_TOKEN으로 전달).
const COLLECTION_TEST_TOKEN = 'contract-collection-token';

// 서버 포트 범위 [45000, 49152) — 위 CRITICAL(포트) 참조. base/span을 바꾸려면 서로소 불변식을 먼저 확인하라.
const PORT_BASE = 45000;
const PORT_SPAN = 4152;

// 프로파일 5종(decisions (7)(26)) — 이 표가 계약의 일부다. 임의로 늘리지 마라.
//  sessions: 러너가 R/D/Z 3회 로그인해 sessions.json을 만드는가(아니면 케이스가 직접 로그인 —
//            auth-negative는 레이트리밋/잠금 격리, prod-cookie는 프로덕션 쿠키 관측이 목적이라 제외).
//  spool/token: DIST_SPOOL_DIR(임시)·COLLECTION_TOKEN(고정 테스트 토큰) 설정 여부.
const PROFILES = [
  { name: 'default', sessions: true, spool: true, token: true, host: '127.0.0.1', extraEnv: {} },
  { name: 'minimal', sessions: true, spool: false, token: false, host: '127.0.0.1', extraEnv: {} },
  { name: 'auth-negative', sessions: false, spool: true, token: true, host: '127.0.0.1', extraEnv: {} },
  { name: 'failclosed', sessions: true, spool: false, token: false, host: '0.0.0.0', extraEnv: {} },
  // FORCE_HTTPS=false — 프로덕션 쿠키 속성(Secure·SameSite=None)만 관측하고 308 리다이렉트 축은 끈다(excluded (g)).
  { name: 'prod-cookie', sessions: false, spool: false, token: false, host: '127.0.0.1', extraEnv: { NODE_ENV: 'production', FORCE_HTTPS: 'false' } },
];
const PROFILE_NAMES = PROFILES.map((p) => p.name);

const USAGE = `사용법: node scripts/contract-run.mjs [--profile <name>]... [--files <path>[,<path>]...]
                                    [--out <report.json>] [--base-url-map <file.json>] [--credentials <file.json>]
                                    [--boot-check] [--require-full-coverage] [--require-spec-paths]
                                    [--dual-run] [--keep] [--timeout <ms>]
  --profile <name>     실행할 프로파일(반복 가능). 미지정=전 프로파일(${PROFILE_NAMES.join('|')}).
  --files <p>[,<p>]... 케이스 파일 명시(반복·콤마 가능). 미지정=contract/cases/<profile>/*.contract.js 전부(정렬).
  --out <path>         리포트 JSON 경로. 미지정=OS 임시 디렉토리(경로를 stdout에 출력 — 리포 오염 금지).
  --base-url-map <f>   { "<profile>": "<baseUrl>" } — 외부 대상. 서버 기동·시드 안 함. --credentials 필수.
  --credentials <f>    { "R": {"userId","password"}, "D": ..., "Z": ... } — 미지정+Node 대상이면 SAMPLE_USERS에서 조립.
  --boot-check         케이스를 돌리지 않고 프로파일 기동→health→세션/자격증명 준비→종료·정리까지만 수행.
  --require-full-coverage  커버리지 미달 시 exit 1(기본은 경고 + exit 0).
  --require-spec-paths     contract-inventory-check.mjs의 YAML 경로 검사까지 실패로 취급(step12 전용).
  --dual-run           같은 대상에 스위트를 연속 2회 실행해 리포트 2개를 OS 임시 디렉토리에 쓰고
                       contract-diff.mjs로 비교한다(차이가 있으면 exit 1). --out과 함께 쓸 수 없다.
  --keep               임시 디렉토리를 지우지 않는다(실패 시에는 항상 보존).
  --timeout <ms>       단계별 대기 한도(기본 45000, 1000 이상 정수).`;

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
  const opts = {
    profiles: [], files: [], bootCheck: false, requireFullCoverage: false,
    requireSpecPaths: false, dualRun: false, keep: false, timeout: 45000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--profile') { opts.profiles.push(takeValue(i, '--profile')); i += 1; }
    else if (a === '--files') { opts.files.push(...takeValue(i, '--files').split(',').map((s) => s.trim()).filter(Boolean)); i += 1; }
    else if (a === '--out') { opts.out = takeValue(i, '--out'); i += 1; }
    else if (a === '--base-url-map') { opts.baseUrlMap = takeValue(i, '--base-url-map'); i += 1; }
    else if (a === '--credentials') { opts.credentials = takeValue(i, '--credentials'); i += 1; }
    else if (a === '--boot-check') opts.bootCheck = true;
    else if (a === '--require-full-coverage') opts.requireFullCoverage = true;
    else if (a === '--require-spec-paths') opts.requireSpecPaths = true;
    else if (a === '--dual-run') opts.dualRun = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') { opts.timeout = Number(takeValue(i, '--timeout')); i += 1; }
    else die(`알 수 없는 인자: ${a}`);
  }
  for (const p of opts.profiles) {
    if (!PROFILE_NAMES.includes(p)) die(`--profile 값이 유효하지 않다(${PROFILE_NAMES.join('|')}): ${p}`);
  }
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) {
    die(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${opts.timeout}`);
  }
  // --dual-run 가드: 리포트 경로는 이 모드가 스스로 정한다(플랫폼 의존 리터럴 제거),
  // 그리고 관측 0건(--boot-check)끼리의 비교는 판정이 아니라 거짓 green이다.
  if (opts.dualRun && opts.out) die('--dual-run은 리포트 2개를 OS 임시 디렉토리에 직접 쓴다 — --out과 함께 쓸 수 없다.');
  if (opts.dualRun && opts.bootCheck) die('--dual-run은 --boot-check와 함께 쓸 수 없다 — 관측 0건끼리의 비교는 차이 0을 보장할 뿐 계약 판정이 아니다.');
  return opts;
}

// 자식 env 정리 — verify-integration cleanEnv()와 동형 + 외부 API 키 4종 삭제(결정성 — decisions (9):
// 키가 남으면 미디어/번역 케이스가 실 네트워크를 때린다). NODE_OPTIONS는 예기치 못한 주입 차단.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of [
    'NODE_ENV', 'FORCE_HTTPS', 'ALLOWED_ORIGINS', 'COLLECTION_TOKEN', 'RCV_SPOOL_DIR', 'DIST_SPOOL_DIR',
    'DATA_DIR', 'SPA_DIR', 'PORT', 'HOST', 'NODE_OPTIONS',
    'GOOGLE_API_KEY', 'GOOGLE_CSE_ID', 'YOUTUBE_API_KEY', 'GOOGLE_TRANSLATE_API_KEY',
  ]) delete env[k];
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 자식 종료 여부 — 시그널 종료는 exitCode가 null이고 signalCode만 채워진다(실측). 둘 다 봐야 한다.
const childDead = (child) => child.exitCode !== null || child.signalCode !== null;

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (childDead(child)) return resolve(true);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, ms);
    child.once('exit', onExit);
  });
}

// kill → 확인 → SIGKILL 폴백. 서버를 남기면 다음 프로파일이 같은 포트/DATA_DIR 계열 실패로 오염된다.
async function killChild(child) {
  if (!child || childDead(child)) return true;
  child.kill();
  if (await waitExit(child, 2000)) return true;
  child.kill('SIGKILL');
  return waitExit(child, 2000);
}

// 빈 포트 확정 — 후보를 실제로 listen해 본다(추측 금지 — verify-integration pickFreePort 동형).
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
  throw new Error(`빈 포트를 찾지 못했다(host=${host}, [${PORT_BASE}, ${PORT_BASE + PORT_SPAN}) 20회 시도) — 환경 이상`);
}

async function healthOk(baseUrl, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && childDead(child)) return false; // 자식이 죽었으면 즉시 실패 — 대기 낭비 금지.
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 && (await res.json()).ok === true) return true;
    } catch { /* 기동 전/도달 불가 — 재시도 */ }
    await sleep(100);
  }
  return false;
}

// --- 데이터 안전 스냅샷 (decisions (14) — verify-integration repoDataSnapshot 동형) ---
function repoDataSnapshot() {
  const dbFile = nodePath.join(REPO_ROOT, 'news.db');
  const uploadsDir = nodePath.join(REPO_ROOT, 'uploads');
  const st = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  return {
    db: st ? { size: st.size, mtimeMs: st.mtimeMs } : null,
    uploads: fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : null,
  };
}

function loadJsonFile(file, label) {
  const abs = nodePath.resolve(file);
  if (!fs.existsSync(abs)) die(`${label} 파일이 존재하지 않는다: ${abs}`);
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    die(`${label} 파일 파싱 실패(${abs}): ${e.message}`);
  }
  return undefined; // 도달 불가 — die는 exit한다.
}

// 자격증명 조립 — Node 대상 기본은 SAMPLE_USERS(시드와 같은 출처). --credentials가 이긴다.
// 검증은 shape만 한다(값은 로그·요약 어디에도 남기지 않는다).
function resolveCredentials(opts) {
  if (opts.credentials) {
    const given = loadJsonFile(opts.credentials, '--credentials');
    for (const role of ROLES) {
      const c = given?.[role];
      if (!c || typeof c.userId !== 'string' || typeof c.password !== 'string') {
        die(`--credentials 파일에 ${role} 역할의 {userId, password}가 없다: ${nodePath.resolve(opts.credentials)}`);
      }
    }
    return { R: given.R, D: given.D, Z: given.Z };
  }
  const byRole = {};
  for (const u of SAMPLE_USERS) byRole[u.role] = { userId: u.userId, password: u.password };
  for (const role of ROLES) {
    if (!byRole[role]) die(`SAMPLE_USERS에 ${role} 역할 계정이 없다 — src/db/seed.js 확인`);
  }
  return byRole;
}

// 세션 준비 — R/D/Z 정확히 3회 로그인(로그인 예산 규율 — decisions (8): 15분/10회 IP 레이트리밋).
// 실패 사유에 비밀 값은 담지 않는다(status·reason 토큰만).
async function prepareSessions(baseUrl, credentials) {
  const sessions = {};
  for (const role of ROLES) {
    const cred = credentials[role];
    let res;
    let body;
    try {
      res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
      sid: body.sessionId,
      userId: u.userId, name: u.name, role: u.role,
      department: u.department, departmentCode: u.departmentCode,
    };
  }
  return { ok: true, sessions };
}

// 케이스 파일 해석 — 디렉토리가 없으면 0건이고 실패가 아니다(케이스는 step2+ 소유).
function resolveCaseFiles(profileName, filesOverride) {
  if (filesOverride.length > 0) return filesOverride.map((f) => nodePath.resolve(f));
  const dir = nodePath.join(CASES_ROOT, profileName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.contract.js'))
    .sort()
    .map((f) => nodePath.join(dir, f));
}

function collectOutput(child) {
  const buf = { out: '', err: '' };
  child.stdout.on('data', (c) => { buf.out += c; });
  child.stderr.on('data', (c) => { buf.err += c; });
  return buf;
}

// --- 프로파일 1개 실행 ---
// 반환 { name, boot: 'ok'|'failed'|'unavailable', casesFailed, notes[], diagnostics[], reportDir }.
// externalBaseUrl이 있으면 서버 기동·시드를 생략한다(--base-url-map — decisions (4)).
async function runProfile(profile, opts, ctx) {
  const notes = [];
  const diagnostics = [];
  const root = ctx.mkTmp(`contract-${profile.name}-`);
  const reportDir = nodePath.join(root, 'report');
  fs.mkdirSync(reportDir);

  let serverChild = null;
  let serverBuf = { out: '', err: '' };
  let baseUrl = ctx.externalBaseUrls ? ctx.externalBaseUrls[profile.name] : null;
  let port = null;

  try {
    if (!ctx.externalBaseUrls) {
      // 1. 임시 DATA_DIR 시드 — 리포 news.db는 절대 열지 않는다.
      const dataDir = nodePath.join(root, 'data');
      fs.mkdirSync(dataDir);
      const db = new DatabaseSync(nodePath.join(dataDir, 'news.db'));
      createSchema(db);
      seedUsers(db);
      db.close();

      // 2. 빈 포트 확보(실제 listen) → 3. 명시 env로 spawn.
      port = await pickFreePort(profile.host);
      const env = cleanEnv();
      env.DATA_DIR = dataDir;
      env.PORT = String(port);
      env.HOST = profile.host;
      env.SPA_DIR = ''; // 정적 서빙 off — 39 라우트 밖 표면 제거(측정 조건).
      if (profile.spool) {
        const spoolDir = nodePath.join(root, 'spool');
        fs.mkdirSync(spoolDir);
        env.DIST_SPOOL_DIR = spoolDir;
      }
      if (profile.token) env.COLLECTION_TOKEN = COLLECTION_TEST_TOKEN;
      Object.assign(env, profile.extraEnv);

      serverChild = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      serverBuf = collectOutput(serverChild);
      baseUrl = `http://127.0.0.1:${port}`; // 접속은 항상 127.0.0.1(failclosed 0.0.0.0 바인딩 포함).
    }

    // health 왕복 — 실패는 부팅 실패다(조용한 skip 금지 — decisions (25)).
    const bootStart = Date.now();
    const healthy = await healthOk(baseUrl, opts.timeout, serverChild);
    if (!healthy) {
      diagnostics.push(`health 왕복 실패: ${baseUrl}/api/health`);
      return { name: profile.name, boot: 'failed', casesFailed: false, notes, diagnostics, reportDir };
    }
    notes.push(`boot ok ${Date.now() - bootStart}ms port=${port ?? '(external)'}`);

    // 4. 세션·자격증명 준비 — credentials.json은 프로파일과 무관하게 항상 쓴다(케이스 직접 로그인용).
    const credentialsFile = nodePath.join(root, 'credentials.json');
    fs.writeFileSync(credentialsFile, `${JSON.stringify(ctx.credentials, null, 2)}\n`);
    let sessionsFile = null;
    if (profile.sessions) {
      const prep = await prepareSessions(baseUrl, ctx.credentials);
      if (!prep.ok) {
        diagnostics.push(`세션 준비 실패: ${prep.detail}`);
        return { name: profile.name, boot: 'failed', casesFailed: false, notes, diagnostics, reportDir };
      }
      sessionsFile = nodePath.join(root, 'sessions.json');
      fs.writeFileSync(sessionsFile, `${JSON.stringify(prep.sessions, null, 2)}\n`);
      notes.push(`sessions ok roles=${ROLES.join(',')}`);
    } else {
      notes.push('sessions skipped(케이스가 직접 로그인)');
    }

    // 5. 케이스 실행 — --boot-check면 여기서 끝(기동·준비·정리만 실증).
    if (opts.bootCheck) return { name: profile.name, boot: 'ok', casesFailed: false, notes, diagnostics, reportDir };

    const files = resolveCaseFiles(profile.name, opts.files);
    if (files.length === 0) {
      notes.push('cases 0건(디렉토리 없음/빈 목록 — 실패 아님)');
      return { name: profile.name, boot: 'ok', casesFailed: false, notes, diagnostics, reportDir };
    }
    const caseEnv = cleanEnv();
    caseEnv.CONTRACT_BASE_URL = baseUrl;
    caseEnv.CONTRACT_PROFILE = profile.name;
    caseEnv.CONTRACT_CREDENTIALS = credentialsFile;
    caseEnv.CONTRACT_REPORT_DIR = reportDir;
    if (sessionsFile) caseEnv.CONTRACT_SESSIONS = sessionsFile;
    if (profile.token) caseEnv.CONTRACT_COLLECTION_TOKEN = COLLECTION_TEST_TOKEN;
    const testChild = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
      cwd: REPO_ROOT, env: caseEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const testBuf = collectOutput(testChild);
    await new Promise((resolve) => testChild.once('close', resolve));
    process.stdout.write(testBuf.out);
    if (testBuf.err.trim()) process.stderr.write(testBuf.err);
    if (testChild.exitCode !== 0) {
      // 케이스 실패는 그 프로파일의 실패지만 나머지 프로파일은 끝까지 돈다(진단 보존 — step1 배경).
      diagnostics.push(`케이스 실행 실패(exit=${testChild.exitCode}) files=${files.length}`);
      return { name: profile.name, boot: 'ok', casesFailed: true, notes, diagnostics, reportDir };
    }
    notes.push(`cases ok files=${files.length}`);
    return { name: profile.name, boot: 'ok', casesFailed: false, notes, diagnostics, reportDir };
  } catch (err) {
    diagnostics.push(String(err && err.stack ? err.stack : err));
    return { name: profile.name, boot: 'failed', casesFailed: false, notes, diagnostics, reportDir };
  } finally {
    // 6. 서버 종료 — 실패해도 반드시 시도한다(서버 잔존 = 다음 프로파일 오염 — ADR-012).
    if (serverChild) {
      const killed = await killChild(serverChild);
      if (!killed) diagnostics.push('서버 프로세스 종료 실패(SIGKILL 후에도 잔존)');
      else notes.push('shutdown ok');
    }
    // 부팅 실패 시 자식 stdout/stderr를 진단에 첨부한다(decisions (25) (b)).
    if (diagnostics.length > 0 && serverChild) {
      diagnostics.push(`--- server stdout ---\n${serverBuf.out}`);
      diagnostics.push(`--- server stderr ---\n${serverBuf.err}`);
    }
  }
}

// --- 리포트 병합 (스키마 B — decisions (11)(12)) ---
function readObservations(reportDirs) {
  const observations = [];
  const errors = [];
  for (const dir of reportDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
      const text = fs.readFileSync(nodePath.join(dir, f), 'utf8');
      for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
        try {
          observations.push(JSON.parse(line));
        } catch (e) {
          errors.push(`관측 JSONL 파싱 실패(${nodePath.join(dir, f)}): ${e.message}`);
        }
      }
    }
  }
  return { observations, errors };
}

const OBS_SORT_KEYS = ['profile', 'routeId', 'tag', 'caseId'];
function compareBy(keys) {
  return (a, b) => {
    for (const k of keys) {
      const x = String(a?.[k] ?? '');
      const y = String(b?.[k] ?? '');
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
}

// 커버리지 판정(decisions (13)) — 단위는 (routeId, 필수 expect 태그) 쌍. 요약의 covered=<n>/<총>은
// 라우트 단위(전 필수 태그 충족 = covered)로 접는다. x- 접두 관측은 집계에서 제외된다(decisions (23)).
function judgeCoverage(inventory, observations) {
  const ids = new Set(inventory.routes.map((r) => r.id));
  const vocabularyErrors = [];
  for (const o of observations) {
    if (typeof o.routeId !== 'string' || (!ids.has(o.routeId) && !o.routeId.startsWith('x-'))) {
      vocabularyErrors.push(
        `인벤토리에 없는 non-x routeId 관측: ${JSON.stringify(o.routeId)} (profile=${o.profile} caseId=${o.caseId}) — 오타이거나 인벤토리 누락(x- 접두사 규칙은 endpoints.json README 참조)`,
      );
    }
  }
  const seen = new Set(
    observations
      .filter((o) => typeof o.routeId === 'string' && ids.has(o.routeId))
      .map((o) => `${o.routeId} ${o.tag}`),
  );
  const missingPairs = [];
  let coveredRoutes = 0;
  for (const r of inventory.routes) {
    const missing = (r.expect ?? []).filter((tag) => !seen.has(`${r.id} ${tag}`));
    if (missing.length === 0) coveredRoutes += 1;
    else missingPairs.push(...missing.map((tag) => `${r.id}:${tag}`));
  }
  return { vocabularyErrors, missingPairs, coveredRoutes };
}

function runSpecPathsCheck() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [nodePath.join(REPO_ROOT, 'scripts', 'contract-inventory-check.mjs'), '--require-spec-paths'], {
      cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const buf = collectOutput(child);
    child.once('close', (code) => resolve({ code, out: buf.out, err: buf.err }));
  });
}

// --- 이중 실행(--dual-run, step12) ---
// 같은 대상에 스위트를 연속 2회 돌려 정규화 리포트가 결정적인지, 그리고 diff 도구가 도는지를 실증한다.
// 각 실행은 별도 프로세스다(자기 자신을 --dual-run 없이 재실행) — 프로세스 상태가 새어 "같아 보이는"
// 결과를 만들 여지를 없애고, --profile·--base-url-map·--require-* 같은 다른 플래그는 그대로 전달된다
// (68+에서 Spring을 두 번 돌려 자기 결정성을 먼저 확인하는 용도).
function spawnPass(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('close', (code) => resolve(code === null ? 1 : code));
  });
}

async function runDualRun(argv) {
  const passArgs = argv.filter((a) => a !== '--dual-run');
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'contract-dualrun-'));
  const outFiles = { A: nodePath.join(dir, 'run-a.json'), B: nodePath.join(dir, 'run-b.json') };
  const codes = {};
  for (const label of ['A', 'B']) {
    process.stdout.write(`[dual-run ${label}] 실행 시작 → ${outFiles[label]}\n`);
    codes[label] = await spawnPass([...passArgs, '--out', outFiles[label]]);
    process.stdout.write(`[dual-run ${label}] 실행 종료 exit=${codes[label]}\n`);
  }

  const failures = [];
  for (const label of ['A', 'B']) {
    if (codes[label] !== 0) failures.push(`실행 ${label}이 실패했다(exit=${codes[label]}) — 위 출력의 FAIL 사유를 먼저 해결하라.`);
    if (!fs.existsSync(outFiles[label])) failures.push(`실행 ${label}의 리포트가 만들어지지 않았다: ${outFiles[label]}`);
  }

  let result = null;
  if (fs.existsSync(outFiles.A) && fs.existsSync(outFiles.B)) {
    const [a, b] = ['A', 'B'].map((label) => JSON.parse(fs.readFileSync(outFiles[label], 'utf8')));
    result = compareReports(a, b);
    const lines = formatDiffLines(result);
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    if (result.diffCount > 0) failures.push(`이중 실행 리포트 차이 ${result.diffCount}건 — 리포트 정규화가 비결정적이거나 대상 동작이 갈렸다.`);
  }

  const ok = failures.length === 0;
  // 리포트 2개는 진단 자산이라 성패와 무관하게 남긴다(리포 안에는 아무것도 쓰지 않는다).
  // 대신 삭제 책임을 호출자에게 명시한다 — 임시 디렉토리 누적이 이 하네스의 알려진 위생 부채다.
  process.stdout.write(`reportA=${outFiles.A}\nreportB=${outFiles.B}\n`);
  process.stdout.write(`  (리포트는 OS 임시 디렉토리에만 쓴다 — 확인 후 ${dir}를 삭제하라)\n`);
  if (!ok) process.stderr.write(`${failures.map((f) => `FAIL ${f}`).join('\n')}\n`);
  process.stdout.write(
    `contract-dual-run ${ok ? 'ok' : 'FAILED'} passes=A:${codes.A},B:${codes.B} `
    + `observations=${result ? result.observationCount : 0} diffs=${result ? result.diffCount : '-'}\n`,
  );
  process.exit(ok ? 0 : 1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.dualRun) {
    await runDualRun(process.argv.slice(2)); // 내부에서 exit한다.
    return;
  }

  const inventoryRaw = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
  const inventory = { routes: Array.isArray(inventoryRaw?.routes) ? inventoryRaw.routes : [] };
  const routeCount = inventory.routes.length;

  // 외부 대상 가드 — 비밀번호 추측 금지(decisions (22)): --credentials 없이는 즉시 실패한다.
  let externalBaseUrls = null;
  if (opts.baseUrlMap) {
    if (!opts.credentials) {
      die('외부 대상(--base-url-map)에는 --credentials <file>이 필수다 — 대상 서버의 계정·비밀번호를 추측하지 않는다.');
    }
    const map = loadJsonFile(opts.baseUrlMap, '--base-url-map');
    externalBaseUrls = {};
    for (const [k, v] of Object.entries(map ?? {})) {
      if (!PROFILE_NAMES.includes(k)) die(`--base-url-map에 알 수 없는 프로파일이 있다: ${k}`);
      if (typeof v !== 'string' || !/^https?:\/\//.test(v)) die(`--base-url-map의 ${k} 값이 baseUrl이 아니다: ${JSON.stringify(v)}`);
      externalBaseUrls[k] = v.replace(/\/+$/, '');
    }
  }
  const credentials = resolveCredentials(opts);

  // 선택 프로파일 — 표의 정의 순서를 유지한다(중복 제거).
  const selected = PROFILES.filter((p) => opts.profiles.length === 0 || opts.profiles.includes(p.name));

  const tmpDirs = [];
  const ctx = {
    credentials,
    externalBaseUrls,
    mkTmp(prefix) {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
      tmpDirs.push(dir);
      return dir;
    },
  };

  // SIGINT — 임시 디렉토리 정리만 소유한다(콘솔 Ctrl+C는 자식에게도 전달된다 — verify-integration 전례).
  let cleaned = false;
  const cleanupTmp = () => {
    if (cleaned) return;
    cleaned = true;
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        process.stderr.write(`warn 임시 디렉토리 정리 실패(무해 — Windows 파일 잠금): ${dir} (${err && err.code})\n`);
      }
    }
  };
  process.on('SIGINT', () => {
    cleanupTmp();
    process.exit(130);
  });

  // 데이터 안전 — before 스냅샷(리포 news.db·uploads/)이 종료 후 무변 단언의 기준점이다.
  const repoBefore = repoDataSnapshot();

  const failures = [];
  const skipped = [];
  const results = [];
  for (const profile of selected) {
    // 외부 대상 모드에서 맵에 없는 프로파일은 실행하지 않는다 — 통과로 위장하지 않는다(decisions (26)).
    if (externalBaseUrls && !(profile.name in externalBaseUrls)) {
      skipped.push({ profile: profile.name, reason: 'profile-unavailable' });
      process.stdout.write(`[${profile.name}] skipped profile-unavailable(--base-url-map에 없음)\n`);
      continue;
    }
    process.stdout.write(`[${profile.name}] 시작\n`);
    const r = await runProfile(profile, opts, ctx);
    results.push(r);
    for (const n of r.notes) process.stdout.write(`  ${n}\n`);
    if (r.boot === 'failed') {
      // 부팅 실패 = 그 프로파일 전 케이스 skipped + 진단 첨부 + 나머지 계속 + 종합 exit 1(decisions (25)).
      skipped.push({ profile: profile.name, reason: 'profile-boot-failed' });
      failures.push(`[${profile.name}] 프로파일 부팅 실패:\n${r.diagnostics.join('\n')}`);
    } else if (r.casesFailed) {
      failures.push(`[${profile.name}] ${r.diagnostics.join('\n')}`);
    }
  }

  // 리포트 병합 — (profile, routeId, tag, caseId) 정렬. 같은 서버 2회 실행 = 바이트 동일이 목표(decisions (11)).
  const { observations, errors: parseErrors } = readObservations(results.map((r) => r.reportDir));
  failures.push(...parseErrors);
  observations.sort(compareBy(OBS_SORT_KEYS));
  skipped.sort(compareBy(['profile', 'reason']));

  const { vocabularyErrors, missingPairs, coveredRoutes } = judgeCoverage(inventory, observations);
  failures.push(...vocabularyErrors);

  const report = {
    version: 1,
    meta: {
      target: externalBaseUrls ? 'external' : 'node',
      profiles: selected.map((p) => p.name),
      routeCount,
    },
    observations,
    skipped,
  };
  const outFile = opts.out
    ? nodePath.resolve(opts.out)
    : nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'contract-report-')), 'report.json');
  fs.mkdirSync(nodePath.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

  // 커버리지 — 기본은 경고 + exit 0(중간 step 배려), --require-full-coverage에서만 실패(decisions (13)).
  // --boot-check는 케이스를 돌리지 않으므로 미커버 나열은 소음이다(생략) — 단 플래그 명시는 그대로 존중한다.
  if (missingPairs.length > 0 && (!opts.bootCheck || opts.requireFullCoverage)) {
    const lines = missingPairs.map((p) => `  미커버: ${p}`).join('\n');
    if (opts.requireFullCoverage) {
      failures.push(`커버리지 미달 ${missingPairs.length}쌍(--require-full-coverage):\n${lines}`);
    } else {
      process.stdout.write(`warn 커버리지 미달 ${missingPairs.length}쌍(경고 — --require-full-coverage에서 실패):\n${lines}\n`);
    }
  }

  // YAML 경로 검사(step12 전용 게이트) — contract-inventory-check.mjs에 위임한다.
  if (opts.requireSpecPaths) {
    const spec = await runSpecPathsCheck();
    process.stdout.write(spec.out);
    if (spec.code !== 0) failures.push(`contract-inventory-check --require-spec-paths 실패(exit=${spec.code}):\n${spec.err}`);
  }

  // 데이터 안전 단언 — 리포 news.db·uploads/가 변했으면 실패다(무엇이 열렸든 되돌릴 수 없다).
  const repoAfter = repoDataSnapshot();
  if (JSON.stringify(repoBefore) !== JSON.stringify(repoAfter)) {
    failures.push(`리포 news.db/uploads 변동: before=${JSON.stringify(repoBefore)} after=${JSON.stringify(repoAfter)}`);
  }

  // 정리 — 성공 + !keep일 때만 지운다. 실패 시 보존(진단·재현용 — 세션/자격증명 파일이 있으니 확인 후 삭제하라).
  const ok = failures.length === 0;
  if (ok && !opts.keep) {
    cleanupTmp();
  } else if (tmpDirs.length > 0) {
    process.stdout.write(`keep 임시 디렉토리 보존(${ok ? '--keep' : '실패 진단용'} — 세션/자격증명 파일 포함, 확인 후 삭제하라):\n${tmpDirs.map((d) => `  ${d}`).join('\n')}\n`);
  }

  const caseCount = new Set(observations.map((o) => `${o.profile} ${o.caseId}`)).size;
  const summary = `contract-run ${ok ? 'ok' : 'FAILED'} profiles=${selected.length} cases=${caseCount} covered=${coveredRoutes}/${routeCount} skipped=${skipped.length} report=${outFile}`;
  if (!ok) {
    process.stderr.write(`${failures.map((f) => `FAIL ${f}`).join('\n')}\n`);
    process.stdout.write(`${summary}\n`);
    process.exit(1);
  }
  process.stdout.write(`${summary}\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`contract-run 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
