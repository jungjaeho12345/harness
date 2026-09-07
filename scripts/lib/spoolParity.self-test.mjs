// scripts/lib/spoolParity.mjs 의 순수 판정부 자기검사 (phase 76 step5).
//
// 왜 여기에 있고 npm test 가 돌지 않는가: package.json 은 무수정 목록이고 `npm test` 는 "test/**/*.test.js" 만 훑는다.
// scripts/spool-parity.mjs 는 시작할 때 이 파일을 스스로 돌린다(빨간 채로는 서버를 띄우지 않는다).
// 실행: node --test scripts/lib/spoolParity.self-test.mjs
//
// 무엇을 잠그는가(각각 step5 변이의 방어선이다):
//   · 자리표시자 키의 **집합**(Q6 — 개수만 세면 하나를 빼고 하나를 넣어도 통과한다)
//   · 같은 파일 2벌 → 0 · 키 순서만 다름 → ≥1 · 가 대소문자만 다름 → ≥1 · 자리표시자 밖 키 차이 → ≥1
//   · 자리표시자 밖의 키가 **늘어도**(Q5 allowlist 확대) ≥1 · 파일 수가 다르면 즉시 실패(바이트 비교 전)
//   · 정합 3겹: distributedAt 형식 · 파일명 stamp == compactStamp(distributedAt) · createdAt ≤ sentAt ≤ distributedAt(Q7)
//   · 자리표시자 값은 **최상위 키의 값만** 바꾼다(제목 안에 같은 글자가 있어도 손대지 않는다)
//   · 시나리오 계획이 Q3·Q5 를 공허하게 만들지 않는 표본을 담는가(제어문자 9자 중 하나 · 비어 있지 않은 internalComment)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ISO_MILLIS_Z, LOWERCASE_HEX_CHARS, PLACEHOLDER_KEYS, SPOOL_FILE, SPOOL_FOLDERS, STAMP_ORDER,
  buildScenarioPlan, compactStamp, compareSpools, expectedFolderCounts, formatDiffLines, formatSummary,
  normalizeFile, parseSpoolFileName, scanTopLevel, stepsByArticle,
} from './spoolParity.mjs';

// --- 픽스처 — Node spoolWriter.js 가 만드는 그대로(공백 없음 · 키 순서 = 조립 순서) ---

const T_CREATED = '2026-09-07T01:02:03.100Z';
const T_SENT = '2026-09-07T01:02:03.200Z';
const T_DIST = '2026-09-07T01:02:03.456Z';

function payload(overrides = {}, { drop = [] } = {}) {
  const base = {
    articleId: 'AKR20260907000000001',
    title: '제목 가나다',
    author: '박데스크',
    department: '편집부',
    departmentCode: 'EDT',
    category: 'politics',
    keyword: '키워드',
    externalComment: '외부',
    createdAt: T_CREATED,
    sentAt: T_SENT,
    status: 'DPS',
    markupVersion: '{"blocks":[{"text":"본문"},{"text":"(끝)"}]}',
    distributedAt: T_DIST,
    ...overrides,
  };
  for (const key of drop) delete base[key];
  return base;
}

function fileOf(obj, { folder = SPOOL_FOLDERS.press, name } = {}) {
  const text = JSON.stringify(obj);
  return { folder, name: name ?? `${obj.articleId}_${compactStamp(obj.distributedAt)}.json`, text };
}

function side(label, entries) {
  // entries: [{ step, file }]
  const steps = {};
  for (const { step, file } of entries) steps[parseSpoolFileName(file.name).articleId] = step;
  return { label, files: entries.map((e) => e.file), steps };
}

function pair(aOverrides = {}, bOverrides = {}, { aOpts = {}, bOpts = {} } = {}) {
  const a = side('node', [{ step: 'ga', file: fileOf(payload({ articleId: 'AKR20260907000000001', ...aOverrides }, aOpts)) }]);
  const b = side('spring', [{ step: 'ga', file: fileOf(payload({ articleId: 'AKR20260907000000002', createdAt: '2026-09-07T01:02:09.100Z', sentAt: '2026-09-07T01:02:09.200Z', distributedAt: '2026-09-07T01:02:09.456Z', ...bOverrides }, bOpts)) }]);
  return compareSpools(a, b);
}

// --- 자리표시자 집합 ---

