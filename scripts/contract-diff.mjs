// 계약 리포트 이중 실행 diff (phase 67 step12) — 두 리포트(스키마 B)를 기계 비교한다.
// 존재 이유: "같은 스위트를 두 서버(Node ↔ 68+ Spring)에 돌려 정규화 리포트가 동일한가"가
//   이중 실행 패리티의 유일한 기계 판정이다. 이 도구가 "항상 0"을 내면 그 판정이 거짓 green이 된다 —
//   그래서 비교는 느슨해지는 방향으로 고치지 않는다(값을 비우거나 bodyKeys 비교를 끄지 마라).
// 사용: node scripts/contract-diff.mjs <reportA.json> <reportB.json> [--json] [--max-diff <n>]
// 계약:
//  - 관측 매칭 키는 (profile, routeId, tag, caseId)다. 한쪽에만 있으면 only-in-A / only-in-B.
//  - 매칭된 관측은 status·ok·reason·bodyKeys·values·headers를 비교한다(values·headers는 키 단위로 좁혀 보고).
//  - **skipped는 어떤 관측과도 같지 않다**(decisions (12)) — 프로파일을 제공하지 않은 서버가
//    "차이 0"으로 통과하면 계약이 검증되지 않은 채 green이 된다. skipped-vs-observed로 드러낸다.
//  - meta.target(node|external)은 차이가 아니다 — 대상이 다른 것이 이 도구의 전제다.
//    meta.routeCount 차이는 인벤토리 판본이 다르다는 뜻이라 경고로 남긴다(판정에는 넣지 않는다).
// 구조: 비교 로직은 compareReports()로 export하고 CLI는 얇은 래퍼다 — 러너의 --dual-run이 같은 함수를
//   import한다(비교 규칙이 두 벌로 갈라지면 이중 실행 판정이 두 벌이 된다).
// 주의: scripts/**는 eslint ignore 대상이다 — 인자 가드(scripts/lib/cliArgs.mjs)가 유일한 정적 안전망이다.

import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagValue } from './lib/cliArgs.mjs';

const DEFAULT_MAX_DIFF = 50;
const ABSENT = '<absent>'; // 한쪽 values/headers에 키가 아예 없을 때의 표시(값 없음도 차이다).

const USAGE = `사용법: node scripts/contract-diff.mjs <reportA.json> <reportB.json> [--json] [--max-diff <n>]
  <reportA.json> <reportB.json>  계약 러너(--out)가 만든 리포트 2개(스키마 B).
  --json           차이 결과를 JSON으로 출력(기계 판독용 — 사람용 목록은 생략).
  --max-diff <n>   출력할 차이 개수 상한(기본 ${DEFAULT_MAX_DIFF}, 1 이상 정수). 총 개수는 잘리지 않는다.`;

// --- 비교 (재사용 함수 — 러너 --dual-run이 이것을 import한다) ---

export function observationKey(o) {
  return ['profile', 'routeId', 'tag', 'caseId'].map((k) => String(o?.[k] ?? '')).join('|');
}

const eq = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

function groupByKey(observations) {
  const map = new Map();
  for (const o of observations) {
    const key = observationKey(o);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(o);
  }
  return map;
}

// values·headers는 키 단위로 비교한다 — "어느 필드가 갈라졌는가"가 Spring 패리티 진단의 전부다.
function compareMapField(key, field, aObj, bObj, diffs) {
  const names = [...new Set([...Object.keys(aObj ?? {}), ...Object.keys(bObj ?? {})])].sort();
  for (const name of names) {
    const av = aObj && name in aObj ? aObj[name] : ABSENT;
    const bv = bObj && name in bObj ? bObj[name] : ABSENT;
    if (!eq(av, bv)) diffs.push({ type: `value-mismatch(${field}.${name})`, key, field: `${field}.${name}`, a: av, b: bv });
  }
}

