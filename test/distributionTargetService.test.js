// 배부 대상(수신처) 서비스 테스트 — Z 전용 게이트(ADR-004) + 입력 검증(ADR-008).
// 하네스: in-memory DB + 실제 sessionService/authorization(가짜 게이트를 쓰지 않는다 — 신뢰 경계를 그대로 검증).
// CRITICAL: 검증 거부는 DB에 행을 남기지 않는다. 비활성은 active='N' soft delete가 유일 경로(행 삭제 없음).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createDistributionTargetModel } from '../src/models/distributionTargetModel.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createAuthorization } from '../src/services/authorization.js';
import { createDistributionTargetService } from '../src/services/distributionTargetService.js';

const VALID = { name: 'KBS 뉴스', kind: 'press', spoolDir: 'kbs' };

function setup({ now } = {}) {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const distributionTargetModel = createDistributionTargetModel(db);
  const sessionService = createSessionService();
  const authorization = createAuthorization({ sessionService, articleModel: null });
  const service = createDistributionTargetService(
    now ? { distributionTargetModel, authorization, now } : { distributionTargetModel, authorization },
  );
  return { db, distributionTargetModel, sessionService, service };
}

function sessionFor(sessionService, role, userId = 'u') {
  return sessionService.createSession({
    userId, role, department: '정치부', departmentCode: 'POL', name: userId,
  });
}

test('노출 메서드 가드: create/deactivate/query/update만 있다 (remove/delete 없음)', () => {
  const { service } = setup();
  assert.deepEqual(Object.keys(service).sort(), ['create', 'deactivate', 'query', 'update']);
});

test('Z 세션: create → query → update → deactivate 풀 루프 (행은 남고 active=N)', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');

  const c = service.create(z, VALID);
  assert.equal(c.ok, true);
  assert.ok(Number(c.id) > 0);

  const q = service.query(z, { spoolDir: 'kbs' });
  assert.equal(q.ok, true);
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].name, 'KBS 뉴스');
  assert.equal(q.items[0].kind, 'press');
  assert.equal(q.items[0].active, 'Y');

  const u = service.update(z, c.id, { name: 'KBS 보도본부' });
  assert.equal(u.ok, true);
  assert.equal(u.changes, 1);
  assert.equal(distributionTargetModel.findById(c.id).name, 'KBS 보도본부');

  const d = service.deactivate(z, c.id);
  assert.equal(d.ok, true);
  assert.equal(d.changes, 1);

  const row = distributionTargetModel.findById(c.id);
  assert.ok(row, '행은 삭제되지 않는다(soft delete)');
  assert.equal(row.active, 'N');
});

test('비-Z(R/D) 세션은 4개 op 전부 forbidden, 미인증/무효 세션은 unauthenticated', () => {
  const { service, sessionService } = setup();
  const r = sessionFor(sessionService, 'R', 'rep');
  const d = sessionFor(sessionService, 'D', 'desk');

  for (const sid of [r, d]) {
    assert.equal(service.query(sid, {}).reason, 'forbidden');
    assert.equal(service.create(sid, VALID).reason, 'forbidden');
    assert.equal(service.update(sid, 1, { name: 'x' }).reason, 'forbidden');
    assert.equal(service.deactivate(sid, 1).reason, 'forbidden');
  }

  for (const sid of ['bad-session', undefined, '']) {
    assert.equal(service.query(sid, {}).reason, 'unauthenticated');
    assert.equal(service.create(sid, VALID).reason, 'unauthenticated');
    assert.equal(service.update(sid, 1, { name: 'x' }).reason, 'unauthenticated');
    assert.equal(service.deactivate(sid, 1).reason, 'unauthenticated');
  }
});

test('게이트가 모델 호출 자체를 차단한다 — 비-Z의 create는 행을 만들지 못한다', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const r = sessionFor(sessionService, 'R', 'rep');
  service.create(r, { name: '몰래', kind: 'press', spoolDir: 'sneaky' });
  assert.equal(distributionTargetModel.query({ spoolDir: 'sneaky' }).length, 0);
});

test('비-Z는 기존 행의 상태를 바꾸지 못한다 (update/deactivate 게이트)', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');
  const r = sessionFor(sessionService, 'R', 'rep');
  const { id } = service.create(z, VALID);

  assert.equal(service.update(r, id, { name: '탈취' }).ok, false);
  assert.equal(service.deactivate(r, id).ok, false);

  const row = distributionTargetModel.findById(id);
  assert.equal(row.name, 'KBS 뉴스');
  assert.equal(row.active, 'Y');
});

