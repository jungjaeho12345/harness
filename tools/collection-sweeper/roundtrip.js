// tools/collection-sweeper/roundtrip.js — 스위퍼 왕복 대조 하네스 (phase 76 step6 B-2·B-3 · 검증 절차 1~3).
// Node 서버와 Spring 서버를 각각의 임시 DATA_DIR 로 나란히 띄우고(같은 시드 · 같은 COLLECTION_TOKEN · loopback),
// **같은 픽스처 스풀**을 서버마다 한 벌씩 만들어 스위퍼(sweeper.js)를 자식 프로세스로 돌린 뒤 파일별 결과
// (성공 여부 · 거부 사유 토큰 · HTTP status · 생성된 기사의 투영 필드)를 대조한다. 그 뒤 같은 스풀에 스위퍼를 **한 번 더**
// 돌려 재실행 멱등(같은 파일 → 기사 1건 그대로)을 실측하고, --move-to · --dry-run · argv 토큰 가드 · 처리 파일 미삭제도 잰다.
//
// 사용: node tools/collection-sweeper/roundtrip.js [--jar <path>] [--java-home <path>] [--out-dir <dir>] [--keep] [--timeout <ms>]
//       node tools/collection-sweeper/roundtrip.js --overlap     # Node watcher(RCV_SPOOL_DIR) + 스위퍼를 같은 스풀에 — 중복 수집 실측
//
// 절차(scripts/spool-parity.mjs 의 규율을 베꼈고 그 파일은 고치지 않는다): 자기검사(node --test sweeper.test.js) → 리포 밖 임시 루트 →
//   서버별 임시 DATA_DIR 시드(src/db/**) → 빈 포트 → Node·Spring 기동(env = OS 허용목록 + DATA_DIR·PORT·HOST·COLLECTION_TOKEN · SPA_DIR 미주입)
//   → /api/health → Z 로그인 → 수신 설정 등록(POST /api/receiver-config) → 픽스처 스풀 → 스위퍼 pass1/pass2 → 대조 → 자식 종료 → 정리.
// CRITICAL(DB 비파괴): 리포 news.db·uploads/ 에 쓰지 않는다(실행 전후 스냅샷 무변 단언). 토큰은 실행마다 난수이고 어디에도 찍지 않는다.
// 주의: 허용 divergence 는 EXPECTED_DIVERGENCES 한 곳이며 **관측되지 않아도 실패**다(낡은 허용 목록은 공허하다).

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createSchema } from '../../src/db/schema.js';
import { seedUsers, SAMPLE_USERS } from '../../src/db/seed.js';
import { pathIsInside } from './lib.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = nodePath.resolve(HERE, '..', '..');
const NODE_SERVER = nodePath.join(REPO_ROOT, 'server', 'index.js');
const SWEEPER = nodePath.join(HERE, 'sweeper.js');
const SELF_TEST = nodePath.join(HERE, 'sweeper.test.js');
const SPRING_TARGET_DIR = nodePath.join(REPO_ROOT, 'server-spring', 'target');
const CONNECT_HOST = '127.0.0.1';
const PORT_BASE = 15000; // spring-contract·spa-parity·spool-parity 와 같은 구간(동시 실행 금지 규율)
const PORT_SPAN = 5000;
const JDK_HINT = 'D:/agents/tools/jdk-25.0.4.1+1';
const BUILD_HINT = `cd server-spring && JAVA_HOME="${JDK_HINT}" ./mvnw -B -q clean package -DskipTests`;
const AUTO_ATTRIBUTE = '자동기사';

const SRC = 'rt-src-a';
const SRC_INACTIVE = 'rt-src-inactive';
const SRC_UNREGISTERED = 'rt-unregistered';

// 알고도 남겨 둔 차이 — 파일별 (node 결과, spring 결과). 관측이 정확히 이 값이어야 통과한다.
//   huge: Node 의 /api/collection/receive 는 전역 express.json()(기본 100kb)을 타서 413 → 전역 핸들러 500 internal-error.
//         Spring JsonHttp.readBody 는 상한이 없어 200. Node **watcher** 경로는 HTTP 를 거치지 않아 상한이 없다 — 즉 스위퍼→Spring 이
//         watcher→Node 와 같은 쪽이고, 갈리는 것은 스위퍼→Node(대조군)뿐이다(docs/cutover-p3.md §5).
const EXPECTED_DIVERGENCES = {
  [`${SRC}/07-huge-150k.txt`]: { node: 'failed:internal-error@500', spring: 'ingested@200' },
};

