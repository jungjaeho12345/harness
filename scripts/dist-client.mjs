// 클라이언트 포터블 폴더 조립 파이프라인 (phase 62 step3) — 패키저 없이 직접 조립한다(decisions (5)).
// 사용: node scripts/dist-client.mjs [--out <dir>] [--name <exe>] [--no-meta]
// 산출: dist/기사작성기/ = Electron 런타임 전체 복사 + electron.exe→기사작성기.exe rename +
//   resources/default_app.asar 제거 + resources/app/에 client/** 화이트리스트 배치 + packaging/client/** 사본.
// CRITICAL(배포물 위생): resources/app에는 화이트리스트(client/package.json·*.js·preload.cjs·lib·pages)만
//   들어간다. server/·src/·test/·docs/(news.md 포함)·phases/·node_modules/·web/·news.db(-wal)·.env·uploads/는
//   어떤 경로로도 들어가면 안 된다 — 기자 PC 수십 대로 복사되면 회수가 불가능하다. 조립 후 재귀 스캔
//   게이트가 이중으로 잠근다(화이트리스트 + 스캔 + AC의 집합 비교 = 삼중).
// 참고(데이터 보존): 클라이언트 배포 폴더에는 사용자 데이터가 없다 — 설정은 %APPDATA% 아래
//   '기사작성기'(사용자 영역)라서, 서버 dist의 data/ 보존 규칙에 해당하는 대상이 이 폴더에는 없다.
// 주의: scripts/**는 eslint ignore 대상이다 — 안전망은 인자 가드와 AC 실행 프로브뿐이다.

import fs from 'node:fs';
import nodePath from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { toVersionQuad, buildClientVersionStrings, applyPeMeta, readPeMeta } from './lib/exeMeta.mjs';
import { flagValue } from './lib/cliArgs.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const CLIENT_DIR = nodePath.join(REPO_ROOT, 'client');
const PACKAGING_DIR = nodePath.join(REPO_ROOT, 'packaging', 'client');
const ICON_FILE = nodePath.join(REPO_ROOT, 'packaging', 'icon', 'app.ico'); // 커밋 산출물 — 빌드 시점 생성 의존 0.
const FALLBACK_EXE = 'article-client.exe';

function fail(msg) {
  return new Error(`[dist-client] ${msg}`);
}

// resources/app 화이트리스트 — 이 목록 밖의 무엇도 복사하지 않는다(AC가 집합 비교로 재검증).
const APP_WHITELIST = ['package.json', 'main.js', 'menu.js', 'ipcGuard.js', 'diag.js', 'preload.cjs', 'lib', 'pages'];

// 조립 후 재귀 스캔에서 발견되면 즉시 실패하는 금지 패턴(이름 단위).
const FORBIDDEN_NAMES = new Set(['news.db', '.env', 'docs', 'server', 'src', 'test', 'phases', 'node_modules', 'default_app.asar', 'uploads', 'web']);

function scanForbidden(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = nodePath.join(dir, entry.name);
    if (FORBIDDEN_NAMES.has(entry.name) || /\.db-wal$/.test(entry.name) || /\.db-journal$/.test(entry.name)) {
      found.push(p);
    }
    if (entry.isDirectory()) scanForbidden(p, found);
  }
  return found;
}