test('invalid-name: 빈값/공백/100자 초과/비문자열(누락·null·숫자·객체)은 거부되고 행이 생기지 않는다', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');

  const bad = ['', '   ', 'ㄱ'.repeat(101), undefined, null, 123, {}, [], true];
  for (const [i, name] of bad.entries()) {
    const entry = { kind: 'press', spoolDir: `s${i}` };
    if (name !== undefined) entry.name = name;
    const r = service.create(z, entry);
    assert.equal(r.ok, false, `거부되어야 함: ${JSON.stringify(name)}`);
    assert.equal(r.reason, 'invalid-name', `reason: ${JSON.stringify(name)}`);
  }
  // String(undefined)==='undefined' 같은 강제변환 행이 만들어지지 않았는지 확인.
  assert.equal(distributionTargetModel.query({}).length, 0);
  assert.equal(distributionTargetModel.query({ name: 'undefined' }).length, 0);
  assert.equal(distributionTargetModel.query({ name: 'null' }).length, 0);
});

test('invalid-name: 경계값 — 100자는 통과, trim 후 저장된다', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');

  const at100 = 'ㄱ'.repeat(100);
  const ok = service.create(z, { name: `  ${at100}  `, kind: 'press', spoolDir: 'kbs' });
  assert.equal(ok.ok, true);
  assert.equal(distributionTargetModel.findById(ok.id).name, at100, '저장은 trim된 값');
});

test('invalid-kind: press|nonpress 정확 일치만 허용한다', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');

  const bad = ['PRESS', 'Press', '', 'other', 'press ', undefined, null, 123, {}, ['press']];
  for (const [i, kind] of bad.entries()) {
    const entry = { name: '대상', spoolDir: `s${i}` };
    if (kind !== undefined) entry.kind = kind;
    const r = service.create(z, entry);
    assert.equal(r.reason, 'invalid-kind', `거부되어야 함: ${JSON.stringify(kind)}`);
  }
  assert.equal(distributionTargetModel.query({}).length, 0);

  for (const kind of ['press', 'nonpress']) {
    assert.equal(service.create(z, { name: '대상', kind, spoolDir: `ok-${kind}` }).ok, true);
  }
});

test('invalid-spool-dir: 경로 조작·비문자열(누락·null)을 거부하고 행이 생기지 않는다', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');

  const bad = [
    '../x', 'a/b', 'a\\b', '/abs', 'C:\\x', 'kbs\u0000', '..', 'KBS', '한국', 'con', 'a'.repeat(65), '', '  ',
    undefined, null, 123, true, {}, [],
  ];
  for (const spoolDir of bad) {
    const entry = { name: '대상', kind: 'press' };
    if (spoolDir !== undefined) entry.spoolDir = spoolDir;
    const r = service.create(z, entry);
    assert.equal(r.ok, false, `거부되어야 함: ${JSON.stringify(spoolDir)}`);
    assert.equal(r.reason, 'invalid-spool-dir', `reason: ${JSON.stringify(spoolDir)}`);
  }
  assert.equal(distributionTargetModel.query({}).length, 0, 'DB에 행이 생기지 않는다');
  // 'null'/'undefined' 문자열 행이 만들어지지 않는다(phase 47에서 실제 디렉토리명이 되는 결함).
  assert.equal(distributionTargetModel.query({ spoolDir: 'null' }).length, 0);
  assert.equal(distributionTargetModel.query({ spoolDir: 'undefined' }).length, 0);
});

test('invalid-active: Y|N 정확 일치만 허용하고 미지정이면 Y로 저장된다', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');

  for (const [i, active] of ['y', 'n', '', 1, 0, null, true, 'YN'].entries()) {
    const r = service.create(z, { ...VALID, spoolDir: `s${i}`, active });
    assert.equal(r.reason, 'invalid-active', `거부되어야 함: ${JSON.stringify(active)}`);
  }
  assert.equal(distributionTargetModel.query({}).length, 0);

  const def = service.create(z, VALID);
  assert.equal(distributionTargetModel.findById(def.id).active, 'Y', '미지정 기본값은 Y');
  const off = service.create(z, { ...VALID, spoolDir: 'kbs2', active: 'N' });
  assert.equal(distributionTargetModel.findById(off.id).active, 'N');
});

