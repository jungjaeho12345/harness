// 임시 앱 아이콘 생성 CLI (phase 63 step1) — 산출물 packaging/icon/app.ico는 리포에 커밋한다.
// 사용: node scripts/make-icon.mjs [--out <path>] [--check]
//  - 기본: buildIcoBuffer() 결과를 --out(기본 packaging/icon/app.ico)에 쓴다.
//  - --check: 파일을 쓰지 않고 재생성 결과와 기존 파일의 sha256을 비교한다(다르면 exit 1 — 드리프트 잠금).
// 빌드(dist-client)는 커밋된 파일만 읽는다 — 빌드 시점 생성 의존 0. 정식 아이콘이 생기면 같은 경로의
// 파일만 교체하면 되고, 그때 --check 게이트와 test/exe-branding.test.js의 동일성 잠금도 함께 손봐야 한다.
// 주의: scripts/**는 eslint ignore 대상이다 — 인자 가드가 유일한 정적 안전망이다.

import fs from 'node:fs';
import nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildIcoBuffer } from './lib/icoBuilder.mjs';
import { flagValue } from './lib/cliArgs.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const DEFAULT_OUT = nodePath.join(REPO_ROOT, 'packaging', 'icon', 'app.ico');

const USAGE = `사용법: node scripts/make-icon.mjs [--out <path>] [--check]
  --out <path>  출력 경로(기본 packaging/icon/app.ico).
  --check       쓰지 않고 재생성 결과와 기존 파일의 sha256 일치를 검사한다(불일치·부재 = exit 1).`;

function die(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  // 값 플래그는 flagValue(순수 판정 — missing/empty/flag-like)로 fail-fast(phase 64 step0, 65 step3 결선).
  const takeValue = (i, flag) => {
    const v = flagValue(argv, i, flag);
    if (!v.ok) die(v.message);
    return v.value;
  };
  const opts = { out: DEFAULT_OUT, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') { opts.out = takeValue(i, '--out'); i += 1; }
    else if (a === '--check') opts.check = true;
    else die(`알 수 없는 인자: ${a}`);
  }
  opts.out = nodePath.resolve(opts.out);
  return opts;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const opts = parseArgs(process.argv.slice(2));
const generated = buildIcoBuffer();

if (opts.check) {
  if (!fs.existsSync(opts.out)) {
    process.stderr.write(`[make-icon] 검사 실패: 파일이 없다 — ${opts.out}\n`);
    process.exit(1);
  }
  const existing = fs.readFileSync(opts.out);
  const same = sha256(existing) === sha256(generated);
  if (!same) {
    process.stderr.write(`[make-icon] 드리프트: 커밋본(${existing.length}B)과 재생성(${generated.length}B)의 sha256이 다르다 — node scripts/make-icon.mjs로 갱신 후 커밋하라.\n`);
    process.exit(1);
  }
  process.stdout.write(`[make-icon] check ok sha256=${sha256(generated)} bytes=${generated.length} out=${opts.out}\n`);
  process.exit(0);
}

fs.mkdirSync(nodePath.dirname(opts.out), { recursive: true });
fs.writeFileSync(opts.out, generated);
process.stdout.write(`[make-icon] written bytes=${generated.length} sha256=${sha256(generated)} out=${opts.out}\n`);
