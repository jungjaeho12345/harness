// 클라이언트 셸 자동 스모크 (phase 62 step2) — 셸을 실기 기동해 diag JSONL(step1 계획 8절 계약)을 단언한다.
// 사용: node scripts/verify-client.mjs (--dev | --exe <path>) [--scenario a|b|all] [--server <origin>] [--keep] [--timeout <ms>]
//  - 시나리오 A(설정 있음): config.json 주입 → 앱 창 경로(app-ready→config-loaded→app-window→did-finish-load,
//    did-navigate 200, title 비어 있지 않음) + 두 번째 인스턴스 즉시 종료·second-instance 기록.
//  - 시나리오 B(설정 없음): 설정 화면 경로(config-loaded{false}→setup-shown{no-config}→local-window{setup}→
//    did-finish-load file:///setup.html) + ipc{getState,trusted:true} 왕복(preload·pages 실배치 증거).
//    B-4(게이트 ② 확정 대체): 도달 불가 serverUrl(http://127.0.0.1:1) config로 기동 → app-window →
//    load-failed → 오류 로컬 창 → ipc{getState,trusted:true}. probe{ok:false}는 이 경로에 남지 않는다 —
//    프로브는 사용자 액션(버튼 클릭)에만 발생하는 설계(ADR-008)라 이 스크립트는 그 항목을 "미검증"으로 출력한다.
// CRITICAL(데이터 안전): 서버는 임시 DATA_DIR, 클라이언트는 임시 CLIENT_USER_DATA로만 기동한다.
//   리포 루트 news.db·uploads/와 실사용자 %APPDATA%\기사작성기에는 절대 바인딩하지 않으며,
//   실사용자 폴더가 검증 전후로 무변인지 단언한다(부팅 순서 계약 decisions (11)의 증거).
// CRITICAL(env): ELECTRON_RUN_AS_NODE가 상속되면 electron.exe가 플레인 Node로 떠서 셸이 죽는다 —
//   자식 env에서 반드시 제거한다(이 리포의 에이전트/CI 세션에서 실측된 함정).
// 주의: scripts/**는 eslint ignore 대상이다 — 인자 가드가 이 스크립트의 유일한 정적 안전망이다.

import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { flagValue } from './lib/cliArgs.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const CLIENT_DIR = nodePath.join(REPO_ROOT, 'client');
const WEB_DIST = nodePath.join(REPO_ROOT, 'web', 'dist');

const USAGE = `사용법: node scripts/verify-client.mjs (--dev | --exe <path>) [--scenario a|b|all] [--server <origin>] [--keep] [--timeout <ms>]
  --dev           리포의 client/를 devDependency electron 런타임으로 기동한다.
  --exe <path>    패키징된 실행 파일(기사작성기.exe)을 기동한다. --dev와 동시 지정 불가.
  --scenario      a(설정 있음·앱 창) | b(설정 없음·설정 화면 + 오류 화면) | all(기본).
  --server        기동 중인 서버 origin 재사용(미지정 시 임시 DATA_DIR로 서버를 직접 띄운다).
  --keep          임시 디렉토리를 지우지 않는다(디버깅용).
  --timeout <ms>  diag 이벤트 대기 한도(기본 45000).`;

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
  const opts = { scenario: 'all', keep: false, timeout: 45000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dev') opts.dev = true;
    else if (a === '--exe') { opts.exe = takeValue(i, '--exe'); i += 1; }
    else if (a === '--scenario') { opts.scenario = takeValue(i, '--scenario'); i += 1; }
    else if (a === '--server') { opts.server = takeValue(i, '--server'); i += 1; }
    else if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') { opts.timeout = Number(takeValue(i, '--timeout')); i += 1; }
    else die(`알 수 없는 인자: ${a}`);
  }
  // 인자 가드 — 오타가 "검증 통과"로 둔갑하지 않게 전부 막는다(scripts/**는 eslint 밖).
  if (!opts.dev === !opts.exe) die('--dev 또는 --exe <path> 중 정확히 하나를 지정하라.');
  if (opts.exe !== undefined) {
    opts.exe = nodePath.resolve(opts.exe);
    if (!fs.existsSync(opts.exe)) die(`--exe 경로가 존재하지 않는다: ${opts.exe}`);
  }
  if (!['a', 'b', 'all'].includes(opts.scenario)) die(`--scenario 값이 유효하지 않다(a|b|all): ${opts.scenario}`);
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) die(`--timeout 값이 유효하지 않다(ms, 1000 이상): ${opts.timeout}`);
  return opts;
}

