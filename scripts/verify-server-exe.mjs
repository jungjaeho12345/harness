// 서버 exe 실기 검증 (phase 61 step1) — 빌드된 실행 파일을 자식 프로세스로 기동해 HTTP로 잠근다.
// 사용: node scripts/verify-server-exe.mjs --exe <path> [--script <path>] [--spa <dir>] [--port <n>] [--portable]
//  - --script: 폴백(node-bundled) 모드 전용 — 자식을 `<exe> <script>`로 기동한다(미지정 = SEA 단독 실행).
//  - 기본 모드(A): 임시 DATA_DIR을 시드하고 health→로그인→세션→기사 생성(node:sqlite 쓰기)→SPA까지 전부 프로브.
//  - --portable 모드(B): 시드·DATA_DIR·SPA_DIR 없이 기동한다 — "cwd·env 없이 exe 옆 data/·web/ 기준으로
//    뜬다"는 계약만 검증한다(health 200 + /login.do SPA 폴백 + <exeDir>/data/news.db 스키마 생성, 3개뿐).
//    CRITICAL: 이 모드는 실행 파일 옆에 data/news.db를 만든다 — 호출자는 반드시 폐기 가능한 '사본'
//    (예: dist/portable-probe/)을 가리켜야 한다. 배포 폴더 원본에 대고 돌리면 배포물이 오염된다.
//    --spa와 동시 지정은 거부한다: 포터블이 증명할 것은 기본값(<exeDir>/web) 계약 그 자체다.
//  - 인증 프로브를 --portable에서 돌리지 않는 이유: 계정이 0명이라 로그인 실패가 정상이고,
//    통과시키려 시드하면 샘플 계정 비밀번호가 담긴 news.db가 배포물에 남는다(자격증명 유출).
// CRITICAL(데이터 안전): 리포 루트의 news.db·uploads/에 절대 바인딩하지 않는다 — DATA_DIR·cwd는
//   항상 임시 경로를 주고, 이 스크립트는 자신이 만든 임시 디렉토리 밖의 어떤 파일도 삭제하지 않는다.
// 주의: scripts/**는 eslint ignore 대상이다 — 인자 가드가 이 스크립트의 유일한 정적 안전망이다.

import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { seedUsers, SAMPLE_USERS } from '../src/db/seed.js';

const USAGE = `사용법: node scripts/verify-server-exe.mjs --exe <path> [--script <path>] [--spa <dir>] [--port <n>] [--portable]
  --exe <path>    검증할 실행 파일(SEA exe 또는 폴백 node.exe). 필수.
  --script <path> 폴백 모드 전용 — 자식을 "<exe> <script>"로 기동한다.
  --spa <dir>     기본 모드에서 SPA_DIR로 주입해 정적/폴백 서빙을 프로브한다.
  --port <n>      고정 포트(미지정 시 20000~50000 랜덤).
  --portable      배포 사본 검증 — 시드/DATA_DIR/SPA_DIR 없이 exe 옆 data/·web/ 계약만 본다.
                  주의: 실행 파일 옆에 data/news.db를 만든다 — 반드시 폐기 가능한 사본을 가리켜라.
                  --spa와 동시 지정 불가(포터블은 기본값 계약 그 자체를 검증한다).`;

function die(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { portable: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--exe') opts.exe = argv[++i];
    else if (a === '--script') opts.script = argv[++i];
    else if (a === '--spa') opts.spa = argv[++i];
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--portable') opts.portable = true;
    else die(`알 수 없는 인자: ${a}`);
  }
  // 인자 가드 — scripts/**는 eslint 밖이라 오타가 정적 검사에 안 걸린다. 잘못된 호출이
  // "검증 통과"로 둔갑하지 않도록 여기서 전부 막는다.
  if (!opts.exe) die('--exe 가 필요하다.');
  // 경로 인자는 받는 즉시 절대화한다 — 자식 프로세스 cwd가 임시 경로라 상대 경로는 ENOENT가 된다.
  opts.exe = nodePath.resolve(opts.exe);
  if (!fs.existsSync(opts.exe)) die(`--exe 경로가 존재하지 않는다: ${opts.exe}`);
  if (opts.script !== undefined) {
    opts.script = nodePath.resolve(opts.script);
    if (!fs.existsSync(opts.script)) die(`--script 경로가 존재하지 않는다: ${opts.script}`);
  }
  if (opts.spa !== undefined) {
    if (opts.portable) die('--portable과 --spa는 동시 지정 불가 — 포터블은 기본값(<exeDir>/web) 계약을 검증한다.');
    opts.spa = nodePath.resolve(opts.spa);
    if (!fs.existsSync(opts.spa)) die(`--spa 경로가 존재하지 않는다: ${opts.spa}`);
  }
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) {
    die(`--port 값이 유효하지 않다: ${opts.port}`);
  }
  return opts;
}