function compareObservation(key, a, b, diffs) {
  for (const field of ['status', 'ok', 'reason']) {
    if (!eq(a?.[field], b?.[field])) diffs.push({ type: `value-mismatch(${field})`, key, field, a: a?.[field] ?? null, b: b?.[field] ?? null });
  }
  const aKeys = [...(a?.bodyKeys ?? [])];
  const bKeys = [...(b?.bodyKeys ?? [])];
  if (!eq(aKeys, bKeys)) diffs.push({ type: 'value-mismatch(bodyKeys)', key, field: 'bodyKeys', a: aKeys, b: bKeys });
  compareMapField(key, 'values', a?.values, b?.values, diffs);
  compareMapField(key, 'headers', a?.headers, b?.headers, diffs);
}

function skippedByProfile(report) {
  const map = new Map();
  for (const s of report?.skipped ?? []) map.set(String(s?.profile ?? ''), String(s?.reason ?? ''));
  return map;
}

function profilesOf(report) {
  return new Set((report?.observations ?? []).map((o) => String(o?.profile ?? '')));
}

// skipped 축 — decisions (12): skip은 관측과 같지 않다. 양쪽 다 skip이면 사유까지 같아야 한다.
function compareSkipped(a, b, diffs) {
  const aSkip = skippedByProfile(a);
  const bSkip = skippedByProfile(b);
  const aObserved = profilesOf(a);
  const bObserved = profilesOf(b);
  const profiles = [...new Set([...aSkip.keys(), ...bSkip.keys()])].sort();
  for (const profile of profiles) {
    const key = `skipped|${profile}`;
    const inA = aSkip.has(profile);
    const inB = bSkip.has(profile);
    if (inA && inB) {
      if (aSkip.get(profile) !== bSkip.get(profile)) {
        diffs.push({ type: 'value-mismatch(skipped.reason)', key, field: 'skipped.reason', a: aSkip.get(profile), b: bSkip.get(profile) });
      }
      continue;
    }
    const describe = (skipMap, observedSet) => (skipMap.has(profile)
      ? `skipped(${skipMap.get(profile)})`
      : `observed(${observedSet.has(profile) ? '관측 있음' : '관측 0건'})`);
    diffs.push({
      type: 'skipped-vs-observed',
      key,
      field: 'skipped',
      a: describe(aSkip, aObserved),
      b: describe(bSkip, bObserved),
    });
  }
}

// 두 리포트를 비교한다. 반환:
//   { observationCount, diffCount, diffs(상위 maxDiff건), truncated, warnings, meta:{a,b} }
export function compareReports(a, b, { maxDiff = DEFAULT_MAX_DIFF } = {}) {
  const aObs = Array.isArray(a?.observations) ? a.observations : [];
  const bObs = Array.isArray(b?.observations) ? b.observations : [];
  const aGroups = groupByKey(aObs);
  const bGroups = groupByKey(bObs);
  const keys = [...new Set([...aGroups.keys(), ...bGroups.keys()])].sort();

  const diffs = [];
  let observationCount = 0;
  for (const key of keys) {
    const listA = aGroups.get(key) ?? [];
    const listB = bGroups.get(key) ?? [];
    const pairs = Math.max(listA.length, listB.length);
    observationCount += pairs;
    for (let i = 0; i < pairs; i += 1) {
      const x = listA[i];
      const y = listB[i];
      if (x === undefined) { diffs.push({ type: 'only-in-B', key, field: null, a: null, b: summarize(y) }); continue; }
      if (y === undefined) { diffs.push({ type: 'only-in-A', key, field: null, a: summarize(x), b: null }); continue; }
      compareObservation(key, x, y, diffs);
    }
  }
  compareSkipped(a, b, diffs);

  const warnings = [];
  if (a?.meta?.routeCount !== b?.meta?.routeCount) {
    warnings.push(`meta.routeCount가 다르다(A=${a?.meta?.routeCount} B=${b?.meta?.routeCount}) — 인벤토리 판본이 다를 수 있다.`);
  }

  const limit = Number.isInteger(maxDiff) && maxDiff > 0 ? maxDiff : DEFAULT_MAX_DIFF;
  return {
    observationCount,
    diffCount: diffs.length,
    diffs: diffs.slice(0, limit),
    truncated: Math.max(0, diffs.length - limit),
    warnings,
    meta: { a: a?.meta ?? null, b: b?.meta ?? null },
  };
}