test('자리표시자 키는 정확히 이 집합이다(개수가 아니라 집합 · 순서까지)', () => {
  assert.deepEqual([...PLACEHOLDER_KEYS], ['articleId', 'createdAt', 'sentAt', 'distributedAt']);
  assert.ok(Object.isFrozen(PLACEHOLDER_KEYS));
  assert.deepEqual([...STAMP_ORDER], ['createdAt', 'sentAt', 'distributedAt'], '단조성 사슬은 이 순서다');
  for (const key of STAMP_ORDER) assert.ok(PLACEHOLDER_KEYS.includes(key), `${key} 는 눈감는 대신 단언하는 키다`);
  for (const forbidden of ['title', 'markupVersion', 'embargoAt', 'secondEmbargoAt', 'status', 'keyword', 'author']) {
    assert.ok(!PLACEHOLDER_KEYS.includes(forbidden), `${forbidden} 는 클라가 준 값이라 자리표시자 금지`);
  }
});

test('형식 상수 — ISO 밀리초 Z · 스풀 파일명 · 폴더 슬러그 3종', () => {
  assert.ok(ISO_MILLIS_Z.test(T_DIST));
  assert.ok(!ISO_MILLIS_Z.test('2026-09-07T01:02:03Z'), '소수부 없는 stamp 는 거부');
  assert.ok(!ISO_MILLIS_Z.test('2026-09-07T01:02:03.456+09:00'), '오프셋 표기는 거부');
  assert.equal(compactStamp(T_DIST), '20260907T010203456Z');
  assert.deepEqual(parseSpoolFileName('AKR20260907000000001_20260907T010203456Z.json'), { articleId: 'AKR20260907000000001', stamp: '20260907T010203456Z' });
  assert.equal(parseSpoolFileName('.AKR20260907000000001_20260907T010203456Z.json.tmp'), null, '임시 파일은 스풀 산출물이 아니다');
  assert.equal(parseSpoolFileName('AKR20260907000000001_20260907T010203Z.json'), null);
  assert.ok(SPOOL_FILE.test('a_20260907T010203456Z.json'));
  assert.deepEqual(Object.values(SPOOL_FOLDERS), ['sp-press', 'sp-nonpress', 'sp-retry']);
  assert.deepEqual([...LOWERCASE_HEX_CHARS], [0x0B, 0x0E, 0x0F, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F]);
});

// --- 최상위 스캐너 ---

test('scanTopLevel 은 최상위 키를 순서대로 돌려주고 문자열 값 자리를 정확히 가리킨다', () => {
  const text = '{"a":"x","b":1,"c":null,"d":{"a":"nested"},"e":[1,"two"],"f":"esc\\"q\\\\"}';
  const scan = scanTopLevel(text);
  assert.deepEqual(scan.keys, ['a', 'b', 'c', 'd', 'e', 'f']);
  const strings = scan.values.filter((v) => v.kind === 'string').map((v) => [v.key, text.slice(v.start, v.end)]);
  assert.deepEqual(strings, [['a', '"x"'], ['f', '"esc\\"q\\\\"']]);
  assert.throws(() => scanTopLevel('{"a":"x"'), /끝나지 않았다|malformed|형식/);
  assert.throws(() => scanTopLevel('["a"]'), /객체/);
});

test('자리표시자 치환은 최상위 값만 — 제목 안에 같은 글자가 있어도 손대지 않는다', () => {
  const obj = payload({ title: `가짜 "distributedAt":"${T_DIST}" ${T_CREATED} AKR20260907000000001` });
  const file = fileOf(obj);
  const r = normalizeFile(file.name, file.text);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.blinded, PLACEHOLDER_KEYS.length + 2, '최상위 4키 + 파일명 2자리');
  assert.ok(r.normalizedText.includes(`"title":"가짜 \\"distributedAt\\":\\"${T_DIST}\\" ${T_CREATED} AKR20260907000000001"`), '제목 안의 값은 그대로다');
  assert.ok(r.normalizedText.endsWith('"distributedAt":"<distributedAt>"}'));
  assert.ok(r.normalizedText.includes('"createdAt":"<createdAt>","sentAt":"<sentAt>"'));
  assert.ok(r.normalizedText.startsWith('{"articleId":"<articleId>","title":'));
  assert.equal(r.normalizedName, '<articleId>_<stamp>.json');
});

// --- 정합 3겹 ---

