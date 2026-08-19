// Node↔Spring 이중 실행 패리티 오케스트레이터 (phase 68 step1) — auth/session 슬라이스 최종 게이트.
// 존재 이유: 큐레이션된 계약 케이스 집합을 **프로파일마다 새 프로세스**로 Node·Spring 각각에 돌려
//   리포트 2개를 만들고 scripts/contract-diff.mjs의 compareReports로 프로파일별 diff를 낸다.
//   하나라도 diff>0이거나 러너가 실패(exit≠0)하면 exit 1. 전부 diff 0이면 exit 0(= 패리티 green).
// 규율:
//  - 러너(contract-run.mjs)가 대상 서버 수명을 소유한다 — 이 스크립트는 러너를 spawn만 한다(서버 직접 접근 금지).
//  - 리포트는 OS 임시 디렉토리에만 쓴다(리포 오염 0). 성패와 무관하게 확인 후 삭제하도록 경로를 알린다.
//  - 러너 --files는 전역 적용이라 **프로파일당 별도 러너 실행**(--profile <p> --files <그 프로파일 파일들>)으로 부른다
//    (한 실행에 여러 프로파일+파일을 섞으면 requireProfile 불일치로 죽는다). 각 실행이 프로파일당 새 프로세스다.
//  - 비교 규칙은 contract-diff.mjs를 재사용한다(값 비우기·비교 끄기 금지 — 거짓 green 방지).
// 사용: node scripts/contract-parity-spring.mjs [--keep] [--timeout <ms>]

import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareReports, formatDiffLines } from './contract-diff.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const RUNNER = nodePath.join(REPO_ROOT, 'scripts', 'contract-run.mjs');

// 큐레이션 집합(정본 — phase 68 scope). 프로파일당 파일 목록.
// default는 login/session/guard가 완성되는 step4~6에서 green이 된다.
const CURATION = [
  {
    profile: 'default',
    files: [
      'contract/cases/default/health.contract.js',
      'contract/cases/default/auth.contract.js',
      'contract/cases/default/session-guard.contract.js',
    ],
  },
  { profile: 'auth-negative', files: ['contract/cases/auth-negative/login-negative.contract.js'] },
  { profile: 'prod-cookie', files: ['contract/cases/prod-cookie/cookie-prod.contract.js'] },
];

function parseArgs(argv) {
  const opts = { keep: false, timeout: 60000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') {
      const v = Number(argv[i + 1]);
      if (!Number.isInteger(v) || v < 1000) {
        process.stderr.write(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${argv[i + 1]}\n`);
        process.exit(1);
      }
      opts.timeout = v;
      i += 1;
    } else {
      process.stderr.write(`알 수 없는 인자: ${a}\n`);
      process.exit(1);
    }
  }
  return opts;
}

// 러너 1회 실행(프로파일 하나, 대상 하나) → --out 리포트. exit 코드를 반환한다.
function runOnce(target, profile, files, outFile, timeout) {
  return new Promise((resolve) => {
    const args = [
      RUNNER, '--target', target, '--profile', profile,
      '--files', files.join(','), '--out', outFile, '--timeout', String(timeout),
    ];
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('close', (code) => resolve(code === null ? 1 : code));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'contract-parity-spring-'));
  const failures = [];
  const summaries = [];
  let totalDiffs = 0;

  for (const { profile, files } of CURATION) {
    const nodeOut = nodePath.join(dir, `node-${profile}.json`);
    const springOut = nodePath.join(dir, `spring-${profile}.json`);

    process.stdout.write(`\n=== [${profile}] Node 실행 ===\n`);
    const nodeCode = await runOnce('node', profile, files, nodeOut, opts.timeout);
    process.stdout.write(`\n=== [${profile}] Spring 실행 ===\n`);
    const springCode = await runOnce('spring', profile, files, springOut, opts.timeout);

    if (nodeCode !== 0) failures.push(`[${profile}] Node 러너 실패(exit=${nodeCode})`);
    if (springCode !== 0) failures.push(`[${profile}] Spring 러너 실패(exit=${springCode})`);
    if (!fs.existsSync(nodeOut) || !fs.existsSync(springOut)) {
      failures.push(`[${profile}] 리포트 누락 node=${fs.existsSync(nodeOut)} spring=${fs.existsSync(springOut)}`);
      continue;
    }

    const nodeReport = JSON.parse(fs.readFileSync(nodeOut, 'utf8'));
    const springReport = JSON.parse(fs.readFileSync(springOut, 'utf8'));
    const result = compareReports(nodeReport, springReport);
    const lines = formatDiffLines(result);
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    totalDiffs += result.diffCount;
    summaries.push(`  [${profile}] observations=${result.observationCount} diffs=${result.diffCount}`);
    if (result.diffCount > 0) failures.push(`[${profile}] contract-diff ${result.diffCount}건 — Node↔Spring 동작이 갈렸다.`);
  }

  const ok = failures.length === 0;
  process.stdout.write('\ncontract-parity-spring 요약:\n');
  for (const s of summaries) process.stdout.write(`${s}\n`);
  process.stdout.write(`  (리포트는 OS 임시 디렉토리에만 쓴다 — 확인 후 ${dir}를 삭제하라)\n`);

  if (ok && !opts.keep) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 무해 */ }
  }
  if (!ok) process.stderr.write(`${failures.map((f) => `FAIL ${f}`).join('\n')}\n`);
  process.stdout.write(
    `contract-parity-spring ${ok ? 'ok' : 'FAILED'} profiles=${CURATION.length} totalDiffs=${totalDiffs}\n`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`contract-parity-spring 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
