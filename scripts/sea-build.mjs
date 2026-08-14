// 서버 exe 빌드 (phase 61 step1) — esbuild 단일 CJS 번들 → SEA blob → postject 주입.
// 사용: node scripts/sea-build.mjs [--out <dir>] [--name <exe>] [--fallback]
//  - 기본은 fail-fast다: SEA 단계(blob·주입·rename) 실패 시 --fallback 플래그가 있을 때만
//    node.exe 동봉(mode: 'node-bundled')으로 내려간다. 자동 폴백 금지 — SEA 실패가 조용히 묻힌다.
//  - 산출물은 dist/ 하위로만 쓴다(outDir 가드 — 임의 경로 삭제 사고 방지).
//  - 한글 exe 파일명은 마지막 rename으로만 만든다 — 도구 체인(SEA/postject)은 ASCII 임시 경로에서 돈다.
// 주의: scripts/**는 eslint ignore 대상이다 — 이 스크립트의 안전망은 AC 실행 프로브와 인자 가드뿐이다.

import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { toVersionQuad, buildServerVersionStrings, applyPeMeta, readPeMeta } from './lib/exeMeta.mjs';

// 빌드 전용 스크립트라 import.meta 사용이 안전하다(SEA 번들 대상이 아니다 — server/**와 규율이 다르다).
const require = createRequire(import.meta.url);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
// Node 공식 SEA 문서의 sentinel fuse 상수 — 추측으로 바꾸지 마라(주입 실패 시 설치 Node 버전 문서 확인).
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function fail(step, detail) {
  const err = new Error(`[sea-build] ${step} 실패: ${detail}`);
  err.step = step;
  return err;
}

// 자식 커맨드 실행 — 실패 시 어떤 커맨드가 무슨 코드로 실패했는지 stderr에 남긴다(조용한 실패 금지).
function run(step, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error || r.status !== 0) {
    const detail = r.error ? String(r.error) : `exit=${r.status}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    process.stderr.write(`[sea-build] 커맨드 실패 (${step}): ${cmd} ${args.join(' ')}\n${detail}\n`);
    throw fail(step, detail.slice(0, 2000));
  }
  return r;
}

// esbuild 번들 1회 — 경고 게이트를 공유한다(empty-import-meta 정확히 1건만 허용, 그 외 경고는 실패).
async function bundleOnce({ entry, outfile }) {
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${process.versions.node.split('.')[0]}`,
    minify: false,
    sourcemap: false,
    logLevel: 'silent', // 경고는 아래에서 직접 판정·출력한다(허용/차단을 코드로 잠근다).
  });
  const warnings = result.warnings.map((w) => `${w.id ?? ''}: ${w.text} (${w.location?.file ?? '?'}:${w.location?.line ?? '?'})`);
  const emptyImportMeta = result.warnings.filter((w) => w.id === 'empty-import-meta');
  const others = result.warnings.filter((w) => w.id !== 'empty-import-meta');
  if (others.length > 0) {
    // 특히 비내장 동적 require 계열은 SEA 런타임에서 throw한다 — 조용히 넘기면 배포 후에 터진다.
    throw fail('bundle-warnings', `허용되지 않은 esbuild 경고 ${others.length}건:\n${others.map((w) => `${w.id}: ${w.text}`).join('\n')}`);
  }
  if (emptyImportMeta.length !== 1) {
    // step0 계약: import.meta 참조는 server/index.js 모듈 스코프 selfUrl 1곳뿐(경고 정확히 1건).
    // 2건 이상이면 step0 계약이 깨진 것이다 — 여기서 고치지 말고 실패시킨다(server/index.js는 step0 소유).
    throw fail('bundle-import-meta-gate', `empty-import-meta 경고가 정확히 1건이어야 하는데 ${emptyImportMeta.length}건이다:\n${warnings.join('\n')}`);
  }
  return warnings;
}