test('정합 1겹 — distributedAt 이 ISO 밀리초 Z 가 아니면 실패', () => {
  const obj = payload({ distributedAt: '2026-09-07T01:02:03Z' });
  const r = normalizeFile(`${obj.articleId}_20260907T010203Z.json`, JSON.stringify(obj));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('distributedAt')), JSON.stringify(r.errors));
});

test('정합 2겹 — 파일명 stamp 가 distributedAt 의 compact 값과 다르면 실패(Q7)', () => {
  const obj = payload();
  const r = normalizeFile(`${obj.articleId}_20260907T010203457Z.json`, JSON.stringify(obj));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('stamp')), JSON.stringify(r.errors));
  // 파일명의 articleId 와 페이로드의 articleId 가 다른 것도 정합 위반이다.
  const r2 = normalizeFile(`AKR20260907000000009_${compactStamp(obj.distributedAt)}.json`, JSON.stringify(obj));
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('articleId')), JSON.stringify(r2.errors));
});

test('정합 3겹 — createdAt ≤ sentAt ≤ distributedAt 이 깨지면 실패 · 형식도 본다', () => {
  for (const [label, overrides] of [
    ['createdAt > sentAt', { createdAt: '2026-09-07T01:02:03.300Z' }],
    ['sentAt > distributedAt', { sentAt: '2026-09-07T01:02:03.999Z' }],
    ['createdAt 형식', { createdAt: '2026-09-07 01:02:03' }],
    ['sentAt 형식', { sentAt: 'today' }],
  ]) {
    const file = fileOf(payload(overrides));
    const r = normalizeFile(file.name, file.text);
    assert.equal(r.ok, false, label);
  }
  // 같은 밀리초는 허용한다(송고와 배부가 한 ms 안에 끝나는 서버가 있다).
  const same = fileOf(payload({ createdAt: T_DIST, sentAt: T_DIST }));
  assert.equal(normalizeFile(same.name, same.text).ok, true);
  // sentAt 이 없는 파일(있을 수 없지만)은 사슬에서 빠질 뿐 실패가 아니다 — 키 부재는 바이트 대조가 잡는다.
  const noSent = fileOf(payload({}, { drop: ['sentAt'] }));
  const r = normalizeFile(noSent.name, noSent.text);
  assert.equal(r.ok, true);
  assert.equal(r.blinded, PLACEHOLDER_KEYS.length - 1 + 2);
});

test('중복 키 · 비객체 · 깨진 JSON 은 정규화 단계에서 실패한다', () => {
  const dup = '{"articleId":"AKR20260907000000001","title":"a","title":"b","distributedAt":"' + T_DIST + '"}';
  const r = normalizeFile(`AKR20260907000000001_${compactStamp(T_DIST)}.json`, dup);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('중복')), JSON.stringify(r.errors));
  assert.equal(normalizeFile('AKR20260907000000001_20260907T010203456Z.json', '[1]').ok, false);
  assert.equal(normalizeFile('AKR20260907000000001_20260907T010203456Z.json', '{"a":').ok, false);
  assert.equal(normalizeFile('.AKR20260907000000001_20260907T010203456Z.json.tmp', '{}').ok, false, '.tmp 잔존은 실패다');
});

// --- 비교 ---

test('같은 파일 2벌(articleId·시각만 다름) → diffs 0 · 파일 1 · 눈감은 자리 6/6', () => {
  const r = pair();
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.diffs.length, 0);
  assert.equal(r.fileCount, 1);
  assert.deepEqual(r.blinded, { a: 6, b: 6 });
  assert.equal(formatSummary(r), 'spool-parity A=node B=spring 폴더 1 · 파일 1 · diffs 0 · 눈감은 자리 A=6 B=6 → ok');
});

test('키 순서만 다른 2벌 → diffs ≥ 1(순서가 곧 산출물이다 — Q2)', () => {
  const a = side('node', [{ step: 'ga', file: fileOf(payload()) }]);
  const reordered = payload({ articleId: 'AKR20260907000000002' });
  const { markupVersion, ...rest } = reordered;
  const b = side('spring', [{ step: 'ga', file: fileOf({ markupVersion, ...rest }) }]);
  const r = compareSpools(a, b);
  assert.equal(r.ok, false);
  assert.ok(r.diffs.length >= 1);
  assert.equal(JSON.parse(a.files[0].text).title, JSON.parse(b.files[0].text).title, '의미는 같다 — 바이트만 다르다');
});