export async function distClient({
  outDir = 'dist/기사작성기',
  exeName = '기사작성기.exe',
  applyMeta = true, // false는 --no-meta 명시 우회(디버깅용)뿐이다 — 기본은 fail-fast 적용.
} = {}) {
  const startedAt = Date.now();
  const absOut = nodePath.resolve(outDir);
  const distRoot = nodePath.resolve(REPO_ROOT, 'dist');
  // 1. 경로 가드 — dist/ 하위가 아니면 즉시 거부(삭제 로직보다 반드시 먼저다. --out 오타 방어).
  if (!absOut.startsWith(distRoot + nodePath.sep)) {
    throw fail(`outDir는 dist/ 하위여야 한다: ${absOut}`);
  }

  // 2. Electron 런타임 해석 — 경로 하드코딩 금지. npm 패키지 위치에서 dist/를 잡는다.
  const require2 = createRequire(import.meta.url);
  let electronPkgDir;
  try {
    electronPkgDir = nodePath.dirname(require2.resolve('electron/package.json'));
  } catch {
    throw fail('electron 패키지를 찾을 수 없다 — npm install로 devDependency를 설치하라.');
  }
  const runtimeDir = nodePath.join(electronPkgDir, 'dist');
  const runtimeExe = nodePath.join(runtimeDir, 'electron.exe');
  if (!fs.existsSync(runtimeExe)) {
    throw fail(`electron 런타임이 없다 — npm install로 내려받아야 한다: ${runtimeExe}`);
  }
  const electronVersion = JSON.parse(fs.readFileSync(nodePath.join(electronPkgDir, 'package.json'), 'utf8')).version;

  // 3. 정리 — outDir가 이미 있으면 "이 스크립트의 산출물"일 때만 비운다(판정 실패 시 삭제하지 않고 실패).
  if (fs.existsSync(absOut) && fs.readdirSync(absOut).length > 0) {
    const looksLikeOurs = fs.existsSync(nodePath.join(absOut, 'resources', 'app', 'package.json'))
      || fs.existsSync(nodePath.join(absOut, exeName))
      || fs.existsSync(nodePath.join(absOut, FALLBACK_EXE))
      || fs.existsSync(nodePath.join(absOut, 'electron.exe'));
    if (!looksLikeOurs) {
      throw fail(`outDir가 비어 있지 않고 이 스크립트의 산출물로 보이지 않는다 — 지우지 않고 중단한다: ${absOut}`);
    }
    fs.rmSync(absOut, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  // 4. 런타임 복사 — 전체(locales/·*.pak·*.dll·version·LICENSE 포함). 임의로 빼지 않는다:
  //    무엇이 필수인지 추측하면 다른 PC에서 기동 실패로 나타난다.
  fs.mkdirSync(absOut, { recursive: true });
  fs.cpSync(runtimeDir, absOut, { recursive: true });

  // 5. 실행 파일 이름 변경 — 한글 실패 시 ASCII 폴백(phase 61 step1의 rename 규율과 동형).
  let finalExeName = exeName;
  try {
    fs.renameSync(nodePath.join(absOut, 'electron.exe'), nodePath.join(absOut, exeName));
  } catch (err) {
    process.stderr.write(`[dist-client] 경고: 한글 exe rename 실패(${err && err.code}) — ASCII 폴백 ${FALLBACK_EXE} 사용\n`);
    fs.renameSync(nodePath.join(absOut, 'electron.exe'), nodePath.join(absOut, FALLBACK_EXE));
    finalExeName = FALLBACK_EXE;
  }

  // 5b. PE 메타 적용 (phase 63 step1) — 아이콘(커밋된 app.ico) + 버전·문자열(client/package.json 단일
  //     출처). 실패는 fail-fast다: 조용히 Electron 기본 메타("GitHub, Inc.")로 배포되는 것이 최악이다.
  //     resedit 재생성은 Authenticode 서명을 제거하지만 이 프로젝트는 미서명 배포라 손실이 없다(ADR-011).
  let metaApplied = false;
  let fileVersion = null;
  let iconEntries = null;
  let metaMs = null;
  if (applyMeta) {
    const metaStart = Date.now();
    const resedit = await import('resedit');
    if (!fs.existsSync(ICON_FILE)) {
      throw fail(`아이콘 파일이 없다(커밋 산출물): ${ICON_FILE} — npm run make:icon 실행 후 커밋하라.`);
    }
    const clientVersion = JSON.parse(fs.readFileSync(nodePath.join(CLIENT_DIR, 'package.json'), 'utf8')).version;
    const exePath = nodePath.join(absOut, finalExeName);
    const strings = buildClientVersionStrings({ version: clientVersion, exeName: finalExeName }); // ASCII 폴백 시 OriginalFilename도 실제 이름.
    const applied = applyPeMeta({
      resedit,
      exeBuffer: fs.readFileSync(exePath),
      icoBuffer: fs.readFileSync(ICON_FILE),
      version: clientVersion,
      strings,
    });
    fs.writeFileSync(exePath, applied.buffer);
    // 적용 직후 read-back 검증 — 하나라도 어긋나면 빌드 실패(경고 후 계속 금지).
    const back = readPeMeta({ resedit, exeBuffer: fs.readFileSync(exePath) });
    const expectedVersion = toVersionQuad(clientVersion).join('.');
    if (back.iconEntries !== applied.iconCount) {
      throw fail(`meta read-back 실패: 아이콘 항목 수 expected=${applied.iconCount} actual=${back.iconEntries}`);
    }
    if (back.fileVersion !== expectedVersion) {
      throw fail(`meta read-back 실패: FileVersion expected=${expectedVersion} actual=${back.fileVersion}`);
    }
    if (back.productName !== strings.ProductName) {
      throw fail(`meta read-back 실패: ProductName expected=${strings.ProductName} actual=${back.productName}`);
    }
    metaApplied = true;
    fileVersion = back.fileVersion;
    iconEntries = back.iconEntries;
    metaMs = Date.now() - metaStart;
  } else {
    process.stderr.write('[dist-client] 경고: --no-meta 지정 — PE 메타(아이콘·버전) 미적용 배포물이다(디버깅 전용).\n');
  }

  // 6. 앱 코드 배치 — default_app.asar 제거 후 화이트리스트만 복사.
  const resourcesDir = nodePath.join(absOut, 'resources');
  fs.rmSync(nodePath.join(resourcesDir, 'default_app.asar'), { force: true });
  const appDir = nodePath.join(resourcesDir, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const name of APP_WHITELIST) {
    const src = nodePath.join(CLIENT_DIR, name);
    if (!fs.existsSync(src)) throw fail(`화이트리스트 항목이 client/에 없다: ${src}`);
    fs.cpSync(src, nodePath.join(appDir, name), { recursive: true });
  }
  const appEntries = fs.readdirSync(appDir).sort();

  // 7. packaging/client/** 사본 — 목록 하드코딩 금지(step4의 배포 가이드가 자동 포함되게).
  if (fs.existsSync(PACKAGING_DIR)) {
    for (const name of fs.readdirSync(PACKAGING_DIR)) {
      fs.cpSync(nodePath.join(PACKAGING_DIR, name), nodePath.join(absOut, name), { recursive: true });
    }
  } else {
    process.stderr.write(`[dist-client] 경고: packaging/client/ 가 없다 — 배포 가이드 미동봉(step4에서 생성 예정): ${PACKAGING_DIR}\n`);
  }

  // 8. 위생 게이트 — 화이트리스트 복사의 이중 안전장치. 하나라도 걸리면 실패.
  const forbidden = scanForbidden(absOut);
  if (forbidden.length > 0) {
    throw fail(`배포 폴더에 금지 항목이 있다:\n  ${forbidden.join('\n  ')}`);
  }

  // 9. 요약.
  let fileCount = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else { fileCount += 1; bytes += fs.statSync(p).size; }
    }
  };
  walk(absOut);
  const summary = {
    outDir: absOut,
    exeName: finalExeName,
    electronVersion,
    appEntries,
    fileCount,
    bytes,
    metaApplied,
    fileVersion,
    iconEntries,
    metaMs,
    elapsedMs: Date.now() - startedAt,
  };
  process.stdout.write(`[dist-client] 완료 exe=${finalExeName} electron=${electronVersion} files=${fileCount} bytes=${bytes} (${(bytes / 1024 / 1024).toFixed(1)}MB) metaApplied=${metaApplied} fileVersion=${fileVersion} iconEntries=${iconEntries} app=[${appEntries.join(', ')}] out=${absOut} (${summary.elapsedMs}ms)\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

// --- CLI ---
function parseArgs(argv) {
  const usage = '사용법: node scripts/dist-client.mjs [--out <dir>] [--name <exe>] [--no-meta]';
  // 값 플래그는 flagValue(순수 판정 — missing/empty/flag-like)로 fail-fast(phase 64 step0).
  const takeValue = (i, flag) => {
    const v = flagValue(argv, i, flag);
    if (!v.ok) {
      process.stderr.write(`${v.message}\n${usage}\n`);
      process.exit(1);
    }
    return v.value;
  };
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') { opts.outDir = takeValue(i, '--out'); i += 1; }
    else if (a === '--name') { opts.exeName = takeValue(i, '--name'); i += 1; }
    else if (a === '--no-meta') opts.applyMeta = false; // 명시 우회만 허용(디버깅용) — 기본은 적용.
    else {
      process.stderr.write(`알 수 없는 인자: ${a}\n${usage}\n`);
      process.exit(1);
    }
  }
  return opts;
}

const invokedAsCli = process.argv[1] && nodePath.resolve(process.argv[1]) === SCRIPT_PATH;
if (invokedAsCli) {
  distClient(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`[dist-client] 실패: ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
}
