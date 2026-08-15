// 부트 DB 열기 seam (phase 64 step5 C-2) — server/index.js openBootDatabase를 in-memory로 잠근다.
// 결선 증거: 이 케이스가 없으면 헬퍼(src/db/connection.js)만 있고 부트 경로 결선이 빠져도 green이다.
// bootstrap()이 openBootDatabase를 실제로 쓰는지는 텍스트 스캔 잠금(아래) + git diff 눈 확인이 맡는다.
// 리포 news.db에는 절대 연결하지 않는다 — :memory:만 쓴다.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBootDatabase } from '../server/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readTimeout = (db) => db.prepare('PRAGMA busy_timeout').get().timeout;

describe('openBootDatabase — 부트 연결의 단일 관문', () => {
  test(':memory: 연결의 busy_timeout이 기본 5000이고 createSchema가 정상 동작한다', async () => {
    const db = openBootDatabase(':memory:');
    assert.equal(readTimeout(db), 5000);
    // 부트 경로와 같은 후속 작업이 그대로 동작한다 — 스키마 생성 + 간단 쓰기.
    const { createSchema } = await import('../src/db/schema.js');
    createSchema(db);
    db.prepare('INSERT INTO Contents (articleId) VALUES (?)').run('BOOT-1');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Contents').get().c, 1);
    db.close();
  });

  test('pragmaOptions가 applyConnectionPragmas로 전달된다(busyTimeoutMs: 1200)', () => {
    const db = openBootDatabase(':memory:', { busyTimeoutMs: 1200 });
    assert.equal(readTimeout(db), 1200);
    db.close();
  });

  test('잘못된 pragmaOptions는 TypeError로 전파된다(조용한 no-op 금지)', () => {
    assert.throws(() => openBootDatabase(':memory:', { busyTimeoutMs: -1 }), TypeError);
  });
});

// 텍스트 스캔 잠금(게이트 ② med 4) — sea-import-meta-lock 전례 동형. bootstrap이 직접
// new DatabaseSync(...)로 되돌아가면(결선 회귀) 출현 수가 늘어 여기서 즉시 red가 된다.
describe('openBootDatabase — 결선 텍스트 잠금', () => {
  test("server/index.js의 'new DatabaseSync(' 출현은 openBootDatabase 본문 1건뿐이다", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'server', 'index.js'), 'utf8');
    const hits = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes('new DatabaseSync(')) hits.push(`${i + 1}: ${lines[i].trim()}`);
    }
    assert.equal(
      hits.length, 1,
      `server/index.js의 new DatabaseSync( 출현은 openBootDatabase 본문 1건뿐이어야 한다`
      + `(부트 DB 열기·연결 설정의 단일 관문 — 직접 생성으로 되돌리면 busy_timeout 결선이 빠진다).`
      + ` 이 스캔은 주석·문자열 안의 리터럴도 카운트한다(sea-import-meta-lock과 동일 엄격성) — 주석에도 그 표현을 쓰지 마라. 발견:\n`
      + hits.join('\n'),
    );
    // 그 1건이 openBootDatabase 함수 본문 안에 있는지 — 함수 선언과 출현 순서로 확인한다.
    const fnIdx = text.indexOf('export function openBootDatabase');
    const hitIdx = text.indexOf('new DatabaseSync(');
    assert.ok(fnIdx >= 0, 'openBootDatabase export가 존재해야 한다');
    assert.ok(hitIdx > fnIdx, '유일 출현은 openBootDatabase 선언 이후(본문 안)여야 한다');
  });
});