test('duplicate-spool-dir: 같은 spoolDir 재등록은 비활성 행과의 충돌도 거부한다', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');

  const first = service.create(z, VALID);
  assert.equal(first.ok, true);

  const dup = service.create(z, { name: '다른 이름', kind: 'nonpress', spoolDir: 'kbs' });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate-spool-dir');
  assert.equal(distributionTargetModel.query({ spoolDir: 'kbs' }).length, 1);

  // 비활성(soft delete)된 행도 spoolDir를 계속 점유한다 — 스풀 폴더가 남아있기 때문.
  service.deactivate(z, first.id);
  const dupAfter = service.create(z, { name: '재등록', kind: 'press', spoolDir: 'kbs' });
  assert.equal(dupAfter.reason, 'duplicate-spool-dir');
  assert.equal(distributionTargetModel.query({ spoolDir: 'kbs' }).length, 1);

  // update로 다른 행의 spoolDir를 빼앗는 것도 거부.
  const other = service.create(z, { name: '연합', kind: 'press', spoolDir: 'yna' });
  assert.equal(service.update(z, other.id, { spoolDir: 'kbs' }).reason, 'duplicate-spool-dir');
  assert.equal(distributionTargetModel.findById(other.id).spoolDir, 'yna');
});

test('update로 자기 자신과 같은 spoolDir 재저장은 duplicate가 아니다', () => {
  const { service, sessionService } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');
  const { id } = service.create(z, VALID);

  const r = service.update(z, id, { spoolDir: 'kbs', name: 'KBS' });
  assert.equal(r.ok, true);
  assert.equal(r.changes, 1);
});

test('id는 진입부에서 정규화된다 — 문자열 id로 직접 호출해도 숫자 id와 동일하게 동작', () => {
  // 라우트는 Number(req.params.id)로 강제하지만, 서비스를 직접 부르는 호출자(phase 47 배부 실행)는
  // 문자열 id를 넘길 수 있다. 자기 제외 비교가 엄격 비교라 '1' !== 1로 자기 자신을 중복으로 오판했다.
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');
  const { id } = service.create(z, VALID);
  const other = service.create(z, { name: '연합', kind: 'press', spoolDir: 'yna' });

  // 자기 자신의 spoolDir 재저장은 문자열 id여도 duplicate가 아니다.
  const same = service.update(z, String(id), { spoolDir: 'kbs' });
  assert.equal(same.ok, true, `duplicate로 오판하면 안 된다: ${same.reason}`);
  assert.equal(same.changes, 1);

  // 다른 행의 spoolDir 탈취는 문자열 id여도 여전히 거부된다(정규화가 검사를 느슨하게 만들지 않는다).
  assert.equal(service.update(z, String(other.id), { spoolDir: 'kbs' }).reason, 'duplicate-spool-dir');
  assert.equal(distributionTargetModel.findById(other.id).spoolDir, 'yna');

  // 문자열 id의 update/deactivate는 숫자 id와 같은 행에 적용된다.
  assert.equal(service.update(z, String(id), { name: '문자열 id' }).ok, true);
  assert.equal(distributionTargetModel.findById(id).name, '문자열 id');
  assert.equal(service.deactivate(z, String(id)).ok, true);
  assert.equal(distributionTargetModel.findById(id).active, 'N');

  // 숫자로 변환되지 않는 id는 기존과 동일하게 not-found로 수렴한다(404 계약 유지).
  for (const bad of ['abc', '', ' ', null, undefined, {}, []]) {
    assert.equal(service.update(z, bad, { name: 'x' }).reason, 'not-found', `not-found여야 함: ${JSON.stringify(bad)}`);
    assert.equal(service.deactivate(z, bad).reason, 'not-found', `not-found여야 함: ${JSON.stringify(bad)}`);
  }
});

test('update는 present-only — 전달한 필드만 반영하고 나머지는 불변', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');
  const { id } = service.create(z, VALID);
  const before = distributionTargetModel.findById(id);

  const r = service.update(z, id, { kind: 'nonpress' });
  assert.equal(r.ok, true);
  const after = distributionTargetModel.findById(id);
  assert.equal(after.kind, 'nonpress');
  assert.equal(after.name, before.name, 'name 불변');
  assert.equal(after.spoolDir, before.spoolDir, 'spoolDir 불변');
  assert.equal(after.active, before.active, 'active 불변');
  assert.equal(after.createdAt, before.createdAt, 'createdAt 불변');
});