async function fetchJson(url, init) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), ...init });
  let body;
  try { body = await res.clone().json(); } catch { body = undefined; }
  return { res, body };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  // 임시 디렉토리 — dataDir(기본 모드 DB 루트)와 cwd(자식 작업 디렉토리, 절대 리포 루트가 아니다).
  const tmpData = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'verify-exe-data-'));
  const tmpCwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'verify-exe-cwd-'));

  // 기본 모드에서만 시드한다 — 시드 DB는 임시 dataDir에만 존재한다(배포물 오염 봉쇄).
  if (!opts.portable) {
    const db = new DatabaseSync(nodePath.join(tmpData, 'news.db'));
    createSchema(db);
    seedUsers(db);
    db.close();
  }

  const port = opts.port ?? (20000 + Math.floor(Math.random() * 30000));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1' };
  // 상속 env의 우연한 값으로 결과가 흔들리지 않게 전부 지운다(T4 전례).
  for (const k of ['COLLECTION_TOKEN', 'RCV_SPOOL_DIR', 'DIST_SPOOL_DIR', 'NODE_ENV', 'FORCE_HTTPS', 'ALLOWED_ORIGINS', 'DATA_DIR', 'SPA_DIR']) {
    delete env[k];
  }
  if (!opts.portable) {
    env.DATA_DIR = tmpData;
    if (opts.spa !== undefined) env.SPA_DIR = opts.spa;
  }
  // --portable: DATA_DIR·SPA_DIR을 주지 않는다 — "exe 옆 data/·web/" 기본값이 실제로 쓰이는지 검증한다.

  const exeDir = nodePath.dirname(opts.exe);
  const args = opts.script ? [opts.script] : [];
  const child = spawn(opts.exe, args, { cwd: tmpCwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let childOut = '';
  let childErr = '';
  child.stdout.on('data', (c) => { childOut += c; });
  child.stderr.on('data', (c) => { childErr += c; });

  const failures = [];
  const probes = [];
  const check = (name, ok, detail = '') => {
    probes.push(`${ok ? 'ok' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
    if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  };

  let bootMs = null;
  try {
    // 기동 폴링 — 최대 30초 / 100ms 간격. 자식이 죽으면 즉시 실패.
    let ready = false;
    for (let i = 0; i < 300 && !ready; i += 1) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        ready = res.status === 200 && (await res.json()).ok === true;
      } catch { /* 아직 기동 전 — 재시도 */ }
      if (!ready) await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) {
      throw new Error(`서버가 기동하지 않았다 (exitCode=${child.exitCode})\n--- stdout ---\n${childOut}\n--- stderr ---\n${childErr}`);
    }
    bootMs = Date.now() - startedAt;
    check('health 200', true, `${bootMs}ms`);

    if (opts.portable) {
      // (B) 포터블 — 프로브는 3개뿐이다. 인증·기사 생성은 여기서 하지 않는다(계정 0명 = 정상).
      const spaRes = await fetch(`${base}/login.do`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
      const spaText = await spaRes.text();
      const indexFile = nodePath.join(exeDir, 'web', 'index.html');
      const indexHtml = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : null;
      check('portable /login.do SPA 폴백(기본값 <exeDir>/web)', spaRes.status === 200 && indexHtml !== null && spaText === indexHtml, `status=${spaRes.status}`);
    } else {
      // (A) 기본 — 전체 프로브. 시드 계정으로 bcryptjs·세션·node:sqlite 쓰기 경로를 잠근다.
      const seedUser = SAMPLE_USERS[0]; // reporter — 시드와 단일 출처(src/db/seed.js).
      const login = await fetchJson(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: seedUser.userId, password: seedUser.password }),
      });
      const setCookie = login.res.headers.get('set-cookie') ?? '';
      check('POST /api/login 200 + sid 쿠키', login.res.status === 200 && login.body?.ok === true && setCookie.includes('sid='), `status=${login.res.status}`);
      const sidCookie = setCookie.split(';')[0]; // "sid=<token>"

      const session = await fetchJson(`${base}/api/session`, { headers: { cookie: sidCookie } });
      check('GET /api/session 200 + user', session.res.status === 200 && session.body?.user?.userId === seedUser.userId, `status=${session.res.status}`);

      const created = await fetchJson(`${base}/api/articles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sidCookie },
        body: JSON.stringify({ title: 'exe 검증 기사', markupVersion: 'exe 검증 본문' }),
      });
      check('POST /api/articles ok (node:sqlite 쓰기)', created.res.status === 200 && created.body?.ok === true && !!created.body?.articleId, `status=${created.res.status}`);

      const listed = await fetchJson(`${base}/api/articles`, { headers: { cookie: sidCookie } });
      const found = Array.isArray(listed.body?.items)
        && listed.body.items.some((it) => it.articleId === created.body?.articleId);
      check('GET /api/articles에 생성 기사 표시', listed.res.status === 200 && found, `status=${listed.res.status}`);

      if (opts.spa !== undefined) {
        const spaRes = await fetch(`${base}/login.do`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
        const spaText = await spaRes.text();
        const indexHtml = fs.readFileSync(nodePath.join(opts.spa, 'index.html'), 'utf8');
        check('GET /login.do SPA 폴백', spaRes.status === 200 && spaText === indexHtml, `status=${spaRes.status}`);

        // 실존 자산 1개 — index.html이 참조하는 /assets/* 파일을 찾아 200을 확인한다.
        const assetMatch = indexHtml.match(/(?:src|href)="(\/assets\/[^"]+)"/);
        if (assetMatch) {
          const assetRes = await fetch(`${base}${assetMatch[1]}`, { signal: AbortSignal.timeout(5000) });
          check(`GET ${assetMatch[1]} 200`, assetRes.status === 200, `status=${assetRes.status}`);
        } else {
          check('SPA 자산 프로브', false, 'index.html에서 /assets/* 참조를 찾지 못했다');
        }

        const nonHtml = await fetch(`${base}/list.do`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
        check('GET /list.do (Accept: json) 404 폴백 제외 계약', nonHtml.status === 404, `status=${nonHtml.status}`);
      }
      // /api/collection/receive·/pull은 프로브하지 않는다 — 수집 인제스트를 건드리지 않는다(계획 명시).
    }
  } catch (err) {
    failures.push(String(err?.message ?? err));
  } finally {
    // 종료 — kill 후 200ms 대기, 살아 있으면 SIGKILL(Windows 잔류 방지).
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
  }

  // 종료 후 DB 확인 — 모드별로 본다.
  try {
    if (opts.portable) {
      const dbFile = nodePath.join(exeDir, 'data', 'news.db');
      if (!fs.existsSync(dbFile)) {
        failures.push(`portable: <exeDir>/data/news.db가 생성되지 않았다: ${dbFile}`);
      } else {
        const db = new DatabaseSync(dbFile, { readOnly: true });
        try {
          // 스키마 존재 확인 — User·Article 조회가 성공하면 createSchema가 exe 안에서 돌았다는 증거다.
          const users = db.prepare('SELECT COUNT(*) AS c FROM User').get().c;
          const articles = db.prepare('SELECT COUNT(*) AS c FROM Article').get().c;
          probes.push(`ok portable <exeDir>/data/news.db 스키마 생성 (User=${users}, Article=${articles})`);
        } finally { db.close(); }
      }
    } else {
      const db = new DatabaseSync(nodePath.join(tmpData, 'news.db'), { readOnly: true });
      try {
        const count = db.prepare('SELECT COUNT(*) AS c FROM Article').get().c;
        if (count < 1) failures.push(`기본 모드: 임시 DATA_DIR의 Article 행이 없다 (count=${count})`);
        else probes.push(`ok 임시 DATA_DIR news.db에 Article ${count}건`);
      } finally { db.close(); }
    }
  } catch (err) {
    failures.push(`종료 후 DB 확인 실패: ${err?.message ?? err}`);
  }

  const exeBytes = fs.statSync(opts.exe).size;
  if (failures.length === 0) {
    process.stdout.write([
      `verify-ok mode=${opts.portable ? 'portable' : 'full'}${opts.script ? ' (node-bundled)' : ''}`,
      `exe=${opts.exe} (${(exeBytes / 1024 / 1024).toFixed(1)}MB)`,
      `boot=${bootMs}ms`,
      ...probes.map((p) => `  ${p}`),
    ].join('\n') + '\n');
    process.exit(0);
  }
  process.stderr.write([
    `verify-FAILED (${failures.length}건)`,
    ...failures.map((f) => `  - ${f}`),
    '--- probes ---',
    ...probes.map((p) => `  ${p}`),
    '--- child stdout ---', childOut,
    '--- child stderr ---', childErr,
  ].join('\n') + '\n');
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`verify-server-exe 실패: ${err?.stack ?? err}\n`);
  process.exit(1);
});
