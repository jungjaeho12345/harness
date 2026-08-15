// 배포 폴더 조립 파이프라인 (phase 61 step2) — vite build → 서버 exe 빌드(step1 모듈 재사용) → 조립.
// 사용: node scripts/dist-server.mjs [--out <dir>] [--skip-web] [--fallback]
// 산출: dist/기사작성기-server/ = exe + web/(vite 산출물) + data/(빈 골격) + packaging/server/** 사본.
// CRITICAL(DB 비파괴): <outDir>/data/ 는 절대 삭제하지 않는다 — 운영자가 news.db를 복사해 두고
//   재빌드하는 흐름이 실재한다. 정리는 알려진 산출물(실행 파일·web/·packaging 사본)로만 한다.
// CRITICAL(배포물 위생): news.db(-wal/-journal)·.env·리포 uploads/·node_modules/·src/·test/·docs/·
//   phases/·.git 은 어떤 경로로도 배포 폴더에 들어가지 않는다 — 이 스크립트는 명시된 산출물만 복사한다.
// 주의: scripts/**는 eslint ignore 대상이다 — 안전망은 AC 실행 프로브와 인자 가드뿐이다.

import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServerExe } from './sea-build.mjs';
import { flagValue } from './lib/cliArgs.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const PACKAGING_DIR = nodePath.join(REPO_ROOT, 'packaging', 'server');
const WEB_DIST = nodePath.join(REPO_ROOT, 'web', 'dist');

function fail(msg) {
  return new Error(`[dist-server] ${msg}`);
}

// 시작 bat 부적합 경고 (phase 64 step1 A-4 + 게이트 확장) — 순수 함수(test/dist-server-fallback.test.js가 잠근다).
// 동봉 기사작성기-server.bat은 "%~dp0기사작성기-server.exe"를 실행한다 — 그 이름의 exe가 배포 폴더에
// 없는 두 경로에서 운영자가 bat을 눌러도 기동하지 않는다: (1) --fallback(node-bundled)은 exe 대신
// node.exe+server-bundle.cjs를 배포하고, (2) SEA라도 한글 rename 실패 시 ASCII 폴백 이름이 된다.
// 경고는 stdout 1줄이며 실패로 승격하지 않는다(둘 다 명시 플래그/알려진 폴백으로만 도달하는 의도된 경로다).
const BAT_TARGET_EXE = '기사작성기-server.exe';
export function startupWarning({ mode, exeBasename } = {}) {
  if (mode === 'node-bundled') {
    return `[dist-server] 경고: 폴백(node-bundled) 배포물이다 — 동봉 .bat은 ${BAT_TARGET_EXE}를 실행하므로 이 폴더에서는 기동하지 않는다. 대신 node.exe server-bundle.cjs 로 실행하라.`;
  }
  if (typeof exeBasename === 'string' && exeBasename !== BAT_TARGET_EXE) {
    return `[dist-server] 경고: 동봉 .bat은 ${BAT_TARGET_EXE}를 실행하는데 실제 실행 파일 이름은 ${exeBasename}이다 — exe를 ${BAT_TARGET_EXE}로 rename하거나 .bat의 실행 줄을 그 이름으로 고쳐라.`;
  }
  return null;
}

