// 서버 단일 인스턴스 잠금 코어 (phase 65 step0) — src/db/instanceLock.js를 node:test로 잠근다.
// 배경(계획 단계 실측): 같은 DATA_DIR로 서버 둘이 뜨면 세션·SSE·배부가 split-brain이 된다.
//   잠금은 전용 파일(instance-lock.db)에 BEGIN EXCLUSIVE를 프로세스 수명 동안 유지하는 방식이며,
//   같은 프로세스 안의 두 번째 연결도 SQLITE_BUSY(errcode 5)로 차단된다(실측) — 자식 프로세스 없이
//   conflict 경로를 여기서 실측할 수 있다.
// CRITICAL: 실패(conflict·unavailable) 경로는 연 핸들을 반드시 닫아야 한다 — 안 닫으면 그 파일
//   unlink가 EBUSY·폴더 rmSync가 EPERM(실측)이라, "재시도 없는 rmSync 성공"이 닫힘의 관측 증거다.
// 리포 news.db·리포 루트에는 절대 연결하지 않는다 — mkdtemp 임시 폴더만 쓴다.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  LOCK_FILENAME,
  lockFilePath,
  classifyLockError,
  acquireInstanceLock,
  isLockHeld,
  releaseInstanceLock,
} from '../src/db/instanceLock.js';

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yh-instlock-'));

// 정리 실패가 테스트를 red로 만들지 않는다(임시 폴더는 os.tmpdir 안 — 잔재는 OS가 청소한다).
function cleanup(dir) {
  try { releaseInstanceLock(); } catch { /* 정리 전용 — 실패 무시 */ }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* 정리 전용 — 실패 무시 */ }
}

describe('lockFilePath — 순수 경로 계산', () => {
  test("lockFilePath('X')는 X 아래 LOCK_FILENAME 절대 경로다(파일시스템 접근 없음)", () => {
    assert.equal(LOCK_FILENAME, 'instance-lock.db');
    const p = lockFilePath('X');
    assert.equal(p, path.resolve('X', LOCK_FILENAME));
    assert.ok(path.isAbsolute(p));
    assert.ok(!fs.existsSync('X'), '경로 계산만 한다 — 폴더·파일을 만들지 않는다');
  });
});

describe('classifyLockError — conflict는 SQLITE_BUSY(하위 8비트 5)뿐', () => {
  test('errcode 5·확장 261 → conflict / 그 외 전부 unavailable', () => {
    assert.equal(classifyLockError({ errcode: 5 }), 'conflict');
    assert.equal(classifyLockError({ errcode: 261 }), 'conflict');
    for (const bad of [{ errcode: 14 }, { errcode: 26 }, { errcode: 526 }, new Error('x'), undefined, null]) {
      assert.equal(classifyLockError(bad), 'unavailable', JSON.stringify(bad ?? String(bad)));
    }
  });
});

describe('acquireInstanceLock — 획득·유지·해제', () => {
  test('획득 성공: acquired + 파일 존재 + isLockHeld true, 파일에 데이터 0(테이블·행 미생성)', () => {
    const dir = mkTmp();
    try {
      const r = acquireInstanceLock({ dataDir: dir });
      assert.equal(r.status, 'acquired');
      assert.equal(r.file, lockFilePath(dir));
      assert.ok(fs.existsSync(r.file));
      assert.equal(isLockHeld(), true);
      // 잠금은 파일 내용이 아니라 열린 핸들에 있다 — 0바이트 유지가 그 증거다.
      assert.equal(fs.statSync(r.file).size, 0, '잠금 파일에 테이블·행을 만들면 안 된다');
    } finally { cleanup(dir); }
  });

  test('멱등: 보유 중 재호출은 acquired를 돌려주고 새 연결을 열지 않는다(open 호출 0)', () => {
    const dir = mkTmp();
    try {
      assert.equal(acquireInstanceLock({ dataDir: dir }).status, 'acquired');
      let opens = 0;
      const r = acquireInstanceLock({ dataDir: dir, open: () => { opens += 1; throw new Error('열면 안 된다'); } });
      assert.equal(r.status, 'acquired');
      assert.equal(opens, 0);
      assert.equal(isLockHeld(), true);
    } finally { cleanup(dir); }
  });

  test('releaseInstanceLock 후 isLockHeld false + 같은 폴더 재획득 성공', () => {
    const dir = mkTmp();
    try {
      assert.equal(acquireInstanceLock({ dataDir: dir }).status, 'acquired');
      releaseInstanceLock();
      assert.equal(isLockHeld(), false);
      const again = acquireInstanceLock({ dataDir: dir });
      assert.equal(again.status, 'acquired');
      assert.equal(isLockHeld(), true);
    } finally { cleanup(dir); }
  });
});