test('update: 전달된 필드가 규칙 위반이면 거부하고 아무것도 저장하지 않는다', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');
  const { id } = service.create(z, VALID);
  const before = distributionTargetModel.findById(id);

  const cases = [
    [{ name: '새이름', spoolDir: '../escape' }, 'invalid-spool-dir'],
    [{ name: '   ', kind: 'nonpress' }, 'invalid-name'],
    [{ name: 123 }, 'invalid-name'],
    [{ kind: 'PRESS' }, 'invalid-kind'],
    [{ active: 'y' }, 'invalid-active'],
    [{ spoolDir: null }, 'invalid-spool-dir'],
    [{ spoolDir: 'a/b' }, 'invalid-spool-dir'],
  ];
  for (const [fields, reason] of cases) {
    const r = service.update(z, id, fields);
    assert.equal(r.ok, false, `거부되어야 함: ${JSON.stringify(fields)}`);
    assert.equal(r.reason, reason, `reason: ${JSON.stringify(fields)}`);
    assert.deepEqual(distributionTargetModel.findById(id), before, '부분 저장이 없어야 한다');
  }
});

test('없는 id의 update/deactivate는 not-found', () => {
  const { service, sessionService } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');

  assert.equal(service.update(z, 9999, { name: '없음' }).reason, 'not-found');
  assert.equal(service.deactivate(z, 9999).reason, 'not-found');
  // 비수치 id(Number('abc')=NaN)도 행 미매치로 수렴한다.
  assert.equal(service.update(z, Number('abc'), { name: '없음' }).reason, 'not-found');
  assert.equal(service.deactivate(z, Number('abc')).reason, 'not-found');
});

test('비활성 두 경로 동치: update(active:N)와 deactivate(id)의 결과 행이 동일하다', () => {
  const clock = () => '2026-07-27T00:00:00.000Z';
  const viaUpdate = setup({ now: clock });
  const viaDeactivate = setup({ now: clock });

  const idA = (() => {
    const z = sessionFor(viaUpdate.sessionService, 'Z', 'admin');
    return viaUpdate.service.create(z, VALID).id;
  })();
  const idB = (() => {
    const z = sessionFor(viaDeactivate.sessionService, 'Z', 'admin');
    return viaDeactivate.service.create(z, VALID).id;
  })();

  const initialA = viaUpdate.distributionTargetModel.findById(idA);
  const initialB = viaDeactivate.distributionTargetModel.findById(idB);
  assert.deepEqual(initialA, initialB, '초기 행이 동일해야 비교가 의미 있다');

  const zA = sessionFor(viaUpdate.sessionService, 'Z', 'admin2');
  const zB = sessionFor(viaDeactivate.sessionService, 'Z', 'admin2');
  const rA = viaUpdate.service.update(zA, idA, { active: 'N' });
  const rB = viaDeactivate.service.deactivate(zB, idB);

  assert.deepEqual(rA, rB, '반환 shape도 동일');
  const rowA = viaUpdate.distributionTargetModel.findById(idA);
  const rowB = viaDeactivate.distributionTargetModel.findById(idB);
  assert.equal(rowA.active, 'N');
  assert.deepEqual(rowA, rowB, '두 경로는 같은 내부 헬퍼로 수렴해야 한다');
  assert.equal(rowA.updatedAt, clock(), '양쪽 모두 updatedAt이 stamp된다');
  assert.equal(rowA.name, initialA.name);
  assert.equal(rowA.kind, initialA.kind);
  assert.equal(rowA.spoolDir, initialA.spoolDir);
  assert.equal(rowA.createdAt, initialA.createdAt);
});

test('타임스탬프는 서버가 stamp하고 클라이언트의 createdAt/updatedAt/id는 무시된다', () => {
  let t = 0;
  const { service, sessionService, distributionTargetModel } = setup({
    now: () => `2026-07-27T00:00:0${t}.000Z`,
  });
  const z = sessionFor(sessionService, 'Z', 'admin');

  const c = service.create(z, {
    ...VALID, id: 999, createdAt: '1999-01-01T00:00:00.000Z', updatedAt: '1999-01-01T00:00:00.000Z',
  });
  assert.equal(c.ok, true);
  assert.notEqual(c.id, 999, '클라이언트 id는 무시된다');
  const created = distributionTargetModel.findById(c.id);
  assert.equal(created.createdAt, '2026-07-27T00:00:00.000Z');
  assert.equal(created.updatedAt, '2026-07-27T00:00:00.000Z');

  t = 5;
  service.update(z, c.id, { name: '변경', createdAt: '1999-01-01T00:00:00.000Z' });
  const updated = distributionTargetModel.findById(c.id);
  assert.equal(updated.createdAt, '2026-07-27T00:00:00.000Z', 'createdAt은 update에서 바뀌지 않는다');
  assert.equal(updated.updatedAt, '2026-07-27T00:00:05.000Z');
});