const USAGE = `사용법: node tools/collection-sweeper/roundtrip.js [--jar <path>] [--java-home <path>] [--out-dir <dir>] [--keep] [--timeout <ms>] [--overlap]
  --overlap          Node 만 RCV_SPOOL_DIR 로 띄워 watcher 와 스위퍼를 같은 스풀에 돌린다(중복 수집 실측 — 런북 경고의 근거).
  --jar <path>       Spring 실행 jar(미지정=server-spring/target/*.jar 자동 탐색 · 빌드하지 않는다).
  --java-home <path> JDK 홈(미지정=SPRING_JAVA_HOME → JAVA_HOME).
  --out-dir <dir>    리포트 디렉토리(리포 밖). 미지정=임시 루트 아래.
  --keep             임시 디렉토리 보존(실패 시에는 항상 보존).
  --timeout <ms>     기동·조건 대기 한도(기본 60000).`;

function usageDie(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const take = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith('--') || String(v).trim() === '') usageDie(`${flag} 값이 유효하지 않다.`);
    return v;
  };
  const opts = { keep: false, timeout: 60000, overlap: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--jar') { opts.jar = take(i, a); i += 1; }
    else if (a === '--java-home') { opts.javaHome = take(i, a); i += 1; }
    else if (a === '--out-dir') { opts.outDir = take(i, a); i += 1; }
    else if (a === '--keep') opts.keep = true;
    else if (a === '--overlap') opts.overlap = true;
    else if (a === '--timeout') { opts.timeout = Number(take(i, a)); i += 1; }
    else usageDie(`알 수 없는 인자: ${a}`);
  }
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) usageDie(`--timeout 값이 유효하지 않다: ${opts.timeout}`);
  return opts;
}

// --- 환경 조립 (spool-parity childEnv 동형 — 부모 env 통째 상속 금지) ---
const OS_ENV_ALLOWLIST = process.platform === 'win32'
  ? ['SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']
  : ['PATH', 'HOME', 'LANG', 'TZ'];

function childEnv() {
  const env = {};
  for (const key of OS_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function runSelfTest() {
  const result = spawnSync(process.execPath, ['--test', SELF_TEST], { cwd: REPO_ROOT, env: childEnv(), encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(String(result.stdout ?? '') + String(result.stderr ?? ''));
    usageDie('스위퍼 자기검사가 실패했다(node --test tools/collection-sweeper/sweeper.test.js) — 빨간 채로는 서버를 띄우지 않는다.');
  }
  process.stdout.write('  자기검사 통과 (node --test tools/collection-sweeper/sweeper.test.js)\n');
}

// --- 자식 프로세스 유틸 ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childDead = (child) => child.exitCode !== null || child.signalCode !== null || child.spawnError !== undefined;

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

function collectOutput(child) {
  const buf = { out: '', err: '' };
  child.stdout.on('data', (c) => { buf.out += c; });
  child.stderr.on('data', (c) => { buf.err += c; });
  return buf;
}

async function pickFreePort(taken) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = PORT_BASE + Math.floor(Math.random() * PORT_SPAN);
    if (taken.has(candidate)) continue;
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(candidate, CONNECT_HOST, () => srv.close(() => resolve(true)));
    });
    if (free) { taken.add(candidate); return candidate; }
  }
  throw new Error(`빈 포트를 찾지 못했다([${PORT_BASE}, ${PORT_BASE + PORT_SPAN}) 20회 시도)`);
}

async function waitHealthy(baseUrl, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childDead(child)) return false;
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 && (await res.json()).ok === true) return true;
    } catch { /* 기동 전 */ }
    await sleep(200);
  }
  return false;
}

// --- 리포 데이터 안전 · 경로 · 자산 ---
function repoDataSnapshot() {
  const dbFile = nodePath.join(REPO_ROOT, 'news.db');
  const uploadsDir = nodePath.join(REPO_ROOT, 'uploads');
  const st = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  return { db: st ? { size: st.size, mtimeMs: st.mtimeMs } : null, uploads: fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : null };
}

function assertOutsideRepo(dir, label) {
  const abs = nodePath.resolve(dir);
  if (pathIsInside(abs, REPO_ROOT, process.platform)) usageDie(`${label}는 리포 안에 둘 수 없다: ${abs}`);
  return abs;
}

function resolveJar(given) {
  if (given) {
    const abs = nodePath.resolve(given);
    if (!fs.existsSync(abs)) usageDie(`--jar 파일이 존재하지 않는다: ${abs}`);
    return abs;
  }
  if (!fs.existsSync(SPRING_TARGET_DIR)) usageDie(`Spring 실행 jar가 없다. 먼저 빌드하라:\n  ${BUILD_HINT}`);
  const candidates = fs.readdirSync(SPRING_TARGET_DIR).filter((f) => f.endsWith('.jar') && !/-(sources|javadoc|tests)\.jar$/.test(f)).sort();
  if (candidates.length === 0) usageDie(`Spring 실행 jar가 없다(${SPRING_TARGET_DIR}). 먼저 빌드하라:\n  ${BUILD_HINT}`);
  if (candidates.length > 1) usageDie(`Spring 실행 jar 후보가 여럿이다 — --jar로 지정하라: ${candidates.join(', ')}`);
  return nodePath.join(SPRING_TARGET_DIR, candidates[0]);
}