// 자식 env — 상속 env의 우연한 값으로 결과가 흔들리지 않게 정리한다(T4·verify-server-exe 전례).
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

// 이벤트 이름 시퀀스가 diag에 "그 순서로" 존재하는지(strictly increasing index). 조건은 이름 또는 [이름, 술어].
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

// 실사용자 %APPDATA%\기사작성기 스냅샷 — 검증이 실환경을 건드리지 않았다는 증거의 기준점.
function appDataSnapshot() {
  const base = process.env.APPDATA;
  if (!base) return { available: false };
  const dir = nodePath.join(base, '기사작성기');
  const exists = fs.existsSync(dir);
  let config = null;
  if (exists) {
    const cfgFile = nodePath.join(dir, 'config.json');
    if (fs.existsSync(cfgFile)) {
      const st = fs.statSync(cfgFile);
      config = { size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return { available: true, dir, exists, config };
}

function appDataUnchanged(before, after) {
  if (!before.available || !after.available) return true; // APPDATA 자체가 없으면 판정 불가 — 통과로 두지 않고 호출부가 기록.
  if (before.exists !== after.exists) return false;
  return JSON.stringify(before.config) === JSON.stringify(after.config);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const failures = [];
  const notes = [];
  const tmpDirs = [];
  const check = (name, ok, detail = '') => {
    notes.push(`${ok ? 'ok' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
    if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  };
  const mkTmp = (prefix) => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  };

  // --- 서버 준비 ---
  let serverChild = null;
  let serverOut = '';
  let serverErr = '';
  let origin = opts.server ?? null;
  if (!origin) {
    if (!fs.existsSync(nodePath.join(WEB_DIST, 'index.html'))) {
      die(`web/dist/index.html이 없다 — npm run build를 먼저 실행하라: ${WEB_DIST}`);
    }
    const dataDir = mkTmp('verify-client-data-');
    const serverCwd = mkTmp('verify-client-cwd-');
    const port = 20000 + Math.floor(Math.random() * 30000);
    origin = `http://127.0.0.1:${port}`;
    const env = cleanEnv();
    env.PORT = String(port);
    env.HOST = '127.0.0.1';
    env.DATA_DIR = dataDir;
    env.SPA_DIR = WEB_DIST;
    serverChild = spawn(process.execPath, [nodePath.join(REPO_ROOT, 'server', 'index.js')], {
      cwd: serverCwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverChild.stdout.on('data', (c) => { serverOut += c; });
    serverChild.stderr.on('data', (c) => { serverErr += c; });
  }

  // 클라이언트 기동 커맨드 — dev는 devDependency electron 런타임, exe는 패키징 산출물.
  let clientCmd;
  let clientArgs;
  if (opts.dev) {
    // 플레인 Node에서 require('electron')은 실행 파일 경로 문자열을 돌려준다(npm 패키지 계약).
    const electronExe = createRequire(import.meta.url)('electron');
    if (typeof electronExe !== 'string' || !fs.existsSync(electronExe)) {
      die(`electron 런타임이 없다 — npm install로 내려받아야 한다: ${electronExe}`);
    }
    clientCmd = electronExe;
    clientArgs = [CLIENT_DIR];
  } else {
    clientCmd = opts.exe;
    clientArgs = [];
  }

  const spawnClient = (userDataDir) => {
    const env = cleanEnv();
    env.CLIENT_USER_DATA = userDataDir;
    env.CLIENT_DIAG_FILE = nodePath.join(userDataDir, 'diag.jsonl');
    env.CLIENT_SELFTEST = '1'; // 검증이 데스크톱을 점유하지 않는다(창 비표시).
    const child = spawn(clientCmd, clientArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child._out = '';
    child._err = '';
    child.stdout.on('data', (c) => { child._out += c; });
    child.stderr.on('data', (c) => { child._err += c; });
    return child;
  };

  // 임시 userData에 Chromium 프로필 산출물이 생겼는지 — CLIENT_USER_DATA가 실제로 적용된 증거.
  // (Windows의 단일 인스턴스 잠금은 파일이 아닐 수 있다 — 잠금 파일 존재는 단언하지 않는다.)
  const assertProfileArtifacts = (label, userDataDir) => {
    const entries = fs.existsSync(userDataDir)
      ? fs.readdirSync(userDataDir).filter((n) => n !== 'config.json' && n !== 'diag.jsonl')
      : [];
    check(`${label} 임시 userData 프로필 산출물 생성`, entries.length > 0, `entries=${entries.length}`);
  };

  const appDataBefore = appDataSnapshot();
  if (!appDataBefore.available) notes.push('warn %APPDATA% 미정의 — 실사용자 폴더 무변 판정 불가');
  let activeClient = null;

  try {
    // 서버 health 폴링 — 200 + { ok:true } 본문까지(최대 30초).
    {
      let ready = false;
      for (let i = 0; i < 300 && !ready; i += 1) {
        if (serverChild && serverChild.exitCode !== null) break;
        try {
          const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
          ready = res.status === 200 && (await res.json()).ok === true;
        } catch { /* 기동 전 — 재시도 */ }
        if (!ready) await sleep(100);
      }
      if (!ready) {
        throw new Error(`서버가 기동하지 않았다: ${origin}\n--- server stdout ---\n${serverOut}\n--- server stderr ---\n${serverErr}`);
      }
      check('server health 200 + {ok:true}', true, origin);
    }

    // --- 시나리오 A: 설정 있음 → 앱 창 경로 ---
    if (opts.scenario === 'a' || opts.scenario === 'all') {
      const aStart = Date.now();
      const userData = mkTmp('verify-client-ud-a-');
      fs.writeFileSync(nodePath.join(userData, 'config.json'), `${JSON.stringify({ schemaVersion: 1, serverUrl: origin })}\n`);
      const diagFile = nodePath.join(userData, 'diag.jsonl');
      activeClient = spawnClient(userData);
      const seq = [
        'app-ready',
        ['config-loaded', (l) => l.hasServerUrl === true],
        'app-window',
        ['did-navigate', (l) => l.httpResponseCode === 200],
        ['did-finish-load', (l) => typeof l.title === 'string' && l.title.length > 0],
      ];
      const r = await waitForSequence(diagFile, seq, opts.timeout);
      check('A: app-ready→config-loaded{true}→app-window→did-navigate 200→did-finish-load(title 有) 순서', r.ok,
        r.ok ? `${Date.now() - aStart}ms` : `missing=${r.missing} events=[${r.lines.map((l) => l.event).join(',')}]`);
      if (!r.ok) {
        process.stderr.write(`--- scenario A diag ---\n${r.lines.map((l) => JSON.stringify(l)).join('\n')}\n--- client stderr ---\n${activeClient._err}\n`);
      }

      // 두 번째 인스턴스 — 같은 userData로 띄우면 잠금에 막혀 즉시 종료(exit 0)돼야 한다.
      const second = spawnClient(userData);
      const secondExit = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 15000);
        second.on('exit', (code) => { clearTimeout(t); resolve(code); });
      });
      if (secondExit === null) await killChild(second);
      check('A: 두 번째 인스턴스 즉시 종료(exit 0)', secondExit === 0, `exit=${secondExit}`);
      const r2 = await waitForSequence(diagFile, ['second-instance'], 10000);
      check('A: 첫 인스턴스 diag에 second-instance 기록', r2.ok, r2.ok ? '' : `events=[${r2.lines.map((l) => l.event).join(',')}]`);

      assertProfileArtifacts('A:', userData);
      await killChild(activeClient);
      activeClient = null;
    }

    // --- 시나리오 B: 설정 없음 → 설정 화면 경로 (+ B-4 오류 화면 경로) ---
    if (opts.scenario === 'b' || opts.scenario === 'all') {
      const bStart = Date.now();
      const userData = mkTmp('verify-client-ud-b-');
      const diagFile = nodePath.join(userData, 'diag.jsonl');
      activeClient = spawnClient(userData);
      const seq = [
        'app-ready',
        ['config-loaded', (l) => l.hasServerUrl === false],
        ['setup-shown', (l) => l.reason === 'no-config'],
        // preload·contextBridge·ipcMain 결선이 실제로 살아 있다는 증거 — 패키지에 pages/·preload.cjs가
        // 누락되면 여기서 잡힌다(이 왕복이 유일한 자동 게이트다).
        ['ipc', (l) => l.channel === 'getState' && l.trusted === true],
        ['did-finish-load', (l) => typeof l.url === 'string' && l.url.endsWith('setup.html')],
      ];
      const r = await waitForSequence(diagFile, seq, opts.timeout);
      const rLocal = await waitForSequence(diagFile, [['local-window', (l) => l.page === 'setup']], 1000);
      check('B: config-loaded{false}→setup-shown{no-config}→ipc{getState,true}→did-finish-load(setup.html)', r.ok && rLocal.ok,
        (r.ok && rLocal.ok) ? `${Date.now() - bStart}ms` : `missing=${r.missing ?? 'local-window{setup}'} events=[${r.lines.map((l) => l.event).join(',')}]`);
      if (!r.ok) {
        process.stderr.write(`--- scenario B diag ---\n${r.lines.map((l) => JSON.stringify(l)).join('\n')}\n--- client stderr ---\n${activeClient._err}\n`);
      }
      assertProfileArtifacts('B:', userData);
      await killChild(activeClient);
      activeClient = null;

      // B-4(게이트 ② 확정): 도달 불가 serverUrl config로 기동 → 앱 창 로드 실패 → 오류 로컬 창 → IPC 왕복.
      const userData4 = mkTmp('verify-client-ud-b4-');
      fs.writeFileSync(nodePath.join(userData4, 'config.json'), `${JSON.stringify({ schemaVersion: 1, serverUrl: 'http://127.0.0.1:1' })}\n`);
      const diagFile4 = nodePath.join(userData4, 'diag.jsonl');
      activeClient = spawnClient(userData4);
      const seq4 = [
        ['config-loaded', (l) => l.hasServerUrl === true],
        'app-window',
        'load-failed', // 포트 1은 Chromium unsafe port — 실측 errorCode -312(ERR_UNSAFE_PORT). 코드 값은 고정하지 않는다.
        ['local-window', (l) => l.page === 'error'],
        ['ipc', (l) => l.channel === 'getState' && l.trusted === true],
      ];
      const r4 = await waitForSequence(diagFile4, seq4, opts.timeout);
      check('B-4: 도달불가 config→app-window→load-failed→오류 로컬 창→ipc{getState,true}', r4.ok,
        r4.ok ? '' : `missing=${r4.missing} events=[${r4.lines.map((l) => l.event).join(',')}]`);
      if (!r4.ok) {
        process.stderr.write(`--- scenario B-4 diag ---\n${r4.lines.map((l) => JSON.stringify(l)).join('\n')}\n--- client stderr ---\n${activeClient._err}\n`);
      }
      notes.push('note B: probe{ok:false}는 자동 미검증 — 프로브는 사용자 버튼 클릭에만 발생하는 설계(ADR-008)라 이 경로에 남지 않는다.');
      assertProfileArtifacts('B-4:', userData4);
      await killChild(activeClient);
      activeClient = null;
    }

    // 실사용자 %APPDATA%\기사작성기 무변 — 변했으면 부팅 순서(userData 지정→잠금)가 뒤집혔다는 신호다.
    const appDataAfter = appDataSnapshot();
    if (appDataBefore.available && appDataAfter.available) {
      check('실사용자 %APPDATA%\\기사작성기 무변', appDataUnchanged(appDataBefore, appDataAfter),
        `before=${JSON.stringify({ exists: appDataBefore.exists, config: appDataBefore.config })} after=${JSON.stringify({ exists: appDataAfter.exists, config: appDataAfter.config })}`);
    }
  } catch (err) {
    failures.push(String(err && err.message ? err.message : err));
  } finally {
    await killChild(activeClient);
    await killChild(serverChild);
    if (!opts.keep) {
      // 임시 디렉토리만 정리한다 — 이 스크립트는 자신이 만든 임시 경로 밖의 어떤 파일도 지우지 않는다.
      for (const dir of tmpDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (err) {
          notes.push(`warn 임시 디렉토리 정리 실패(무해 — Windows 파일 잠금): ${dir} (${err && err.code})`);
        }
      }
    } else {
      notes.push(`keep 임시 디렉토리 보존: ${tmpDirs.join(', ')}`);
    }
  }

  const mode = opts.dev ? 'dev' : `exe(${opts.exe})`;
  if (failures.length === 0) {
    process.stdout.write([
      `verify-client-ok mode=${mode} scenario=${opts.scenario} elapsed=${Date.now() - startedAt}ms`,
      ...notes.map((n) => `  ${n}`),
    ].join('\n') + '\n');
    process.exit(0);
  }
  process.stderr.write([
    `verify-client-FAILED (${failures.length}건) mode=${mode} scenario=${opts.scenario}`,
    ...failures.map((f) => `  - ${f}`),
    '--- notes ---',
    ...notes.map((n) => `  ${n}`),
  ].join('\n') + '\n');
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`verify-client 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