describe('acquireInstanceLock — conflict (실 OS 잠금)', () => {
  test('다른 연결이 EXCLUSIVE 보유 중이면 conflict, 예외는 밖으로 새지 않는다', () => {
    const dir = mkTmp();
    const raw = new DatabaseSync(lockFilePath(dir));
    try {
      raw.exec('PRAGMA busy_timeout = 0');
      raw.exec('BEGIN EXCLUSIVE');
      let r;
      assert.doesNotThrow(() => { r = acquireInstanceLock({ dataDir: dir }); });
      assert.equal(r.status, 'conflict');
      assert.equal(r.file, lockFilePath(dir));
      assert.ok(r.error, 'conflict 결과에 원인 오류가 담긴다');
      assert.equal(isLockHeld(), false);
    } finally {
      try { raw.exec('ROLLBACK'); } catch { /* 정리 전용 */ }
      try { raw.close(); } catch { /* 정리 전용 */ }
      cleanup(dir);
    }
  });

  test('conflict 후 핸들 누수 0 — raw까지 닫으면 재시도 없는 rmSync가 성공한다', () => {
    const dir = mkTmp();
    const raw = new DatabaseSync(lockFilePath(dir));
    let done = false;
    try {
      raw.exec('PRAGMA busy_timeout = 0');
      raw.exec('BEGIN EXCLUSIVE');
      assert.equal(acquireInstanceLock({ dataDir: dir }).status, 'conflict');
      assert.equal(isLockHeld(), false);
      raw.exec('ROLLBACK');
      raw.close();
      // 실패한 acquire가 자기 핸들을 닫았다는 증거 — 열린 핸들이 남으면 EPERM으로 던진다(실측).
      fs.rmSync(dir, { recursive: true, force: true });
      assert.ok(!fs.existsSync(dir));
      done = true;
    } finally {
      if (!done) {
        try { raw.close(); } catch { /* 정리 전용 */ }
        cleanup(dir);
      }
    }
  });
});

describe('acquireInstanceLock — unavailable (그 외 실패 전부)', () => {
  test('부모 폴더 부재 → unavailable(예외 전파 금지)', () => {
    const dir = mkTmp();
    try {
      const missing = path.join(dir, 'no-such', 'nested');
      let r;
      assert.doesNotThrow(() => { r = acquireInstanceLock({ dataDir: missing }); });
      assert.equal(r.status, 'unavailable');
      assert.ok(r.error);
      assert.equal(isLockHeld(), false);
    } finally { cleanup(dir); }
  });

  test('손상 파일(텍스트) → unavailable + 핸들 누수 0(재시도 없는 rmSync 성공)', () => {
    const dir = mkTmp();
    let done = false;
    try {
      fs.writeFileSync(lockFilePath(dir), '이것은 SQLite 파일이 아니다');
      let r;
      assert.doesNotThrow(() => { r = acquireInstanceLock({ dataDir: dir }); });
      assert.equal(r.status, 'unavailable');
      assert.equal(isLockHeld(), false);
      fs.rmSync(dir, { recursive: true, force: true });
      assert.ok(!fs.existsSync(dir));
      done = true;
    } finally { if (!done) cleanup(dir); }
  });

  // 테스트 게이트 보강 — 합성 errcode 526 분류 케이스만 있던 갭을 실 FS로 잠근다(오탐 축 프로브 P1 실측).
  test('잠금 파일 자리가 디렉토리 → unavailable(예외 전파 금지 — conflict 오판이면 진짜 단일인데 죽는다)', () => {
    const dir = mkTmp();
    try {
      fs.mkdirSync(lockFilePath(dir));
      let r;
      assert.doesNotThrow(() => { r = acquireInstanceLock({ dataDir: dir }); });
      assert.equal(r.status, 'unavailable');
      assert.notEqual(r.status, 'conflict', 'conflict 오판이면 부트가 exit 1로 죽는다(최악 실패 모드)');
      assert.ok(r.error);
      assert.equal(isLockHeld(), false);
    } finally { cleanup(dir); }
  });
});