export async function buildServerExe({
  entry = 'server/main.js',
  outDir = 'dist/server-exe',
  exeName = '기사작성기-server.exe',
  fallback = false, // true여야만 폴백(node.exe 동봉)으로 내려간다 — 기본 fail-fast.
} = {}) {
  const absOut = nodePath.resolve(outDir);
  const distRoot = nodePath.resolve('dist');
  // outDir 가드 — dist/ 하위가 아니면 거부한다(정리 로직이 임의 경로를 지우는 사고 방지).
  if (absOut !== distRoot && !absOut.startsWith(distRoot + nodePath.sep)) {
    throw fail('outdir-guard', `outDir는 dist/ 하위여야 한다: ${absOut}`);
  }

  const startedAt = Date.now();
  const work = nodePath.join(absOut, 'work');
  // 정리는 작업공간과 알려진 산출 파일 범위로만 한다(통삭제 금지 — data/류 보존 원칙과 동형).
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  // 1. 번들: SEA는 단일 CJS 스크립트를 요구한다. 외부(external) 지정은 하지 않는다 —
  //    node 내장은 platform:'node'가 처리하고, 5개 런타임 의존성은 전부 번들에 포함되어야 한다.
  const bundleFile = nodePath.join(work, 'server-bundle.cjs');
  const warnings = await bundleOnce({ entry, outfile: bundleFile });

  // 2. 번들 스모크(로드 확인 전용): server/main.js 번들은 require 시 bootstrap()을 실행하므로
  //    직접 require하지 않는다(포트 점유·DB 생성이 "로드 실패"로 오진된다). 대신 자동 실행되지 않는
  //    server/index.js를 같은 옵션으로 번들해 export 존재를 종료 코드로만 판정한다.
  const loadcheckFile = nodePath.join(work, 'loadcheck.cjs');
  await bundleOnce({ entry: 'server/index.js', outfile: loadcheckFile });
  const probeCwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sea-loadcheck-'));
  run('bundle-loadcheck', process.execPath, [
    '-e',
    `const m=require(${JSON.stringify(loadcheckFile)}); if(typeof m.bootstrap!=='function'||typeof m.createApp!=='function') process.exit(3);`,
  ], { cwd: probeCwd });

  const files = [];
  let mode = 'sea';
  let exe;
  let signtool = 'skipped';
  let meta = { metaApplied: false, fileVersion: null, iconEntries: null };

  try {
    // 3. SEA blob 생성.
    const seaConfig = nodePath.join(work, 'sea-config.json');
    const blobFile = nodePath.join(work, 'sea-prep.blob');
    fs.writeFileSync(seaConfig, JSON.stringify({
      main: bundleFile,
      output: blobFile,
      disableExperimentalSEAWarning: true, // 없으면 운영자가 매 기동마다 실험 기능 경고를 본다.
      useSnapshot: false,
      useCodeCache: false, // Node 버전·플랫폼 조합의 실패 사례가 있어 false로 고정 시작.
    }, null, 2));
    run('sea-blob', process.execPath, ['--experimental-sea-config', seaConfig]);

    // 4. exe 골격 — 빌드 머신 node.exe 복사(ASCII 임시 이름 — decisions (12)).
    const buildExe = nodePath.join(work, 'app-build.exe');
    fs.copyFileSync(process.execPath, buildExe);

    // 4b. PE 메타 적용 (phase 63 step1 선택 D) — 반드시 postject 주입 "전"이다(주입 후 리소스 재작성은
    //     SEA blob 손상 위험 — decisions (9)). 값은 루트 package.json + 커밋된 app.ico 단일 출처.
    //     resedit 재생성이 기존 Authenticode 서명을 함께 제거하므로 아래 signtool 단계가
    //     remove-failed로 기록되는 것은 정상이다(미서명 배포 — ADR-011).
    {
      const resedit = await import('resedit');
      const repoRoot = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
      const icoFile = nodePath.join(repoRoot, 'packaging', 'icon', 'app.ico');
      if (!fs.existsSync(icoFile)) throw fail('pe-meta', `아이콘 파일이 없다(커밋 산출물): ${icoFile} — npm run make:icon 후 커밋하라.`);
      const rootVersion = JSON.parse(fs.readFileSync(nodePath.join(repoRoot, 'package.json'), 'utf8')).version;
      const strings = buildServerVersionStrings({ version: rootVersion, exeName });
      const applied = applyPeMeta({
        resedit,
        exeBuffer: fs.readFileSync(buildExe),
        icoBuffer: fs.readFileSync(icoFile),
        version: rootVersion,
        strings,
      });
      fs.writeFileSync(buildExe, applied.buffer);
      // 적용 직후 read-back 검증 — 어긋나면 빌드 실패(조용한 기본 메타 배포 금지).
      const back = readPeMeta({ resedit, exeBuffer: fs.readFileSync(buildExe) });
      const expectedVersion = toVersionQuad(rootVersion).join('.');
      if (back.iconEntries !== applied.iconCount || back.fileVersion !== expectedVersion || back.productName !== strings.ProductName) {
        throw fail('pe-meta-readback', `expected icons=${applied.iconCount} version=${expectedVersion} product=${strings.ProductName} / actual=${JSON.stringify(back)}`);
      }
      meta = { metaApplied: true, fileVersion: back.fileVersion, iconEntries: back.iconEntries };
    }

    // 5. 기존 서명 제거(있으면) — signtool 부재는 실패가 아니다(건너뛰고 기록만).
    const sign = spawnSync('signtool', ['remove', '/s', buildExe], { encoding: 'utf8' });
    if (sign.error) signtool = `absent (${sign.error.code ?? sign.error.message})`;
    else signtool = sign.status === 0 ? 'removed' : `remove-failed exit=${sign.status} (진행)`;

    // 6. postject 주입 — node_modules 경유 고정 실행(npx 금지: 네트워크·버전 비고정).
    const postjectCli = require.resolve('postject/dist/cli.js');
    run('postject-inject', process.execPath, [
      postjectCli, buildExe, 'NODE_SEA_BLOB', blobFile, '--sentinel-fuse', SEA_FUSE,
    ]);

    // 7. 최종 rename — 한글 이름은 파일시스템 rename 한 번으로만 만든다.
    exe = nodePath.join(absOut, exeName);
    fs.rmSync(exe, { force: true }); // 재실행 멱등 — 이전 산출 실행 파일만 교체한다(알려진 산출물).
    try {
      fs.renameSync(buildExe, exe);
    } catch (renameErr) {
      const asciiExe = nodePath.join(absOut, 'article-server.exe');
      process.stderr.write(`[sea-build] 한글 exe rename 실패(${renameErr?.message}) — ASCII 이름으로 폴백한다: ${asciiExe}\n`);
      fs.rmSync(asciiExe, { force: true });
      fs.renameSync(buildExe, asciiExe);
      exe = asciiExe;
    }
    files.push(exe);
  } catch (err) {
    if (!fallback) throw err; // fail-fast가 기본이다 — 폴백은 명시 플래그로만.
    process.stderr.write(`[sea-build] SEA 실패 → --fallback 지정으로 node.exe 동봉 모드로 전환한다: ${err.message}\n`);
    mode = 'node-bundled';
    const nodeCopy = nodePath.join(absOut, 'node.exe');
    const bundleCopy = nodePath.join(absOut, 'server-bundle.cjs');
    fs.rmSync(nodeCopy, { force: true });
    fs.rmSync(bundleCopy, { force: true });
    fs.copyFileSync(process.execPath, nodeCopy);
    fs.copyFileSync(bundleFile, bundleCopy);
    exe = nodeCopy;
    files.push(nodeCopy, bundleCopy);
  }

  const bytes = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  return {
    mode,
    exe,
    files,
    bytes,
    nodeVersion: process.version,
    warnings,
    signtool,
    ...meta, // metaApplied·fileVersion·iconEntries (phase 63 step1) — 기존 키는 제거·개명하지 않는다.
    elapsedMs: Date.now() - startedAt,
  };
}

// --- CLI ---
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') { opts.outDir = argv[++i]; }
    else if (a === '--name') { opts.exeName = argv[++i]; }
    else if (a === '--fallback') { opts.fallback = true; }
    else {
      process.stderr.write(`알 수 없는 인자: ${a}\n사용법: node scripts/sea-build.mjs [--out <dir>] [--name <exe>] [--fallback]\n`);
      process.exit(1);
    }
  }
  if ((opts.outDir !== undefined && !opts.outDir) || (opts.exeName !== undefined && !opts.exeName)) {
    process.stderr.write('--out/--name 값이 비어 있다.\n');
    process.exit(1);
  }
  return opts;
}

const invokedAsCli = process.argv[1] && nodePath.resolve(process.argv[1]) === SCRIPT_PATH;
if (invokedAsCli) {
  buildServerExe(parseArgs(process.argv.slice(2)))
    .then((result) => {
      // 마지막 줄에 결과 JSON 1줄 — step2가 import로 재사용하지만 사람이 눈으로도 확인한다.
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`[sea-build] 실패: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
