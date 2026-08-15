// 단일 인스턴스 잠금 부트 결선 실기 E2E (phase 65 step1) — 자식 프로세스 실기 기동으로 잠근다.
// 전례: test/same-origin-hardening.test.js T4(자식 기동·env 정리·health 폴링·finally kill).
// 케이스: T1 두 번째 인스턴스 거부(exit 1 + stderr 계약) + T1-b DB 무접촉 ·
//         T2 stale 락 없음(SIGKILL 후 재기동 — 오탐 안전성 실증) · T3 fail-open(손상 잠금 파일).
// 포트 오탐 방지 계약(step1): 포트는 20000~34999에서 실제 listen으로 골라 EADDRINUSE 오탐을 줄이고,
//   자식이 기대와 다르게 죽은 모든 실패 단언에 자식 stderr 원문을 포함한다(원인 즉시 판별).
// CRITICAL: DATA_DIR·cwd는 반드시 mkdtemp 임시 폴더다 — 리포 news.db·리포 루트 무접촉.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../server/index.js', import.meta.url));
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yh-lockboot-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 20000~34999(서버 범위 — 35000~44999는 통합 검증 CDP 범위, 침범 금지)에서 실제 listen으로
// 빈 포트를 고른다. pick과 사용 사이의 경합은 남지만, 실패 단언의 stderr 포함이 오진을 막는다.
async function pickPort(exclude = []) {
  for (let i = 0; i < 30; i += 1) {
    const port = 20000 + Math.floor(Math.random() * 15000);
    if (exclude.includes(port)) continue;
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('20000~34999에서 빈 포트를 찾지 못했다');
}

// 자식 기동 — env 정리는 T4 전례 + step1 계약(SPA_DIR=''로 SPA 비활성 고정).
function bootChild({ port, dataDir }) {
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, SPA_DIR: '' };
  for (const k of ['NODE_ENV', 'FORCE_HTTPS', 'COLLECTION_TOKEN', 'RCV_SPOOL_DIR', 'DIST_SPOOL_DIR']) delete env[k];
  const child = spawn(process.execPath, [serverPath], { cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  return { child, port, base: `http://127.0.0.1:${port}`, stderr: () => stderr };
}

async function waitHealth(base, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 && (await res.json()).ok === true) return true;
    } catch { /* 기동 전 — 재시도 */ }
    await sleep(100);
  }
  return false;
}

// 반환: 정상 종료 exitCode / 시그널 종료 'signal:<이름>' / 타임아웃 null.
// 시그널로 죽은 자식은 exitCode가 null로 남고 signalCode만 설정된다(kill('SIGKILL') 실측) —
// exitCode만 보면 SIGKILL 종료를 영원히 기다리게 된다.
async function waitExit(child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return child.exitCode;
    if (child.signalCode !== null) return `signal:${child.signalCode}`;
    await sleep(100);
  }
  return null;
}

// finally 정리 — kill → 200ms → 안 죽었으면 SIGKILL (T4 전례 + Windows 잔류 방지).
async function stop(child) {
  try {
    child.kill();
    await sleep(200);
    if (child.exitCode === null) child.kill('SIGKILL');
    await waitExit(child, 3000);
  } catch { /* 정리 전용 */ }
}

// 임시 폴더 정리 — best-effort(실패해도 red로 만들지 않는다. os.tmpdir 안이다).
function rmBestEffort(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* 정리 전용 */ }
}