test('createdAt 기본 시계는 ISO-8601 문자열을 stamp한다', () => {
  const { service, sessionService, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');
  const { id } = service.create(z, VALID);
  const row = distributionTargetModel.findById(id);
  assert.match(row.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(row.updatedAt, row.createdAt);
});

test('query 응답 item은 SAFE_FIELDS 키만 갖는다 (allowlist 가드)', () => {
  const { service, sessionService, db } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');
  service.create(z, VALID);

  // 향후 시크릿 컬럼이 추가돼도 자동 비노출인지 확인 — 컬럼을 임시로 덧붙인다.
  db.exec('ALTER TABLE DistributionTarget ADD COLUMN secretToken TEXT');
  db.prepare('UPDATE DistributionTarget SET secretToken = ?').run('super-secret');

  const q = service.query(z, {});
  assert.equal(q.ok, true);
  assert.equal(q.items.length, 1);
  assert.deepEqual(
    Object.keys(q.items[0]).sort(),
    ['active', 'createdAt', 'id', 'kind', 'name', 'spoolDir', 'updatedAt'],
  );
  assert.ok(!('secretToken' in q.items[0]), '화이트리스트 밖 컬럼은 노출되지 않는다');
});

test('query 필터는 허용 키의 원시값만 통과시킨다 (배열·객체·미지정 키 무시)', () => {
  const { service, sessionService } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');
  service.create(z, VALID);
  service.create(z, { name: '연합', kind: 'nonpress', spoolDir: 'yna' });

  assert.equal(service.query(z, { kind: 'press' }).items.length, 1);
  assert.equal(service.query(z, { active: 'Y' }).items.length, 2);
  // 배열/객체 필터는 무시되어 전체가 조회된다(SQL 바인딩 오류가 아니라 무시).
  assert.equal(service.query(z, { kind: ['press', 'nonpress'] }).items.length, 2);
  assert.equal(service.query(z, { name: { $ne: null } }).items.length, 2);
  // 화이트리스트 밖 키도 무시된다.
  assert.equal(service.query(z, { secretToken: 'x', role: 'Z' }).items.length, 2);
  // 숫자 id 필터는 통과한다.
  const one = service.query(z, { id: 1 });
  assert.equal(one.items.length, 1);
  assert.equal(one.items[0].id, 1);
});

test('조회는 과거에 저장된 규칙 위반 행도 숨기지 않는다 (검증은 write 경로에만)', () => {
  const { service, sessionService, db } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');
  // 규칙 도입 전 저장된 레거시 행(대문자 spoolDir).
  db.prepare('INSERT INTO DistributionTarget (name, kind, spoolDir, active) VALUES (?, ?, ?, ?)')
    .run('레거시', 'press', 'OLD_DIR', 'Y');

  const q = service.query(z, {});
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].spoolDir, 'OLD_DIR');
});

test('deactivate는 같은 DB의 Article/Contents를 보존한다 (DB 비파괴)', () => {
  const { service, sessionService, db, distributionTargetModel } = setup();
  const z = sessionFor(sessionService, 'Z', 'admin');
  db.prepare('INSERT INTO Article (articleId, title) VALUES (?, ?)').run('AKR1', '기사');
  db.prepare("INSERT INTO Contents (articleId, attribute, status) VALUES (?, '일반기사', 'DPS')").run('AKR1');

  const { id } = service.create(z, VALID);
  assert.equal(service.deactivate(z, id).ok, true);

  assert.ok(distributionTargetModel.findById(id), '대상 행 보존');
  assert.ok(db.prepare('SELECT 1 FROM Article WHERE articleId = ?').get('AKR1'), 'Article 보존');
  assert.ok(db.prepare('SELECT 1 FROM Contents WHERE articleId = ?').get('AKR1'), 'Contents 보존');
});