test('\\uAC00 대소문자만 다른 2벌 → diffs ≥ 1(이스케이프 표기가 산출물이다 — Q3)', () => {
  const a = side('node', [{ step: 'ga', file: fileOf(payload({ title: 'x\u001bx' })) }]);
  const bObj = payload({ articleId: 'AKR20260907000000002', title: 'x\u001bx' });
  const bText = JSON.stringify(bObj).replace('\\u001b', '\\u001B');
  assert.notEqual(bText, JSON.stringify(bObj), '픽스처가 실제로 대문자를 담아야 한다');
  const b = side('spring', [{ step: 'ga', file: { folder: SPOOL_FOLDERS.press, name: `${bObj.articleId}_${compactStamp(bObj.distributedAt)}.json`, text: bText } }]);
  const r = compareSpools(a, b);
  assert.equal(r.ok, false);
  assert.ok(r.diffs.length >= 1);
  assert.equal(JSON.parse(a.files[0].text).title, JSON.parse(bText).title, '의미는 같다');
  // 한글 자체(가 = 가)를 한쪽만 \u 표기로 쓰면 그것도 diff 다(의미는 같다).
  const plainA = side('node', [{ step: 'ga', file: fileOf(payload()) }]);
  const cObj = payload({ articleId: 'AKR20260907000000002' });
  const cText = JSON.stringify(cObj).replace('제목 가', '제목 \\uAC00');
  assert.notEqual(cText, JSON.stringify(cObj));
  assert.equal(JSON.parse(cText).title, JSON.parse(plainA.files[0].text).title);
  const c = side('spring', [{ step: 'ga', file: { folder: SPOOL_FOLDERS.press, name: `${cObj.articleId}_${compactStamp(cObj.distributedAt)}.json`, text: cText } }]);
  assert.ok(compareSpools(plainA, c).diffs.length >= 1);
});

test('자리표시자 밖 키의 값이 다르면 → diffs ≥ 1 · 자리표시자 키의 값 차이는 0', () => {
  assert.ok(pair({}, { title: '다른 제목' }).diffs.length >= 1);
  assert.ok(pair({}, { status: 'EPS' }).diffs.length >= 1);
  assert.equal(pair({}, { distributedAt: '2026-09-07T09:09:09.009Z', sentAt: '2026-09-07T09:09:09.008Z', createdAt: '2026-09-07T09:09:09.007Z' }).diffs.length, 0);
});

test('키가 하나 빠지거나(Q1) 하나 늘면(Q5 — internalComment) → diffs ≥ 1', () => {
  assert.ok(pair({}, {}, { bOpts: { drop: ['keyword'] } }).diffs.length >= 1, '키 제거');
  const grown = pair({}, { internalComment: '내부 코멘트' });
  assert.ok(grown.diffs.length >= 1, '키 증가 — allowlist 확대를 잡는다');
  const lines = formatDiffLines(grown);
  assert.ok(lines.some((l) => l.includes('internalComment')), '차이 줄에 늘어난 키가 보인다: ' + lines.join('\n'));
  assert.ok(pair({}, { region: null }).diffs.length >= 1, 'null 키 보존(Q4)도 잡는다');
});

test('파일 수가 다르면 즉시 실패 — 바이트 비교 전 · diffs 는 비어 있다', () => {
  const a = side('node', [{ step: 'ga', file: fileOf(payload()) }, { step: 'ma', file: fileOf(payload({ articleId: 'AKR20260907000000003' })) }]);
  const b = side('spring', [{ step: 'ga', file: fileOf(payload({ articleId: 'AKR20260907000000002' })) }]);
  const r = compareSpools(a, b);
  assert.equal(r.ok, false);
  assert.equal(r.diffs.length, 0);
  assert.ok(r.failures.some((f) => f.includes('파일 수')), JSON.stringify(r.failures));
  assert.equal(formatSummary(r).endsWith('→ FAILED'), true);
});

test('수신처 폴더 집합·폴더별 파일 수가 다르면 실패', () => {
  const a = side('node', [{ step: 'ga', file: fileOf(payload(), { folder: 'sp-press' }) }]);
  const b = side('spring', [{ step: 'ga', file: fileOf(payload({ articleId: 'AKR20260907000000002' }), { folder: 'sp-nonpress' }) }]);
  const r = compareSpools(a, b);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('폴더')), JSON.stringify(r.failures));
});