test('T1: 같은 DATA_DIR 두 번째 인스턴스는 exit 1 + 잠금 메시지, 첫 인스턴스 무영향 (+T1-b DB 무접촉)', async () => {
  const dataDir = mkTmp();
  const portA = await pickPort();
  const a = bootChild({ port: portA, dataDir });
  let b = null; // 결선 전(현행)에는 B가 안 죽고 계속 떠 있다 — finally에서 반드시 stop(러너 잔류 방지).
  try {
    assert.ok(
      await waitHealth(a.base, a.child),
      `A가 기동하지 않았다 (exit=${a.child.exitCode})\nstderr:\n${a.stderr()}`,
    );

    // T1-b 전제: B 기동 직전 news.db 상태 스냅샷.
    const dbFile = path.join(dataDir, 'news.db');
    const before = fs.statSync(dbFile);

    const portB = await pickPort([portA]);
    b = bootChild({ port: portB, dataDir });
    const exitB = await waitExit(b.child, 10000);
    // 종료 단언 — stderr 원문 필수(잠금이 아닌 이유(EADDRINUSE 등)로 죽으면 여기서 즉시 드러난다).
    assert.equal(exitB, 1, `B는 10초 안에 exit 1이어야 한다 (exit=${exitB})\nstderr:\n${b.stderr()}`);
    const msg = b.stderr();
    assert.ok(msg.includes(dataDir), `stderr에 데이터 폴더 절대 경로가 있어야 한다\nstderr:\n${msg}`);
    assert.ok(msg.includes('이미 실행 중'), `stderr에 "이미 실행 중" 취지가 있어야 한다\nstderr:\n${msg}`);
    assert.ok(msg.includes('DATA_DIR'), `stderr에 DATA_DIR 해결 안내가 있어야 한다\nstderr:\n${msg}`);

    // B의 포트로는 health가 오지 않는다(listen 전에 죽었다).
    await assert.rejects(
      () => fetch(`${b.base}/api/health`, { signal: AbortSignal.timeout(1000) }),
      undefined,
      'B 포트는 연결 자체가 거부되어야 한다',
    );

    // T1-b: 두 번째 인스턴스는 news.db를 열지도 않았다(size·mtimeMs 불변).
    const after = fs.statSync(dbFile);
    assert.equal(after.size, before.size, 'B가 news.db 크기를 바꿨다');
    assert.equal(after.mtimeMs, before.mtimeMs, 'B가 news.db mtime을 바꿨다');

    // 첫 인스턴스 무영향 — A는 여전히 health 200.
    const resA = await fetch(`${a.base}/api/health`, { signal: AbortSignal.timeout(2000) });
    assert.equal(resA.status, 200, 'A는 B 거부 후에도 살아 있어야 한다');
  } finally {
    if (b) await stop(b.child);
    await stop(a.child);
    rmBestEffort(dataDir);
  }
});

test('T2: stale 락 없음 — 보유자 SIGKILL 직후 같은 DATA_DIR 재기동이 성공한다(오탐 안전성)', async () => {
  const dataDir = mkTmp();
  const portA = await pickPort();
  const a = bootChild({ port: portA, dataDir });
  let c = null;
  try {
    assert.ok(
      await waitHealth(a.base, a.child),
      `A가 기동하지 않았다 (exit=${a.child.exitCode})\nstderr:\n${a.stderr()}`,
    );
    a.child.kill('SIGKILL');
    const exitA = await waitExit(a.child, 5000);
    assert.notEqual(exitA, null, 'A가 SIGKILL 후 종료되어야 한다');

    const portC = await pickPort([portA]);
    c = bootChild({ port: portC, dataDir });
    assert.ok(
      await waitHealth(c.base, c.child),
      `강제 종료 직후 재기동이 실패했다 — 잔류 락 오탐(최악 실패 모드) (exit=${c.child.exitCode})\nstderr:\n${c.stderr()}`,
    );
  } finally {
    await stop(a.child);
    if (c) await stop(c.child);
    rmBestEffort(dataDir);
  }
});

test('T3: fail-open — 잠금 파일이 손상돼도 부팅은 계속된다(health 200)', async () => {
  const dataDir = mkTmp();
  fs.writeFileSync(path.join(dataDir, 'instance-lock.db'), '이것은 SQLite 파일이 아니다');
  const port = await pickPort();
  const a = bootChild({ port, dataDir });
  try {
    assert.ok(
      await waitHealth(a.base, a.child),
      `잠금을 못 걸어도 부팅은 계속돼야 한다(unavailable = 경고 후 진행) (exit=${a.child.exitCode})\nstderr:\n${a.stderr()}`,
    );
  } finally {
    await stop(a.child);
    rmBestEffort(dataDir);
  }
});