// 테스트 게이트 보강 — 지금까지는 "외부 보유 → 모듈 conflict" 방향만 단위로 잠겼고,
// "모듈 보유 → 외부 차단"(잠금이 실제로 잠근다)은 E2E T1에만 의존했다. 단위로도 잠근다.
describe('acquireInstanceLock — 보유 중 배타성(잠금이 실제로 잠근다)', () => {
  test('모듈이 보유 중이면 외부 연결의 BEGIN EXCLUSIVE가 SQLITE_BUSY(하위 8비트 5)로 차단된다', () => {
    const dir = mkTmp();
    let ext = null;
    try {
      assert.equal(acquireInstanceLock({ dataDir: dir }).status, 'acquired');
      ext = new DatabaseSync(lockFilePath(dir));
      ext.exec('PRAGMA busy_timeout = 0');
      assert.throws(
        () => ext.exec('BEGIN EXCLUSIVE'),
        (err) => (err?.errcode & 0xff) === 5,
        '보유 중 외부 EXCLUSIVE 시도는 SQLITE_BUSY여야 한다 — 아니면 잠금이 아무도 못 막는다',
      );
    } finally {
      try { ext?.close(); } catch { /* 정리 전용 */ }
      cleanup(dir);
    }
  });

  // stale 락 오탐(이 phase가 정의한 최악 실패 모드) 축 — 크래시 잔재가 재기동을 막지 않는다.
  // 계획 단계 실측(decisions (2))의 주장인데 잠그는 테스트가 없었다. garbage -journal은 유효한
  // 저널 매직이 아니라 SQLite가 무시·정리하고 획득에 성공한다(결정적).
  test('크래시 잔재 garbage -journal이 있어도 획득에 성공한다(stale 락 오탐 없음)', () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(`${lockFilePath(dir)}-journal`, 'garbage-not-a-journal');
      const r = acquireInstanceLock({ dataDir: dir });
      assert.equal(r.status, 'acquired');
      assert.equal(isLockHeld(), true);
    } finally { cleanup(dir); }
  });
});

describe('acquireInstanceLock — open 주입(결정적 분기 잠금)', () => {
  // 가짜 db: PRAGMA 적용은 통과시키고 BEGIN에서 지정 오류를 던진다. close 호출을 센다.
  function makeFakeDb(failErr) {
    const calls = { close: 0 };
    return {
      calls,
      exec(sql) { if (String(sql).startsWith('BEGIN')) throw failErr; },
      prepare() { return { get: () => ({ timeout: 0 }) }; },
      close() { calls.close += 1; },
    };
  }

  test('{errcode:5} → conflict, 원인 오류 보존 + 실패 핸들 close 정확히 1회', () => {
    const dir = mkTmp();
    try {
      const fakeErr = { errcode: 5 };
      const fake = makeFakeDb(fakeErr);
      const r = acquireInstanceLock({ dataDir: dir, open: () => fake });
      assert.equal(r.status, 'conflict');
      assert.equal(r.error, fakeErr);
      assert.equal(fake.calls.close, 1, '실패 경로는 자기가 연 핸들을 닫는다');
      assert.equal(isLockHeld(), false);
    } finally { cleanup(dir); }
  });

  test('{errcode:26} → unavailable, 원인 오류 보존 + 실패 핸들 close 정확히 1회', () => {
    const dir = mkTmp();
    try {
      const fakeErr = { errcode: 26 };
      const fake = makeFakeDb(fakeErr);
      const r = acquireInstanceLock({ dataDir: dir, open: () => fake });
      assert.equal(r.status, 'unavailable');
      assert.equal(r.error, fakeErr);
      assert.equal(fake.calls.close, 1);
      assert.equal(isLockHeld(), false);
    } finally { cleanup(dir); }
  });
});
