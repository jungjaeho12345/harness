import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotTitle, decorateHistoryRows, MAX_HISTORY_TITLE_LEN } from '../src/services/historyMeta.js';

// 블록 문서 헬퍼 — 실제 markupVersion 저장 형식({format,version,blocks})과 동형.
function markup(...blocks) {
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}
function textBlock(text) {
  return { type: 'text', text };
}

// queryByArticle 반환 행과 동형의 이력 행(hasSnapshot은 숫자 1/0 — 실제 모델 shape).
function row(id, over = {}) {
  return {
    id,
    articleId: 'AKR1',
    eventType: 'edit',
    action: null,
    fromStatus: null,
    toStatus: null,
    actorUserId: 'kim',
    createdAt: `2026-06-16T00:00:${String(id).padStart(2, '0')}.000Z`,
    hasSnapshot: 0,
    ...over,
  };
}

// --- snapshotTitle ---

test('historyMeta.snapshotTitle: 블록 문서의 첫 텍스트 줄이 제목이다', () => {
  const body = markup(textBlock('헤드라인'), textBlock('본문'));
  assert.equal(snapshotTitle(body), '헤드라인');
});

test('historyMeta.snapshotTitle: 첫 텍스트 블록이 공백뿐이면 빈 문자열이다(trim — bodyTitle 동형)', () => {
  const body = markup(textBlock('   '), textBlock('본문'));
  assert.equal(snapshotTitle(body), '');
});

test('historyMeta.snapshotTitle: 임베드 블록이 첫 원소여도 텍스트 블록만 센다', () => {
  const body = markup(
    { type: 'embed', embedType: 'image', title: '사진 캡션', src: '/img/a.jpg' },
    textBlock('진짜 제목'),
  );
  assert.equal(snapshotTitle(body), '진짜 제목');
});

test('historyMeta.snapshotTitle: 텍스트 블록 안의 개행은 첫 줄만 낸다', () => {
  const body = markup(textBlock('첫 줄\n둘째 줄'));
  assert.equal(snapshotTitle(body), '첫 줄');
});

test('historyMeta.snapshotTitle: 레거시 평문은 첫 줄이 제목이다', () => {
  assert.equal(snapshotTitle('제목줄\n본문'), '제목줄');
});

test('historyMeta.snapshotTitle: null/undefined/빈 문자열/깨진 JSON에 throw하지 않는다', () => {
  assert.equal(snapshotTitle(null), '');
  assert.equal(snapshotTitle(undefined), '');
  assert.equal(snapshotTitle(''), '');
  // 깨진 JSON은 평문으로 취급한다(bodyTitle·hasEndMarker 동형) — throw만 없으면 된다.
  assert.doesNotThrow(() => snapshotTitle('{'));
  assert.equal(typeof snapshotTitle('{'), 'string');
});

test('historyMeta.snapshotTitle: 200자를 넘는 첫 줄은 200자로 잘라 반환한다(말줄임표 없음)', () => {
  const long = 'a'.repeat(300);
  const title = snapshotTitle(markup(textBlock(long)));
  assert.equal(title.length, MAX_HISTORY_TITLE_LEN);
  assert.equal(title, 'a'.repeat(MAX_HISTORY_TITLE_LEN));
});

// --- decorateHistoryRows ---