export async function distServer({
  outDir = 'dist/기사작성기-server',
  skipWeb = false,   // 직전 web/dist 재사용(반복 실행 시간 단축)
  fallback = false,  // buildServerExe로 그대로 전달(기본 fail-fast — step1과 동일 규율)
} = {}) {
  const startedAt = Date.now();
  const absOut = nodePath.resolve(outDir);
  const distRoot = nodePath.resolve(REPO_ROOT, 'dist');
  // 가드 — dist/ 하위가 아니면 즉시 거부(임의 경로 삭제 방지). 삭제 로직보다 반드시 먼저다.
  if (!absOut.startsWith(distRoot + nodePath.sep)) {
    throw fail(`outDir는 dist/ 하위여야 한다: ${absOut}`);
  }

  // 1. 선택적 정리 — 통삭제(rmSync(outDir, recursive)) 금지. 알려진 산출물만 지운다.
  //    <outDir>/data/ 는 삭제 대상에서 제외한다(위 CRITICAL — 내용이 있으면 그대로 보존).
  fs.mkdirSync(absOut, { recursive: true });
  const knownArtifacts = new Set(['web', 'node.exe', 'server-bundle.cjs', '기사작성기-server.exe', 'article-server.exe']);
  if (fs.existsSync(PACKAGING_DIR)) {
    for (const name of fs.readdirSync(PACKAGING_DIR)) knownArtifacts.add(name); // .bat·README-배포.md 등
  }
  for (const name of knownArtifacts) {
    if (name === 'data') continue; // 방어 — data/가 목록에 끼어들 경로는 없지만 원칙을 코드로 잠근다.
    fs.rmSync(nodePath.join(absOut, name), { recursive: true, force: true });
  }
  const dataDir = nodePath.join(absOut, 'data');
  const skeletonDirs = new Set(['uploads', 'rcv-spool', 'dist-spool']);
  const dataHasContent = fs.existsSync(dataDir) && fs.readdirSync(dataDir).some((n) => {
    if (!skeletonDirs.has(n)) return true; // news.db 등 골격 외 항목 = 데이터.
    const p = nodePath.join(dataDir, n);
    return fs.statSync(p).isDirectory() ? fs.readdirSync(p).length > 0 : true;
  });
  if (dataHasContent) {
    process.stdout.write(`[dist-server] 경고: ${dataDir} 가 비어 있지 않다 — 배포물에 데이터가 섞여 나갈 수 있다(보존됨).\n`);
  }

  // 2. SPA 빌드 — vite JS API(셸/npm.cmd spawn은 플랫폼 의존이라 쓰지 않는다). 산출: web/dist/.
  if (!skipWeb) {
    const { build } = await import('vite');
    await build({ root: nodePath.join(REPO_ROOT, 'web'), logLevel: 'warn' });
  }
  if (!fs.existsSync(nodePath.join(WEB_DIST, 'index.html'))) {
    throw fail(`web/dist/index.html이 없다 — vite build가 실패했거나 --skip-web인데 직전 산출물이 없다: ${WEB_DIST}`);
  }

  // 3. 서버 실행 파일 — step1 모듈 재사용(빌드 절차를 여기서 재구현하지 않는다 — 단일 출처).
  const exeResult = await buildServerExe({ outDir: 'dist/server-exe', fallback });
  const copied = [];
  for (const f of exeResult.files) {
    const dest = nodePath.join(absOut, nodePath.basename(f));
    fs.copyFileSync(f, dest);
    copied.push(dest);
  }

  // 4. 조립.
  fs.cpSync(WEB_DIST, nodePath.join(absOut, 'web'), { recursive: true });
  for (const d of [dataDir, nodePath.join(dataDir, 'uploads'), nodePath.join(dataDir, 'rcv-spool'), nodePath.join(dataDir, 'dist-spool')]) {
    fs.mkdirSync(d, { recursive: true }); // 이미 있으면 no-op — 내용은 건드리지 않는다.
  }
  // packaging/server/** 전체를 루트로 복사 — 목록 하드코딩 금지(step3의 README-배포.md가 자동 포함된다).
  if (!fs.existsSync(PACKAGING_DIR)) throw fail(`packaging/server/ 가 없다: ${PACKAGING_DIR}`);
  for (const name of fs.readdirSync(PACKAGING_DIR)) {
    fs.cpSync(nodePath.join(PACKAGING_DIR, name), nodePath.join(absOut, name), { recursive: true });
    copied.push(nodePath.join(absOut, name));
  }

  // 4b. 시작 bat 부적합 경고 — mode·최종 exe 이름이 확정된 지점(요약 직전). 실패 승격 금지.
  const batWarning = startupWarning({ mode: exeResult.mode, exeBasename: nodePath.basename(exeResult.exe) });
  if (batWarning) process.stdout.write(`${batWarning}\n`);

  // 5. 요약.
  const files = fs.readdirSync(absOut);
  const bytes = copied.reduce((sum, f) => sum + (fs.statSync(f).isFile() ? fs.statSync(f).size : 0), 0);
  const summary = {
    outDir: absOut,
    mode: exeResult.mode,
    files,
    bytes,
    nodeVersion: exeResult.nodeVersion,
    elapsedMs: Date.now() - startedAt,
  };
  process.stdout.write(`[dist-server] 완료 mode=${summary.mode} files=[${files.join(', ')}] bytes=${bytes} out=${absOut} (${summary.elapsedMs}ms)\n`);
  return summary;
}

// --- CLI ---
function parseArgs(argv) {
  const usage = '사용법: node scripts/dist-server.mjs [--out <dir>] [--skip-web] [--fallback]';
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
    else if (a === '--skip-web') { opts.skipWeb = true; }
    else if (a === '--fallback') { opts.fallback = true; }
    else {
      process.stderr.write(`알 수 없는 인자: ${a}\n${usage}\n`);
      process.exit(1);
    }
  }
  return opts;
}

const invokedAsCli = process.argv[1] && nodePath.resolve(process.argv[1]) === SCRIPT_PATH;
if (invokedAsCli) {
  distServer(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0)) // vite build가 남긴 워커 핸들이 프로세스를 붙잡지 않게 명시 종료.
    .catch((err) => {
      process.stderr.write(`[dist-server] 실패: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