function resolveJavaBin(given) {
  const home = given || process.env.SPRING_JAVA_HOME || process.env.JAVA_HOME;
  if (!home || String(home).trim() === '') usageDie(`JDK 홈을 찾지 못했다 — --java-home 또는 SPRING_JAVA_HOME/JAVA_HOME(예: ${JDK_HINT}).`);
  const bin = nodePath.join(nodePath.resolve(home), 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (!fs.existsSync(bin)) usageDie(`JDK 홈에 java 실행 파일이 없다: ${bin}`);
  return bin;
}

function seedTarget(root, label) {
  const dataDir = nodePath.join(root, label, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(nodePath.join(dataDir, 'news.db'));
  createSchema(db);
  seedUsers(db);
  db.close();
  const spoolDir = nodePath.join(root, label, 'spool');
  fs.mkdirSync(spoolDir);
  return { dataDir, spoolDir };
}

function scrub(text, secrets, replacements) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('<redacted>');
  for (const [needle, mask] of replacements) {
    for (const variant of new Set([needle, needle.replace(/\\/g, '/'), needle.replace(/\//g, '\\')])) if (variant) out = out.split(variant).join(mask);
  }
  return out;
}

// --- HTTP ---
async function api(baseUrl, method, path, { sid, body, headers: extra } = {}) {
  const headers = { ...(extra ?? {}) };
  if (sid) headers['x-session-id'] = sid;
  let payload;
  if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, json };
}

async function login(baseUrl, role) {
  const user = SAMPLE_USERS.find((u) => u.role === role);
  if (!user) throw new Error(`SAMPLE_USERS 에 ${role} 계정이 없다`);
  const res = await api(baseUrl, 'POST', '/api/login', { body: { userId: user.userId, password: user.password } });
  if (res.status !== 200 || res.json?.ok !== true || typeof res.json.sessionId !== 'string') throw new Error(`login 거부 role=${role} status=${res.status}`);
  return res.json.sessionId;
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

async function registerSources(baseUrl, sidZ) {
  for (const cfg of [
    { sourceId: SRC, type: 'FTP', name: 'roundtrip active', active: 'Y' },
    { sourceId: SRC_INACTIVE, type: 'FTP', name: 'roundtrip inactive', active: 'N' },
  ]) {
    const res = await api(baseUrl, 'POST', '/api/receiver-config', { sid: sidZ, body: cfg });
    expect(res.status === 200 && res.json?.ok === true, `수신 설정 등록 실패(${cfg.sourceId}) status=${res.status} reason=${res.json?.reason ?? '-'}`);
  }
}

async function listArticles(baseUrl, sidZ) {
  const res = await api(baseUrl, 'GET', '/api/articles', { sid: sidZ });
  expect(res.status === 200 && Array.isArray(res.json?.items), `기사 목록 실패 status=${res.status}`);
  return res.json.items;
}

async function projection(baseUrl, sidZ, articleId) {
  const res = await api(baseUrl, 'GET', `/api/articles/${articleId}`, { sid: sidZ });
  if (res.status !== 200) return { status: res.status };
  const { article, contents } = res.json;
  let doc = null;
  try { doc = JSON.parse(article.markupVersion); } catch { doc = { parseError: true }; }
  return {
    title: contents?.title ?? null, attribute: contents?.attribute ?? null, status: contents?.status ?? null,
    format: doc?.format ?? null, version: doc?.version ?? null, blocks: Array.isArray(doc?.blocks) ? doc.blocks.map((b) => b.text) : null,
  };
}

// --- 픽스처 (두 서버에 **같은 바이트**로) ---
function buildFixtures(stamp) {
  const text = (s) => Buffer.from(s, 'utf8');
  return [
    { rel: `${SRC}/01-plain.txt`, body: text(`${stamp} plain 제목\n본문 첫 줄\n둘째 줄`) },
    { rel: `${SRC}/02-object.json`, body: text(`{"title":"${stamp} obj","content":"객체 본문"}`) },
    { rel: `${SRC}/03-empty.txt`, body: Buffer.alloc(0) },
    { rel: `${SRC}/nested/04-deep.txt`, body: text(`${stamp} nested 제목\n중첩 경로 본문`) },
    { rel: `${SRC}/05-crlf.txt`, body: text(`\r\n\r\n  ${stamp} crlf 제목  \r\nline2\r\n`) },
    { rel: `${SRC}/06-unicode.txt`, body: text(`${stamp} 한글 이모지 😀 탭\t백슬래시\\ ESC\u001b VT\u000b\nU+2028\u2028 <>& DEL\u007f "따옴표"`) },
    { rel: `${SRC}/07-huge-150k.txt`, body: text(`${stamp} huge 제목\n${'x'.repeat(150 * 1024)}`) },
    { rel: `${SRC_INACTIVE}/08-inactive.txt`, body: text(`${stamp} inactive 제목\n본문`) },
    { rel: `${SRC_UNREGISTERED}/09-unregistered.txt`, body: text(`${stamp} unregistered 제목\n본문`) },
    { rel: '10-toplevel.txt', body: text(`${stamp} toplevel — sourceId 없음`) },
  ];
}

function writeFixtures(spoolDir, fixtures) {
  for (const f of fixtures) {
    const abs = nodePath.join(spoolDir, ...f.rel.split('/'));
    fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.body);
  }
}

function runSweeper(root, token, args, label) {
  const result = spawnSync(process.execPath, [SWEEPER, ...args], { cwd: root, env: { ...childEnv(), COLLECTION_TOKEN: token }, encoding: 'utf8' });
  return { status: result.status, out: String(result.stdout ?? ''), err: String(result.stderr ?? ''), label };
}

function readReport(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const verdictKey = (r) => `${r.outcome}${r.reason ? `:${r.reason}` : ''}${r.status ? `@${r.status}` : ''}`;

// 한 서버에서의 전 절차 — 결과 { pass1, pass2, projections, counts } 를 돌려준다.
async function exercise(target, fixtures, token, root, log) {
  const { baseUrl, spoolDir, label } = target;
  const sidZ = await login(baseUrl, 'Z');
  await registerSources(baseUrl, sidZ);
  writeFixtures(spoolDir, fixtures);
  const reports = nodePath.join(root, label, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  const common = ['--spool', spoolDir, '--base', baseUrl, '--stabilize-ms', '200', '--once'];
  const ledger = nodePath.join(spoolDir, '.collection-sweeper-ledger.jsonl');

  // 0. dry-run — 전송·장부·기사 0
  const dry = runSweeper(root, token, [...common, '--dry-run', '--report', nodePath.join(reports, 'dry.json')], 'dry');
  expect(dry.status === 0, `[${label}] dry-run exit ${dry.status}\n${dry.err}`);
  const dryReport = readReport(nodePath.join(reports, 'dry.json'));
  expect(dryReport.counts['dry-run'] === 9 && dryReport.counts.ignored === 1, `[${label}] dry-run 수치 ${JSON.stringify(dryReport.counts)}`);
  expect(!fs.existsSync(ledger), `[${label}] dry-run 이 장부를 만들었다`);
  expect((await listArticles(baseUrl, sidZ)).length === 0, `[${label}] dry-run 이 기사를 만들었다`);
  log('dry-run: 전송 0 · 장부 없음 · 기사 0');

  // 1. pass1
  const p1 = runSweeper(root, token, [...common, '--report', nodePath.join(reports, 'pass1.json')], 'pass1');
  const r1 = readReport(nodePath.join(reports, 'pass1.json'));
  expect(r1.exitCode === p1.status, `[${label}] pass1 리포트 exitCode ${r1.exitCode} ≠ 프로세스 ${p1.status}`);
  const articlesAfter1 = await listArticles(baseUrl, sidZ);
  // 절대 기대치 — 두 서버가 **같은 방향으로** 틀려도(예: 첫 실패에서 중단 — R4) 대조만으로는 못 보므로 여기서 잠근다.
  expect(r1.results.length === 9, `[${label}] pass1 결과 ${r1.results.length}건 ≠ 후보 9 — 뒤 파일이 처리되지 않았다(실패 격리)`);
  expect((r1.counts.rejected ?? 0) === 2, `[${label}] pass1 rejected ${r1.counts.rejected ?? 0} ≠ 2(inactive·unregistered)`);
  expect((r1.counts.ingested ?? 0) + (r1.counts.failed ?? 0) === 7, `[${label}] pass1 ingested+failed ${(r1.counts.ingested ?? 0) + (r1.counts.failed ?? 0)} ≠ 7`);
  expect(r1.counts.ignored === 1, `[${label}] pass1 ignored ${r1.counts.ignored} ≠ 1(최상위 파일)`);
  expect(articlesAfter1.length === (r1.counts.ingested ?? 0), `[${label}] 기사 ${articlesAfter1.length}건 ≠ ingested ${r1.counts.ingested ?? 0}`);
  log(`pass1: exit ${p1.status} · ${JSON.stringify(r1.counts)} · 기사 ${articlesAfter1.length}건`);

  // 2. 처리 파일 미삭제(검증 절차 3) — 픽스처 전부 그대로 있다
  for (const f of fixtures) expect(fs.existsSync(nodePath.join(spoolDir, ...f.rel.split('/'))), `[${label}] 스위퍼가 파일을 지웠다: ${f.rel}`);
  expect(fs.existsSync(ledger), `[${label}] 장부가 없다`);

  // 3. pass2 — 같은 스풀 재실행: 최종 결과는 전부 skipped · 기사 수 불변 · failed 만 재시도
  const p2 = runSweeper(root, token, [...common, '--report', nodePath.join(reports, 'pass2.json')], 'pass2');
  const r2 = readReport(nodePath.join(reports, 'pass2.json'));
  const finalCount = (r1.counts.ingested ?? 0) + (r1.counts.rejected ?? 0);
  const articlesAfter2 = await listArticles(baseUrl, sidZ);
  const plainTitle = fixtures[0].body.toString('utf8').split('\n')[0];
  const plainCount = articlesAfter2.filter((a) => a.title === plainTitle).length;
  // 수치를 **먼저** 남긴다 — 멱등이 깨졌을 때(R3) "같은 파일 2회 = 기사 몇 건"이 실측으로 찍혀야 한다.
  log(`pass2: exit ${p2.status} · ${JSON.stringify(r2.counts)} · 기사 ${articlesAfter2.length}건(pass1 ${articlesAfter1.length}) · 01-plain 기사 ${plainCount}건`);
  expect((r2.counts.skipped ?? 0) === finalCount, `[${label}] pass2 skipped ${r2.counts.skipped ?? 0} ≠ pass1 최종 ${finalCount}`);
  expect((r2.counts.ingested ?? 0) === 0, `[${label}] pass2 가 다시 넣었다: ingested=${r2.counts.ingested}`);
  expect(articlesAfter2.length === articlesAfter1.length, `[${label}] pass2 후 기사 수 ${articlesAfter2.length} ≠ pass1 ${articlesAfter1.length} — 멱등이 깨졌다`);
  expect(plainCount === 1, `[${label}] 같은 파일(01-plain)로 기사 ${plainCount}건 — 기대 1(멱등)`);

  // 4. --move-to — 별도 스풀 1파일: 이동 후 스풀에 없고 done 에 있으며 재실행은 files=0
  const spoolMove = nodePath.join(root, label, 'spool-move');
  const done = nodePath.join(root, label, 'done');
  fs.mkdirSync(nodePath.join(spoolMove, SRC), { recursive: true });
  fs.writeFileSync(nodePath.join(spoolMove, SRC, 'm1.txt'), `${plainTitle} move\n본문`);
  const inside = runSweeper(root, token, ['--spool', spoolMove, '--base', baseUrl, '--move-to', nodePath.join(spoolMove, 'done')], 'move-inside');
  expect(inside.status === 2, `[${label}] --move-to 스풀 안이 거부되지 않았다 exit ${inside.status}`);
  const mv = runSweeper(root, token, ['--spool', spoolMove, '--base', baseUrl, '--stabilize-ms', '200', '--move-to', done, '--report', nodePath.join(reports, 'move.json')], 'move');
  expect(mv.status === 0, `[${label}] --move-to 실행 exit ${mv.status}\n${mv.err}`);
  expect(!fs.existsSync(nodePath.join(spoolMove, SRC, 'm1.txt')), `[${label}] 이동 후에도 스풀에 남아 있다`);
  expect(fs.existsSync(nodePath.join(done, SRC, 'm1.txt')), `[${label}] done 폴더에 파일이 없다`);
  const mv2 = runSweeper(root, token, ['--spool', spoolMove, '--base', baseUrl, '--stabilize-ms', '0', '--move-to', done, '--report', nodePath.join(reports, 'move2.json')], 'move2');
  expect(mv2.status === 0 && (readReport(nodePath.join(reports, 'move2.json')).counts.ingested ?? 0) === 0, `[${label}] 이동 후 재실행이 다시 넣었다`);
  log('move-to: 스풀 안 거부(exit 2) · 이동 후 스풀에 없음 · done 에 있음 · 재실행 ingested 0');

  // 5. argv 토큰 가드(R5) — exit 2 · 출력에 값 0
  const guard = runSweeper(root, token, [...common, '--token', token], 'guard');
  expect(guard.status === 2, `[${label}] argv 토큰이 거부되지 않았다 exit ${guard.status}`);
  expect(!guard.out.includes(token) && !guard.err.includes(token), `[${label}] 가드 출력에 토큰 값이 찍혔다`);
  expect(!p1.out.includes(token) && !p1.err.includes(token) && !fs.readFileSync(ledger, 'utf8').includes(token), `[${label}] 스위퍼 출력/장부에 토큰 값이 있다`);
  log('argv 토큰 가드: exit 2 · 출력·장부에 값 0');

  // 5-b. 장부를 쓸 수 없으면(디렉토리를 장부로) 전송 **전**에 exit 2 — 장부 없는 기사(다음 실행의 중복)를 만들지 않는다
  const spoolLedger = nodePath.join(root, label, 'spool-ledger');
  fs.mkdirSync(nodePath.join(spoolLedger, SRC), { recursive: true });
  fs.writeFileSync(nodePath.join(spoolLedger, SRC, 'l1.txt'), `${plainTitle} ledger\n본문`);
  const before = (await listArticles(baseUrl, sidZ)).length;
  const badLedger = runSweeper(root, token, ['--spool', spoolLedger, '--base', baseUrl, '--stabilize-ms', '0', '--ledger', spoolLedger], 'bad-ledger');
  expect(badLedger.status === 2, `[${label}] 쓸 수 없는 장부가 exit 2 가 아니다: ${badLedger.status}`);
  expect((await listArticles(baseUrl, sidZ)).length === before, `[${label}] 장부를 못 쓰는데 기사가 생겼다`);
  log('장부 preflight: 쓸 수 없는 장부 → exit 2 · 전송 0');

  // 6. 투영 — ingested 파일마다 기사 되읽기
  const projections = {};
  for (const r of r1.results) if (r.outcome === 'ingested') projections[r.rel] = await projection(baseUrl, sidZ, r.articleId);
  return { pass1: r1, pass2: r2, projections, articles: articlesAfter2.length, exits: { dry: dry.status, pass1: p1.status, pass2: p2.status, move: mv.status } };
}

// --- 대조 ---
function compare(node, spring) {
  const rows = [];
  const diffs = [];
  const seenExpected = new Set();
  const byRel = (r) => Object.fromEntries(r.pass1.results.map((x) => [x.rel, x]));
  const a = byRel(node);
  const b = byRel(spring);
  const rels = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const rel of rels) {
    const ka = a[rel] ? verdictKey(a[rel]) : '(없음)';
    const kb = b[rel] ? verdictKey(b[rel]) : '(없음)';
    const pa = node.projections[rel] ? JSON.stringify(node.projections[rel]) : null;
    const pb = spring.projections[rel] ? JSON.stringify(spring.projections[rel]) : null;
    const same = ka === kb && pa === pb;
    const expected = EXPECTED_DIVERGENCES[rel];
    let note = same ? 'same' : 'DIFF';
    if (!same && expected && expected.node === ka && expected.spring === kb) { note = 'expected-divergence'; seenExpected.add(rel); }
    else if (!same) diffs.push(`${rel}: node=${ka} spring=${kb}${pa !== pb ? ` projection node=${pa} spring=${pb}` : ''}`);
    rows.push({ rel, node: ka, spring: kb, projectionSame: pa === pb, note, projection: pa === pb ? node.projections[rel] ?? null : { node: node.projections[rel] ?? null, spring: spring.projections[rel] ?? null } });
  }
  for (const rel of Object.keys(EXPECTED_DIVERGENCES)) if (!seenExpected.has(rel)) diffs.push(`허용 divergence 가 관측되지 않았다(낡은 허용 목록): ${rel} 기대 ${JSON.stringify(EXPECTED_DIVERGENCES[rel])}`);
  return { rows, diffs, expectedSeen: seenExpected.size };
}

function formatTable(rows) {
  const lines = ['| 파일 | node | spring | 투영 동일 | 판정 |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.rel} | ${r.node} | ${r.spring} | ${r.projectionSame ? 'yes' : 'no'} | ${r.note} |`);
  return lines.join('\n');
}

// --- --overlap: Node watcher(RCV_SPOOL_DIR) + 스위퍼를 같은 스풀에 ---
async function overlap(target, token, root, opts, log) {
  const { baseUrl, spoolDir } = target;
  const sidZ = await login(baseUrl, 'Z');
  await registerSources(baseUrl, sidZ);
  const title = `overlap-${Date.now().toString(36)} 제목`;
  const rel = `${SRC}/overlap.txt`;
  fs.mkdirSync(nodePath.join(spoolDir, SRC), { recursive: true });
  // watcher 는 디렉토리 생성 이벤트도 받는다 — 파일은 잠시 뒤에 쓴다(실제 FTPd 의 순서와 같다).
  await sleep(300);
  fs.writeFileSync(nodePath.join(spoolDir, SRC, 'overlap.txt'), `${title}\n본문`);
  const deadline = Date.now() + Math.min(opts.timeout, 10000);
  let byWatcher = [];
  while (Date.now() < deadline) {
    byWatcher = (await listArticles(baseUrl, sidZ)).filter((a) => a.attribute === AUTO_ATTRIBUTE);
    if (byWatcher.length > 0) { await sleep(700); byWatcher = (await listArticles(baseUrl, sidZ)).filter((a) => a.attribute === AUTO_ATTRIBUTE); break; }
    await sleep(100);
  }
  const watcherTitled = byWatcher.filter((a) => a.title === title).length;
  const watcherEmpty = byWatcher.filter((a) => a.title === '').length;
  log(`watcher: 자동기사 ${byWatcher.length}건(제목 일치 ${watcherTitled} · 빈 제목 ${watcherEmpty} — 부분 읽기 표본)`);
  const reports = nodePath.join(root, 'node', 'reports');
  fs.mkdirSync(reports, { recursive: true });
  const sw = runSweeper(root, token, ['--spool', spoolDir, '--base', baseUrl, '--stabilize-ms', '200', '--report', nodePath.join(reports, 'overlap.json')], 'overlap');
  const rep = readReport(nodePath.join(reports, 'overlap.json'));
  const after = (await listArticles(baseUrl, sidZ)).filter((a) => a.attribute === AUTO_ATTRIBUTE);
  const total = after.filter((a) => a.title === title).length;
  log(`sweeper: exit ${sw.status} · ${JSON.stringify(rep.counts)} → 같은 파일(${rel})로 기사 ${total}건(watcher ${watcherTitled} + sweeper ${rep.counts.ingested ?? 0}) · 자동기사 총 ${after.length}건`);
  return { title, watcherTotal: byWatcher.length, watcherTitled, watcherEmpty, sweeperIngested: rep.counts.ingested ?? 0, titledTotal: total, autoTotal: after.length, sweeperExit: sw.status };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  process.stdout.write(`collection-sweeper roundtrip 시작 mode=${opts.overlap ? 'overlap' : 'parity'}\n`);
  runSelfTest();
  const jar = opts.overlap ? null : resolveJar(opts.jar);
  const javaBin = opts.overlap ? null : resolveJavaBin(opts.javaHome);
  const givenOutDir = opts.outDir ? assertOutsideRepo(opts.outDir, '--out-dir') : null;
  // 긴 경로(realpath.native)로 푼다 — os.tmpdir() 이 8.3 짧은 경로(JUNGJA~1)를 주면 Node 의 fs.watch(recursive) 가 libuv 단언
  // (src\win\fs-event.c:72 `!_wcsnicmp(filename, dir, dirlen)`)으로 **서버째** 죽는다(--overlap 첫 실행 실측 · docs/cutover-p3.md §5).
  const root = assertOutsideRepo(fs.realpathSync.native(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'collection-sweeper-rt-'))), '임시 루트');
  const outDir = givenOutDir ?? nodePath.join(root, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const token = randomBytes(16).toString('hex'); // 실행마다 난수 — 어디에도 찍지 않는다
  const stamp = Date.now().toString(36);
  const fixtures = buildFixtures(stamp);
  process.stdout.write(`  tmp=${root} 픽스처 ${fixtures.length}(후보 9 · 최상위 1) 허용 divergence ${Object.keys(EXPECTED_DIVERGENCES).length}\n`);

  const repoBefore = repoDataSnapshot();
  const failures = [];
  const children = [];
  const targets = opts.overlap
    ? [{ label: 'node', argv: [NODE_SERVER], bin: process.execPath }]
    : [{ label: 'node', argv: [NODE_SERVER], bin: process.execPath }, { label: 'spring', argv: ['-jar', jar], bin: javaBin }];
  const results = {};
  let overlapResult = null;
  let comparison = null;
  try {
    const taken = new Set();
    for (const target of targets) Object.assign(target, seedTarget(root, target.label));
    for (const target of targets) {
      target.port = await pickFreePort(taken);
      target.baseUrl = `http://${CONNECT_HOST}:${target.port}`;
      const env = { ...childEnv(), DATA_DIR: target.dataDir, PORT: String(target.port), HOST: CONNECT_HOST, COLLECTION_TOKEN: token };
      if (opts.overlap) env.RCV_SPOOL_DIR = target.spoolDir; // Node watcher 를 켠다 — 같은 스풀을 스위퍼도 훑는다
      target.child = spawn(target.bin, target.argv, { cwd: nodePath.join(root, target.label), env, stdio: ['ignore', 'pipe', 'pipe'] });
      target.child.on('error', (err) => { target.child.spawnError = err; failures.push(`[${target.label}] 자식 프로세스 오류: ${err && err.code ? err.code : err}`); });
      children.push(target.child);
      target.buf = collectOutput(target.child);
      process.stdout.write(`  [${target.label}] 기동 pid=${target.child.pid ?? '-'} port=${target.port}${opts.overlap ? ' RCV_SPOOL_DIR=<tmp>/node/spool' : ''}\n`);
    }
    for (const target of targets) {
      const t0 = Date.now();
      if (!await waitHealthy(target.baseUrl, opts.timeout, target.child)) { failures.push(`[${target.label}] 기동/health 실패(exit=${target.child.exitCode}) — 기동 로그 참조`); continue; }
      process.stdout.write(`  [${target.label}] health ok ${Date.now() - t0}ms\n`);
    }
    if (failures.length === 0 && opts.overlap) {
      overlapResult = await overlap(targets[0], token, root, opts, (line) => process.stdout.write(`  [node] ${line}\n`));
      if (overlapResult.watcherTitled < 1) failures.push(`watcher 가 파일을 수집하지 않았다(fs 이벤트 미도착?) — 중복 실측 불성립: ${JSON.stringify(overlapResult)}`);
      if (overlapResult.sweeperIngested !== 1) failures.push(`스위퍼가 같은 파일을 넣지 못했다: ${JSON.stringify(overlapResult)}`);
      if (overlapResult.titledTotal !== overlapResult.watcherTitled + overlapResult.sweeperIngested) failures.push(`기사 수 합산 불일치: ${JSON.stringify(overlapResult)}`);
    } else if (failures.length === 0) {
      for (const target of targets) {
        try {
          results[target.label] = await exercise(target, fixtures, token, root, (line) => process.stdout.write(`  [${target.label}] ${line}\n`));
        } catch (err) {
          failures.push(`[${target.label}] 왕복 실패: ${err.message}`);
        }
      }
      if (failures.length === 0) {
        comparison = compare(results.node, results.spring);
        process.stdout.write(`${formatTable(comparison.rows)}\n`);
        for (const d of comparison.diffs) failures.push(`대조 불일치: ${d}`);
        fs.writeFileSync(nodePath.join(outDir, 'diff.json'), `${JSON.stringify({ rows: comparison.rows, diffs: comparison.diffs, exits: { node: results.node.exits, spring: results.spring.exits } }, null, 2)}\n`);
        for (const label of ['node', 'spring']) fs.writeFileSync(nodePath.join(outDir, `${label}.json`), `${JSON.stringify({ pass1: results[label].pass1, pass2: results[label].pass2, projections: results[label].projections }, null, 2)}\n`);
      }
    }
  } catch (err) {
    failures.push(`실행 예외: ${err && err.stack ? err.stack : err}`);
  } finally {
    for (const target of targets) {
      if (!target.child) continue;
      try { if (!await killChild(target.child)) failures.push(`[${target.label}] 프로세스 종료 실패 pid=${target.child.pid}`); } catch (err) { failures.push(`[${target.label}] 종료 중 예외: ${err && err.message}`); }
    }
    for (const target of targets) {
      if (!target.child) continue;
      try { fs.writeFileSync(nodePath.join(outDir, `${target.label}-boot.log`), scrub(`${target.buf.out}\n--- stderr ---\n${target.buf.err}`, [token], [[root, '<tmp>'], [REPO_ROOT, '<repo>']])); } catch { /* 진단 로그 실패는 무해 */ }
    }
  }

  const repoAfter = repoDataSnapshot();
  if (JSON.stringify(repoBefore) !== JSON.stringify(repoAfter)) failures.push(`리포 news.db/uploads 변동: before=${JSON.stringify(repoBefore)} after=${JSON.stringify(repoAfter)}`);
  for (const target of targets) if (target.child && !childDead(target.child)) failures.push(`[${target.label}] 자식 프로세스가 아직 살아 있다 pid=${target.child.pid}`);

  const ok = failures.length === 0;
  if (ok && !opts.keep) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); process.stdout.write(`  정리: 자식 ${targets.length} 종료 확인 · 임시 디렉토리 삭제\n`); } catch (err) { process.stderr.write(`warn 임시 디렉토리 정리 실패(무해): ${root} (${err && err.code})\n`); }
  } else {
    process.stdout.write(`keep 임시 디렉토리 보존(${ok ? '--keep' : '실패 진단용'}): ${root}\n`);
  }
  if (!ok) process.stderr.write(`${failures.map((f) => `FAIL ${f}`).join('\n')}\n`);
  if (opts.overlap) {
    const o = overlapResult ?? {};
    process.stdout.write(`collection-sweeper overlap watcher+sweeper 같은 파일 → 기사 ${o.titledTotal ?? '-'}건(watcher ${o.watcherTitled ?? '-'} + sweeper ${o.sweeperIngested ?? '-'}) 자동기사 총 ${o.autoTotal ?? '-'}(빈 제목 ${o.watcherEmpty ?? '-'}) → ${ok ? 'ok' : 'FAILED'}\n`);
  } else {
    const c = comparison;
    const n = results.node; const s = results.spring;
    process.stdout.write(`collection-sweeper roundtrip A=node B=spring 파일 ${c ? c.rows.length : '-'} · diffs ${c ? c.diffs.length : '-'} · 허용 divergence ${c ? c.expectedSeen : '-'} · pass2 ingested node=${n ? n.pass2.counts.ingested ?? 0 : '-'} spring=${s ? s.pass2.counts.ingested ?? 0 : '-'} · 기사 node=${n ? n.articles : '-'} spring=${s ? s.articles : '-'} → ${ok ? 'ok' : 'FAILED'}\n`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`roundtrip 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