test('시나리오 순번에 없는 articleId 의 파일은 실패(짝짓기는 정렬이 아니라 순번이다 — Q8 의 방어선)', () => {
  const a = side('node', [{ step: 'ga', file: fileOf(payload()) }]);
  a.steps = {}; // 순번 표에서 지운다
  const b = side('spring', [{ step: 'ga', file: fileOf(payload({ articleId: 'AKR20260907000000002' })) }]);
  const r = compareSpools(a, b);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('순번')), JSON.stringify(r.failures));
  // 같은 순번 키에 한쪽만 파일이 있으면 실패(파일 수가 같아도).
  const c = side('spring', [{ step: 'ma', file: fileOf(payload({ articleId: 'AKR20260907000000002' })) }]);
  const r2 = compareSpools(side('node', [{ step: 'ga', file: fileOf(payload()) }]), c);
  assert.equal(r2.ok, false);
  assert.ok(r2.failures.some((f) => f.includes('한쪽')), JSON.stringify(r2.failures));
  assert.deepEqual(stepsByArticle({ ga: 'A1', ma: 'A2' }), { A1: 'ga', A2: 'ma' });
});

// --- 시나리오 계획 — Q3·Q5 를 공허하게 만들지 않는 표본 ---

test('시나리오 계획은 5축이고 (마)가 제어문자 9자 중 하나·한글·이모지·따옴표·개행·백슬래시·U+2028·DEL·<>& 와 비어 있지 않은 internalComment 를 담는다', () => {
  const plan = buildScenarioPlan(Date.parse('2026-09-07T03:00:00.000Z'));
  assert.deepEqual(plan.steps.map((s) => s.id), ['ga', 'na', 'da', 'ra', 'ma']);
  const by = Object.fromEntries(plan.steps.map((s) => [s.id, s]));
  assert.equal(by.ga.body.embargoAt, undefined); assert.equal(by.ga.body.secondEmbargoAt, undefined);
  assert.equal(by.na.body.embargoAt, undefined); assert.equal(by.na.body.secondEmbargoAt, '2026-09-07T02:30:00.000Z');
  assert.equal(by.da.body.embargoAt, '2026-09-07T02:00:00.000Z'); assert.equal(by.da.body.secondEmbargoAt, undefined);
  assert.equal(by.ra.retry, true);
  assert.deepEqual(by.na.tickKinds, ['nonpress']); assert.deepEqual(by.da.tickKinds, ['press']);
  const sample = `${by.ma.body.title}\n${by.ma.body.keyword}\n${by.ma.body.externalComment}`;
  assert.ok(LOWERCASE_HEX_CHARS.some((c) => by.ma.body.title.includes(String.fromCharCode(c))), '제목에 소문자 16진 이스케이프 표본(0x0B/0x0E/0x0F/0x1A~0x1F)이 없으면 Q3 가 공허하다');
  for (const [label, needle] of [['한글', /[가-힣]/], ['이모지(서로게이트 쌍)', /[\uD83D][\uDE00-\uDEFF]/], ['따옴표', /"/], ['개행', /\n/], ['탭', /\t/], ['백슬래시', /\\/], ['U+2028', /\u2028/], ['DEL', /\u007f/], ['<>&', /<>&/], ['슬래시', /\//]]) {
    assert.ok(needle.test(sample), `(마) 표본에 ${label} 가 없다`);
  }
  assert.ok(typeof by.ma.body.internalComment === 'string' && by.ma.body.internalComment.length > 0, 'internalComment 가 비어 있으면 Q5 가 공허하다');
  assert.ok(by.ma.roundTrip.length >= 2 && by.ma.roundTrip.includes('title') && by.ma.roundTrip.includes('internalComment'));
  // 본문에는 끝 마커가 있어야 송고된다.
  for (const s of plan.steps) assert.ok(JSON.parse(s.body.markupVersion).blocks.at(-1).text === '(끝)', `${s.id} 끝 마커`);
  assert.deepEqual(expectedFolderCounts(plan), { 'sp-press': 5, 'sp-nonpress': 4, 'sp-retry': 2 });
  assert.deepEqual(plan.targets.map((t) => [t.kind, t.spoolDir]), [['press', 'sp-press'], ['nonpress', 'sp-nonpress']]);
  assert.deepEqual(plan.retryTarget, { name: 'retry-target', kind: 'press', spoolDir: 'sp-retry' });
});
