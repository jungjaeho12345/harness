// 부트 연결 PRAGMA (phase 64 step5 C-2) — src/db/connection.js 순수 헬퍼를 node:test로 잠근다.
// 배경: node:sqlite 기본 busy_timeout=0(실측) — 같은 data/를 두 인스턴스가 동시에 부팅하면
//   createSchema·백필 쓰기가 즉시 SQLITE_BUSY로 죽는다. 부트 연결에만 5000ms를 적용한다
//   (다른 74개 스위트는 자기 DatabaseSync를 만들므로 이 변경의 영향 범위 밖이다 — 전역 주입 금지).
// 리포 news.db에는 절대 연결하지 않는다 — :memory:와 mkdtemp 임시 파일 DB만 쓴다.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_BUSY_TIMEOUT_MS, applyConnectionPragmas } from '../src/db/connection.js';

const readTimeout = (db) => db.prepare('PRAGMA busy_timeout').get().timeout;

describe('applyConnectionPragmas — 적용·read-back', () => {
  test('기본값은 5000ms이고 read-back 값이 반환된다', () => {
    const db = new DatabaseSync(':memory:');
    assert.equal(readTimeout(db), 0, '전제: node:sqlite 기본은 0(즉시 SQLITE_BUSY)');
    const r = applyConnectionPragmas(db);
    assert.equal(r.busyTimeoutMs, 5000);
    assert.equal(readTimeout(db), 5000);
    assert.equal(DEFAULT_BUSY_TIMEOUT_MS, 5000);
    db.close();
  });

  test('명시값(1200)·0(즉시 실패의 명시적 선택)도 그대로 적용된다', () => {
    const db = new DatabaseSync(':memory:');
    assert.equal(applyConnectionPragmas(db, { busyTimeoutMs: 1200 }).busyTimeoutMs, 1200);
    assert.equal(readTimeout(db), 1200);
    assert.equal(applyConnectionPragmas(db, { busyTimeoutMs: 0 }).busyTimeoutMs, 0);
    assert.equal(readTimeout(db), 0);
    db.close();
  });

  test('재적용해도 값이 불변이다(멱등)', () => {
    const db = new DatabaseSync(':memory:');
    applyConnectionPragmas(db);
    applyConnectionPragmas(db);
    assert.equal(readTimeout(db), 5000);
    db.close();
  });
});

describe('applyConnectionPragmas — 입력 가드(조용한 no-op 금지)', () => {
  test('0 이상 정수가 아니면 TypeError', () => {
    const db = new DatabaseSync(':memory:');
    for (const bad of [-1, 1.5, NaN, Infinity, '5000', null, [], {}]) {
      assert.throws(() => applyConnectionPragmas(db, { busyTimeoutMs: bad }), TypeError, String(bad));
    }
    assert.equal(readTimeout(db), 0, '가드 실패 시 값이 바뀌지 않는다');
    db.close();
  });
});

describe('applyConnectionPragmas — 경합 실측(파일 DB 2연결)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yh-busy-'));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  test('A가 락을 쥔 상태에서 B의 쓰기: busy_timeout=300이면 150ms 이상 대기 후 실패, 0이면 즉시 실패', () => {
    const file = path.join(tmpDir, 'contention.db');
    const a = new DatabaseSync(file);
    a.exec('CREATE TABLE t (v INTEGER)');
    const b = new DatabaseSync(file);

    a.exec('BEGIN IMMEDIATE');
    a.exec('INSERT INTO t VALUES (1)');

    // busy_timeout=0 — 즉시 SQLITE_BUSY(대기 없음).
    applyConnectionPragmas(b, { busyTimeoutMs: 0 });
    const t0 = Date.now();
    assert.throws(() => b.exec('INSERT INTO t VALUES (2)'), /(SQLITE_BUSY|locked)/i);
    const immediateMs = Date.now() - t0;
    assert.ok(immediateMs < 100, `0이면 즉시 실패해야 한다(실측 ${immediateMs}ms)`);

    // busy_timeout=300 — 최소 150ms는 재시도 대기 후에 실패한다(하한을 더 조이면 느린 머신 flake).
    applyConnectionPragmas(b, { busyTimeoutMs: 300 });
    const t1 = Date.now();
    assert.throws(() => b.exec('INSERT INTO t VALUES (3)'), /(SQLITE_BUSY|locked)/i);
    const waitedMs = Date.now() - t1;
    assert.ok(waitedMs >= 150, `300ms 설정이면 150ms 이상 대기해야 한다(실측 ${waitedMs}ms)`);

    a.exec('ROLLBACK');
    b.close();
    a.close();
  });
});