// only-in-* 진단용 요약 — 리포트에 이미 마스킹된 값만 옮긴다(새 값을 만들지 않는다).
function summarize(o) {
  return { status: o?.status ?? null, ok: o?.ok ?? null, reason: o?.reason ?? null };
}

// 리포트 shape 검증 — 파싱은 됐지만 리포트가 아닌 JSON을 조용히 "차이 0"으로 통과시키지 않는다.
export function validateReport(report, label) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return `${label}: 리포트가 객체가 아니다(스키마 B의 {version, meta, observations, skipped}가 필요하다).`;
  }
  if (!Array.isArray(report.observations)) {
    return `${label}: observations 배열이 없다 — 계약 러너(--out)가 만든 리포트가 아니다.`;
  }
  if (report.skipped !== undefined && !Array.isArray(report.skipped)) {
    return `${label}: skipped는 배열이어야 한다.`;
  }
  return null;
}

// --- CLI (얇은 래퍼) ---

function die(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { files: [], json: false, maxDiff: DEFAULT_MAX_DIFF };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--max-diff') {
      const v = flagValue(argv, i, '--max-diff');
      if (!v.ok) die(v.message);
      opts.maxDiff = Number(v.value);
      if (!Number.isInteger(opts.maxDiff) || opts.maxDiff < 1) die(`--max-diff 값이 유효하지 않다(1 이상 정수): ${v.value}`);
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) die(`알 수 없는 인자: ${arg}`);
    opts.files.push(arg);
  }
  if (opts.files.length !== 2) {
    die(`리포트 2개가 필요하다(받은 인자 ${opts.files.length}개) — <reportA.json> <reportB.json>.`);
  }
  return opts;
}

function loadReport(file, label) {
  const abs = nodePath.resolve(file);
  if (!fs.existsSync(abs)) die(`${label} 파일이 존재하지 않는다: ${abs}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    die(`${label} JSON 파싱 실패(${abs}): ${e.message}`);
  }
  const invalid = validateReport(parsed, `${label}(${abs})`);
  if (invalid) die(invalid);
  return parsed;
}

// 사람용 차이 목록 — 러너 --dual-run도 이 형식을 그대로 쓴다(출력이 두 벌로 갈라지지 않게).
export function formatDiffLines(result) {
  const lines = [];
  for (const w of result.warnings) lines.push(`warn ${w}`);
  if (result.diffCount === 0) return lines;
  lines.push(`차이 ${result.diffCount}건${result.truncated > 0 ? ` (상위 ${result.diffs.length}건만 표시 — ${result.truncated}건 생략)` : ''}:`);
  for (const d of result.diffs) {
    lines.push(`  [${d.type}] ${d.key}`);
    lines.push(`      A=${JSON.stringify(d.a)}`);
    lines.push(`      B=${JSON.stringify(d.b)}`);
  }
  return lines;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const a = loadReport(opts.files[0], 'reportA');
  const b = loadReport(opts.files[1], 'reportB');
  const result = compareReports(a, b, { maxDiff: opts.maxDiff });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const lines = formatDiffLines(result);
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    process.stdout.write(result.diffCount === 0
      ? `contract-diff-ok observations=${result.observationCount}\n`
      : `contract-diff-FAILED diffs=${result.diffCount}\n`);
  }
  process.exit(result.diffCount === 0 ? 0 : 1);
}

// 직접 실행일 때만 CLI를 돈다 — 러너가 compareReports를 import해도 부작용이 없어야 한다.
const selfPath = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? nodePath.resolve(process.argv[1]) : '';
const samePath = process.platform === 'win32'
  ? invoked.toLowerCase() === selfPath.toLowerCase()
  : invoked === selfPath;
if (samePath) main();