test('historyMeta.decorate: 버전은 오래된 순 기준으로 증가하고 반환 순서는 입력(최신순) 그대로다', () => {
  // 오래된 순: edit(스냅샷, id1) → status/send(id2) → edit(스냅샷, id3) ⇒ 버전 2, 2, 3.
  const rows = [
    row(3, { hasSnapshot: 1 }),
    row(2, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' }),
    row(1, { hasSnapshot: 1 }),
  ];
  const out = decorateHistoryRows(rows, []);
  assert.deepEqual(out.map((r) => r.id), [3, 2, 1], '반환 순서는 입력 순서(id DESC) 그대로다');
  assert.deepEqual(out.map((r) => r.version), [3, 2, 2]);
});

test('historyMeta.decorate: 스냅샷이 하나도 없으면 모든 행의 version이 1이다', () => {
  const rows = [
    row(2, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' }),
    row(1),
  ];
  const out = decorateHistoryRows(rows, []);
  assert.deepEqual(out.map((r) => r.version), [1, 1]);
});

test('historyMeta.decorate: 제목은 직전(더 오래된) 스냅샷에서 승계되고 그 이전 구간은 빈 문자열이다', () => {
  const rows = [
    row(3, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' }),
    row(2, { hasSnapshot: 1 }),
    row(1, { eventType: 'status', action: 'hold', fromStatus: 'RDS', toStatus: 'DDH' }),
  ];
  const out = decorateHistoryRows(rows, [{ id: 2, markupVersion: markup(textBlock('가'), textBlock('나')) }]);
  assert.equal(out[0].title, '가', '스냅샷 이후 status 행은 스냅샷 제목을 승계한다');
  assert.equal(out[1].title, '가', '스냅샷 행 자신은 자기 스냅샷의 제목이다');
  assert.equal(out[2].title, '', '스냅샷보다 오래된 행(v1 구간)은 빈 문자열이다');
});

test('historyMeta.decorate: 상태는 전이 이후 승계·이전은 fromStatus 역승계, 전이가 없으면 빈 문자열이다', () => {
  const rows = [
    row(3, { hasSnapshot: 1 }),
    row(2, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' }),
    row(1, { hasSnapshot: 1 }),
  ];
  const out = decorateHistoryRows(rows, []);
  assert.equal(out[0].status, 'DPS', '전이 이후 edit 행은 toStatus 승계');
  assert.equal(out[1].status, 'DPS', '전이 행 자신은 toStatus');
  assert.equal(out[2].status, 'RDS', '전이보다 오래된 edit 행은 첫 전이의 fromStatus 역승계');

  // 전이 행이 하나도 없으면 status는 빈 문자열이다.
  const noTransition = decorateHistoryRows([row(2), row(1)], []);
  assert.deepEqual(noTransition.map((r) => r.status), ['', '']);
});

test('historyMeta.decorate: 배부 행(distribute, from/to 없음)도 같은 승계 규칙을 받는다', () => {
  const rows = [
    row(3, { eventType: 'distribute', action: 'press', actorUserId: null }),
    row(2, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' }),
    row(1, { eventType: 'distribute', action: 'nonpress', actorUserId: null }),
  ];
  const out = decorateHistoryRows(rows, []);
  assert.equal(out[0].status, 'DPS', '전이 이후 배부 행은 toStatus 승계');
  assert.equal(out[2].status, 'RDS', '전이 이전 배부 행은 fromStatus 역승계');
  assert.deepEqual(out.map((r) => r.version), [1, 1, 1]);
});

test('historyMeta.decorate: 입력 배열·행 객체를 변형하지 않고 새 배열·새 객체를 반환한다', () => {
  const rows = [
    row(2, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' }),
    row(1, { hasSnapshot: 1 }),
  ];
  const snapshots = [{ id: 1, markupVersion: markup(textBlock('가')) }];
  const before = JSON.parse(JSON.stringify(rows));
  const out = decorateHistoryRows(rows, snapshots);
  assert.deepEqual(rows, before, '입력 행이 깊은 비교로 동일하다(불변)');
  assert.notEqual(out, rows, '새 배열이다');
  for (let i = 0; i < out.length; i += 1) assert.notEqual(out[i], rows[i], '새 객체다');
});

test('historyMeta.decorate: 반환 행 어디에도 markupVersion 키가 없다(snapshots로 blob을 넘겨도)', () => {
  const rows = [
    row(2, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' }),
    row(1, { hasSnapshot: 1 }),
  ];
  const out = decorateHistoryRows(rows, [{ id: 1, markupVersion: markup(textBlock('가')) }]);
  for (const r of out) assert.equal('markupVersion' in r, false);
});

test('historyMeta.decorate: snapshots가 비거나 undefined여도(v1Body 미제공 전제) version은 정확하고 title만 빈다', () => {
  // 전제: v1Body 미제공. (v1Body를 제공하는 스냅샷 0건 케이스는 별도 — 그때만 v1 구간 제목이 채워진다.)
  const rows = [
    row(2, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' }),
    row(1, { hasSnapshot: 1 }),
  ];
  for (const snapshots of [[], undefined]) {
    const out = decorateHistoryRows(rows, snapshots);
    assert.deepEqual(out.map((r) => r.version), [2, 2], '증가 판정은 hasSnapshot만 본다');
    assert.deepEqual(out.map((r) => r.title), ['', '']);
  }
});

test('historyMeta.decorate: hasSnapshot이 숫자 1/0인 실제 모델 shape에서 정상 동작한다', () => {
  const rows = [row(2, { hasSnapshot: 1 }), row(1, { hasSnapshot: 0 })];
  const out = decorateHistoryRows(rows, [{ id: 2, markupVersion: markup(textBlock('제목')) }]);
  assert.deepEqual(out.map((r) => r.version), [2, 1]);
  assert.deepEqual(out.map((r) => r.title), ['제목', '']);
});

test('historyMeta.decorate: 빈 배열 입력이면 빈 배열을 반환한다', () => {
  assert.deepEqual(decorateHistoryRows([], []), []);
});

test('historyMeta.decorate: 같은 입력으로 두 번 호출하면 완전히 같은 결과다(순수·결정적)', () => {
  const rows = [
    row(3, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' }),
    row(2, { hasSnapshot: 1 }),
    row(1),
  ];
  const snapshots = [{ id: 2, markupVersion: markup(textBlock('가')) }];
  assert.deepEqual(decorateHistoryRows(rows, snapshots), decorateHistoryRows(rows, snapshots));
});

// --- v1Body 경계(스냅샷 0건 예외) ---

test('historyMeta.decorate: 스냅샷 0건 + v1Body 제공이면 전 행의 title이 v1 제목이고 version은 1이다', () => {
  const rows = [
    row(2, { eventType: 'status', action: 'approveDelete', fromStatus: 'DPS', toStatus: 'DPD' }),
    row(1, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' }),
  ];
  const out = decorateHistoryRows(rows, [], { v1Body: markup(textBlock('첫 제목\n본문')) });
  assert.deepEqual(out.map((r) => r.title), ['첫 제목', '첫 제목']);
  assert.deepEqual(out.map((r) => r.version), [1, 1]);
});

test('historyMeta.decorate: 스냅샷 0건 + v1Body 미제공이면 title은 빈 문자열이다(throw 금지)', () => {
  const rows = [row(1, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' })];
  const out = decorateHistoryRows(rows, []);
  assert.deepEqual(out.map((r) => r.title), ['']);
});

test('historyMeta.decorate: 스냅샷이 1건 이상이면 v1Body는 무시된다(v1 구간은 빈 문자열 유지)', () => {
  const rows = [
    row(3, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' }),
    row(2, { hasSnapshot: 1 }),
    row(1, { eventType: 'status', action: 'hold', fromStatus: 'RDS', toStatus: 'DDH' }),
  ];
  const out = decorateHistoryRows(
    rows,
    [{ id: 2, markupVersion: markup(textBlock('스냅샷 제목')) }],
    { v1Body: markup(textBlock('현재 제목')) },
  );
  assert.equal(out[0].title, '스냅샷 제목', '스냅샷 이후 행은 스냅샷에서 승계');
  assert.equal(out[1].title, '스냅샷 제목');
  assert.equal(out[2].title, '', 'v1 구간에 현재 본문 제목이 새지 않는다');
});

test('historyMeta.decorate: v1Body가 빈 값/텍스트 없는 문서여도 throw 없이 title은 빈 문자열이다', () => {
  const rows = [row(1, { eventType: 'status', action: 'send', fromStatus: 'RDS', toStatus: 'DPS' })];
  const emptyDoc = markup({ type: 'embed', embedType: 'image', title: '캡션', src: '/img/a.jpg' });
  for (const v1Body of ['', null, undefined, emptyDoc]) {
    const out = decorateHistoryRows(rows, [], { v1Body });
    assert.deepEqual(out.map((r) => r.title), ['']);
  }
});
