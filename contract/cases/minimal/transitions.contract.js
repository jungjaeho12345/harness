// 계약 케이스: POST /api/articles/:id/action(인벤토리 id 'articles-action', #24) ·
//              POST /api/articles/:id/derive(id 'articles-derive', #25) — **minimal 프로파일**.
//
// 프로파일 근거(결정성): minimal은 DIST_SPOOL_DIR 미설정 → src/controllers/index.js 74~95행에서
//   spoolWriter·distributionService가 아예 결선되지 않는다 → articleService의 송고 훅(비동기 배부 →
//   syncEmbargoStatus 승격 DES→EPS→DPS)이 발화하지 않는다. 따라서 "송고 후 status"가 전이표만으로
//   결정된다. default 프로파일은 배부가 켜져 있어 같은 요청이 관측 시점에 따라 다른 status가 될 수 있다
//   (그 축은 step10이 default에서 소유한다).
//
// 예측(케이스 실행 **전에** 코드에서 옮긴 표 — src/services/lifecycle.js 12~25행이 정본):
//   R(REPORTER_TABLE): RDS{send→RDS(유지), hold→RRH, kill→RRK}. 그 외 status·approveDelete는 전부 거부.
//   D·Z(DESK_TABLE, 두 role 동일): RDS{send→DPS, hold→DDH, kill→DDK} · DPS{send→DPS, hold→DDH,
//     approveDelete→DPD} · DDH{send→DPS, kill→DDK} · EPS{kill→EEK, hold→EEH} · DES{kill→EEK, hold→EEH}.
//   표 밖 칸 = 409 forbidden-transition(server/index.js 882행 fail(res, r, 409) + 전역 매핑 409).
//   정의 외/누락 action = 400 unknown-action(라우트 직접) · 정의 외/누락 mode = 400 unknown-mode(라우트 직접).
//   없는 기사 = 404 not-found · 미인증 = 401 unauthenticated.
//   send 가드 순서(계약): ① 전이 판정 → ② "(끝)" 마커 검사(400 no-end-marker) → ③ 엠바고 DES 후처리 →
//     ④ sender/sentAt stamp + status 저장 → ⑤ 이력(eventType:'status') 기록. 전이가 불가하면 마커 검사에
//     도달하지 않는다(articleService.js 204~238행).
//   엠바고 진입: DES_ENTRY_STATUSES={RDS,DDH} + role D|Z + 전이결과 DPS + (embargoAt||secondEmbargoAt) → DES.
//   derive: 새 articleId·status RDS·author=세션 사용자, 원본 무변경(create만 호출 — articleService.js 311~339행).
//
// **미검증(도달 불가)**: EPS발 전이 2칸(EPS+D/Z: kill→EEK, hold→EEH)과 unknown-role 403.
//   EPS는 "실제 배부가 일어난 뒤" syncEmbargoStatus가 만드는 상태라 배부가 꺼진 minimal에서는 API로
//   도달할 수 없고, unknown-role은 라우트의 ROLES 게이트를 시드 계정(R/D/Z)으로는 통과할 수 없다.
//   DB를 직접 건드려 만들지 않는다(계약 스위트는 API로만 말한다) — 미동결로 명세·요약에 남긴다.
//
// 규율: 서버 코드 import 금지 · 비밀번호 미사용(actor/sid만) · 절대 개수 단언 금지(자기 픽스처만) ·
//   고정 sleep 금지 · 응답만 믿지 않고 GET으로 되읽어 단언 · 이력은 **존재**만 단언(개수 금지) ·
//   리포트에는 articleId·시각·사용자 식별자를 싣지 않는다(불리언·상태 문자열만).

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';
import { actor, sid } from '../../lib/session.js';
import { createArticle, acquireLock, unique } from '../../lib/fixtures.js';

requireProfile('minimal');

const ACTION = 'articles-action';
const DERIVE = 'articles-derive';

// 엠바고 컬럼은 "설정 여부"만 전이에 관여한다(시각 비교 없음 — articleService.js 218행) — 미래 시각으로 둔다.
const future = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();

const body = (markers) => JSON.stringify({ format: 'yh-editor', version: 1, blocks: markers.map((text) => ({ text })) });

async function action(articleId, role, act) {
  return api('POST', `/api/articles/${articleId}/action`, { sid: sid(role), body: { action: act } });
}

async function derive(articleId, role, mode) {
  return api('POST', `/api/articles/${articleId}/derive`, { sid: sid(role), body: { mode } });
}

// 되읽기 — 응답 본문만 믿지 않는다(응답과 DB가 갈라지는 결함을 잡는 유일한 수단).
async function readArticle(articleId, role = 'D') {
  const res = await api('GET', `/api/articles/${articleId}`, { sid: sid(role) });
  if (res.status !== 200 || res.json?.ok !== true) {
    throw new Error(`되읽기 실패: status=${res.status} reason=${res.json?.reason ?? '-'}`);
  }
  return res.json;
}

const readStatus = async (articleId) => (await readArticle(articleId)).contents.status;

// 픽스처 전이(단언이 아니라 상태 도달 수단) — 실패는 계약 실패가 아니라 픽스처 실패로 구분해 던진다.
async function moveTo(articleId, role, act, expected) {
  const res = await action(articleId, role, act);
  if (res.status !== 200 || res.json?.ok !== true || res.json.status !== expected) {
    throw new Error(`픽스처 전이 실패(${role}/${act}→${expected}): status=${res.status} reason=${res.json?.reason ?? '-'} got=${res.json?.status ?? '-'}`);
  }
  return articleId;
}

// 각 status에 도달하는 경로 — **이미 동결한 라우트(create·action)만** 쓴다(DB 직접 조작 금지).
async function reach(status) {
  if (status === 'RDS') return (await createArticle('D')).articleId;
  if (status === 'DPS') return moveTo(await reach('RDS'), 'D', 'send', 'DPS');
  if (status === 'DDH') return moveTo(await reach('RDS'), 'D', 'hold', 'DDH');
  if (status === 'DDK') return moveTo(await reach('RDS'), 'D', 'kill', 'DDK');
  if (status === 'RRH') return moveTo(await reach('RDS'), 'R', 'hold', 'RRH');
  if (status === 'RRK') return moveTo(await reach('RDS'), 'R', 'kill', 'RRK');
  if (status === 'DPD') return moveTo(await reach('DPS'), 'D', 'approveDelete', 'DPD');
  if (status === 'DES') {
    const { articleId } = await createArticle('D', { embargoAt: future(24) });
    return moveTo(articleId, 'D', 'send', 'DES');
  }
  // EPS는 배부가 실제로 일어나야 생기는 상태라 minimal에서 도달 불가(위 '미검증' 주석).
  throw new Error(`도달 경로가 정의되지 않은 status: ${status}`);
}

// --- A. 인가 ---

test('POST /api/articles/:id/action — 미인증 401 unauthenticated', async () => {
  const { articleId } = await createArticle('D');
  const res = await api('POST', `/api/articles/${articleId}/action`, { body: { action: 'hold' } });

  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.reason, 'unauthenticated');
  assert.equal(await readStatus(articleId), 'RDS'); // 전이가 일어나지 않았다는 음성 증거.

  record(ACTION, 'unauthenticated', {
    ...fromResponse(res, { values: { readBackStatus: 'RDS' } }),
    caseId: 'action-no-session',
  });
});

test('POST /api/articles/:id/derive — 미인증 401 unauthenticated', async () => {
  const { articleId } = await createArticle('D');
  const res = await api('POST', `/api/articles/${articleId}/derive`, { body: { mode: 'followUp' } });

  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.reason, 'unauthenticated');

  record(DERIVE, 'unauthenticated', { ...fromResponse(res), caseId: 'derive-no-session' });
});

test('POST /api/articles/:id/action — 없는 기사 404 not-found', async () => {
  const res = await action('AKR99999999999999999', 'D', 'send');

  assert.equal(res.status, 404);
  assert.equal(res.json.reason, 'not-found');

  record(ACTION, 'not-found', { ...fromResponse(res), caseId: 'action-missing-article' });
});

test('POST /api/articles/:id/derive — 없는 기사 404 not-found', async () => {
  const res = await derive('AKR99999999999999999', 'D', 'followUp');

  assert.equal(res.status, 404);
  assert.equal(res.json.reason, 'not-found');

  record(DERIVE, 'not-found', { ...fromResponse(res), caseId: 'derive-missing-article' });
});

// --- B. 입력 검증 ---

test('POST /api/articles/:id/action — 정의 외 action·action 누락은 400 unknown-action', async () => {
  const { articleId } = await createArticle('D');

  const bogus = await api('POST', `/api/articles/${articleId}/action`, { sid: sid('D'), body: { action: 'bogus' } });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.json.reason, 'unknown-action');

  const missing = await api('POST', `/api/articles/${articleId}/action`, { sid: sid('D'), body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.reason, 'unknown-action');

  assert.equal(await readStatus(articleId), 'RDS'); // 검증 거부는 상태를 건드리지 않는다.

  record(ACTION, 'validation', { ...fromResponse(bogus), caseId: 'unknown-action' });
  record(ACTION, 'validation', { ...fromResponse(missing), caseId: 'missing-action' });
});

test('POST /api/articles/:id/derive — 정의 외 mode·mode 누락은 400 unknown-mode', async () => {
  const { articleId } = await createArticle('D');

  const bogus = await api('POST', `/api/articles/${articleId}/derive`, { sid: sid('D'), body: { mode: 'bogus' } });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.json.reason, 'unknown-mode');

  const missing = await api('POST', `/api/articles/${articleId}/derive`, { sid: sid('D'), body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.reason, 'unknown-mode');

  record(DERIVE, 'validation', { ...fromResponse(bogus), caseId: 'unknown-mode' });
  record(DERIVE, 'validation', { ...fromResponse(missing), caseId: 'missing-mode' });
});

// --- C. 전이 매트릭스: 허용 칸 전수(EPS발 2칸은 도달 불가 — 미검증) ---

const ALLOWED = [
  // D(데스크) — DESK_TABLE 전수 중 도달 가능한 8칸.
  { from: 'RDS', role: 'D', act: 'send', to: 'DPS' },
  { from: 'RDS', role: 'D', act: 'hold', to: 'DDH' },
  { from: 'RDS', role: 'D', act: 'kill', to: 'DDK' },
  { from: 'DPS', role: 'D', act: 'send', to: 'DPS' }, // 재송고 — 상태 유지
  { from: 'DPS', role: 'D', act: 'hold', to: 'DDH' },
  { from: 'DPS', role: 'D', act: 'approveDelete', to: 'DPD' },
  { from: 'DDH', role: 'D', act: 'send', to: 'DPS' },
  { from: 'DDH', role: 'D', act: 'kill', to: 'DDK' },
  { from: 'DES', role: 'D', act: 'kill', to: 'EEK' },
  { from: 'DES', role: 'D', act: 'hold', to: 'EEH' },
  // Z(관리자)는 D와 동일 표를 쓴다 — 대표 3칸으로 동형을 못 박는다.
  { from: 'RDS', role: 'Z', act: 'send', to: 'DPS' },
  { from: 'RDS', role: 'Z', act: 'hold', to: 'DDH' },
  { from: 'DPS', role: 'Z', act: 'approveDelete', to: 'DPD' },
  // R(기자) — REPORTER_TABLE 전수 3칸.
  { from: 'RDS', role: 'R', act: 'send', to: 'RDS' }, // 최초 송고는 RDS 유지(데스크 대기)
  { from: 'RDS', role: 'R', act: 'hold', to: 'RRH' },
  { from: 'RDS', role: 'R', act: 'kill', to: 'RRK' },
];

for (const cell of ALLOWED) {
  test(`전이 허용 — ${cell.from} + ${cell.role} + ${cell.act} → ${cell.to}`, async () => {
    const articleId = await reach(cell.from);
    const res = await action(articleId, cell.role, cell.act);

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['ok', 'status']);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.status, cell.to);

    // 되읽기 — 응답과 DB가 갈라지지 않는지(전이는 보고했는데 저장이 안 된 결함 탐지).
    const after = await readArticle(articleId);
    assert.equal(after.contents.status, cell.to);
    assert.equal(after.contents.articleId, articleId); // approveDelete(DPD)도 **행이 남는다**(DB 비파괴).

    record(ACTION, 'success', {
      ...fromResponse(res, {
        values: {
          fromStatus: cell.from, role: cell.role, action: cell.act,
          status: res.json.status, readBackStatus: after.contents.status,
        },
      }),
      caseId: `allow-${cell.from}-${cell.role}-${cell.act}`,
    });
  });
}

// --- D. 거부 칸(전이표 밖) ---

const REJECTED = [
  { from: 'DPS', role: 'R', act: 'send' }, // R은 RDS 기사만 다룬다
  { from: 'RDS', role: 'R', act: 'approveDelete' }, // R에게 삭제승인 칸이 없다
  { from: 'DDH', role: 'D', act: 'hold' }, // 이미 보류
  { from: 'RRK', role: 'D', act: 'send' }, // 기자 KILL 상태는 데스크 표에 없다
  { from: 'DPD', role: 'D', act: 'send' }, // 삭제승인 이후는 종착
];

for (const cell of REJECTED) {
  test(`전이 거부 — ${cell.from} + ${cell.role} + ${cell.act} → 409 forbidden-transition`, async () => {
    const articleId = await reach(cell.from);
    const res = await action(articleId, cell.role, cell.act);

    assert.equal(res.status, 409);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.reason, 'forbidden-transition');
    assert.equal(await readStatus(articleId), cell.from); // 거부는 상태를 건드리지 않는다.

    record(ACTION, 'conflict', {
      ...fromResponse(res, {
        values: { fromStatus: cell.from, role: cell.role, action: cell.act, readBackStatus: cell.from },
      }),
      caseId: `deny-${cell.from}-${cell.role}-${cell.act}`,
    });
  });
}

// --- E. "(끝)" 마커 게이트 ---

test('send — 본문에 "(끝)"이 없으면 400 no-end-marker이고 상태는 그대로다', async () => {
  const { articleId } = await createArticle('D', { endMarker: false });

  const res = await action(articleId, 'D', 'send');
  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.reason, 'no-end-marker');
  assert.equal(await readStatus(articleId), 'RDS'); // 전이가 일어나지 않았다는 음성 증거.

  record(ACTION, 'validation', {
    ...fromResponse(res, { values: { fromStatus: 'RDS', action: 'send', readBackStatus: 'RDS' } }),
    caseId: 'no-end-marker',
  });
});

test('send 가드 순서 — 전이 판정이 마커 검사보다 먼저다(마커 없는 DDK send는 409)', async () => {
  const { articleId } = await createArticle('D', { endMarker: false });
  await moveTo(articleId, 'D', 'kill', 'DDK');

  const res = await action(articleId, 'D', 'send');
  // 마커도 없고 전이도 불가한 입력 — 계약은 **전이 거부(409)**다(400 no-end-marker가 아니다).
  assert.equal(res.status, 409);
  assert.equal(res.json.reason, 'forbidden-transition');

  record(ACTION, 'conflict', {
    ...fromResponse(res, { values: { fromStatus: 'DDK', action: 'send', markerPresent: false } }),
    caseId: 'order-transition-before-marker',
  });
});

test('send — 마커를 넣어 저장(잠금+PUT)한 뒤 다시 송고하면 200 DPS', async () => {
  const { articleId } = await createArticle('D', { endMarker: false });
  const clientId = unique('ct-tab');
  await acquireLock(articleId, 'D', clientId);

  const put = await api('PUT', `/api/articles/${articleId}`, {
    sid: sid('D'),
    headers: { 'x-edit-client': clientId },
    body: { markupVersion: body(['마커를 추가한 본문.', '(끝)']) },
  });
  if (put.status !== 200 || put.json?.ok !== true) {
    throw new Error(`픽스처 실패 PUT(마커 추가): status=${put.status} reason=${put.json?.reason ?? '-'}`);
  }

  const res = await action(articleId, 'D', 'send');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'DPS');
  assert.equal(await readStatus(articleId), 'DPS');

  record(ACTION, 'success', {
    ...fromResponse(res, { values: { fromStatus: 'RDS', action: 'send', status: 'DPS', markerAddedByUpdate: true } }),
    caseId: 'marker-added-then-send',
  });
});

// --- F. 송고 stamp ---

test('send 성공 — sender는 세션 사용자, sentAt은 비어 있지 않다(값 자체는 휘발이라 단언 대상 아님)', async () => {
  const articleId = await reach('RDS');
  const before = await readArticle(articleId);
  assert.equal(before.contents.sender, null);
  assert.equal(before.contents.sentAt, null);

  const res = await action(articleId, 'D', 'send');
  assert.equal(res.status, 200);

  const after = await readArticle(articleId);
  assert.equal(after.contents.sender, actor('D').userId);
  assert.equal(typeof after.contents.sentAt, 'string');
  assert.notEqual(after.contents.sentAt, '');

  record(ACTION, 'success', {
    ...fromResponse(res, {
      values: {
        status: res.json.status,
        senderIsSessionUser: after.contents.sender === actor('D').userId,
        sentAtPresent: Boolean(after.contents.sentAt),
      },
    }),
    caseId: 'send-stamp',
  });
});

// --- G. 엠바고 송고의 DES 진입 ---

const EMBARGO = [
  { label: 'first', fields: { embargoAt: future(24) } },
  { label: 'second-only', fields: { secondEmbargoAt: future(48) } },
  { label: 'both', fields: { embargoAt: future(24), secondEmbargoAt: future(48) } },
];

for (const variant of EMBARGO) {
  test(`엠바고(${variant.label}) 기사를 D가 RDS에서 송고하면 DPS가 아니라 DES다`, async () => {
    const { articleId } = await createArticle('D', variant.fields);

    const res = await action(articleId, 'D', 'send');
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'DES');
    assert.equal(await readStatus(articleId), 'DES');

    record(ACTION, 'success', {
      ...fromResponse(res, { values: { fromStatus: 'RDS', embargo: variant.label, status: 'DES' } }),
      caseId: `embargo-${variant.label}-send`,
    });
  });
}

test('엠바고 기사가 DDH에서 송고돼도 DES다(DES 진입 상태는 RDS·DDH 둘 다)', async () => {
  const { articleId } = await createArticle('D', { embargoAt: future(24) });
  await moveTo(articleId, 'D', 'hold', 'DDH');

  const res = await action(articleId, 'D', 'send');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'DES');
  assert.equal(await readStatus(articleId), 'DES');

  record(ACTION, 'success', {
    ...fromResponse(res, { values: { fromStatus: 'DDH', embargo: 'first', status: 'DES' } }),
    caseId: 'embargo-from-ddh-send',
  });
});

test('엠바고 기사라도 R의 송고는 RDS 유지다(DES 진입은 D·Z 전이결과 DPS일 때만)', async () => {
  const { articleId } = await createArticle('D', { embargoAt: future(24) });

  const res = await action(articleId, 'R', 'send');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'RDS');
  assert.equal(await readStatus(articleId), 'RDS');

  record(ACTION, 'success', {
    ...fromResponse(res, { values: { fromStatus: 'RDS', role: 'R', embargo: 'first', status: 'RDS' } }),
    caseId: 'embargo-role-R-send', // 라벨에 시드 userId 문자열을 쓰지 않는다(리포트 마스킹 규율).
  });
});

// --- H. 이력 부수효과(개수가 아니라 존재만 단언한다) ---

test('전이 성공 후 이력에 eventType:status + action/fromStatus/toStatus 행이 생긴다', async () => {
  const articleId = await reach('RDS');
  const res = await action(articleId, 'D', 'hold');
  assert.equal(res.json.status, 'DDH');

  const history = await api('GET', `/api/articles/${articleId}/history`, { sid: sid('D') });
  assert.equal(history.status, 200);
  assert.equal(history.json.ok, true);
  const row = history.json.items.find(
    (it) => it.eventType === 'status' && it.action === 'hold'
      && it.fromStatus === 'RDS' && it.toStatus === 'DDH',
  );
  assert.ok(row, '이 전이에 해당하는 status 이력 행이 존재해야 한다');
  assert.equal(row.actorUserId, actor('D').userId);

  record(ACTION, 'success', {
    ...fromResponse(res, {
      values: { status: 'DDH', historyStatusRowExists: true, historyActorIsSessionUser: row.actorUserId === actor('D').userId },
    }),
    caseId: 'history-status-row',
  });
});

// --- I. derive: 새 기사 생성 + 원본 불변 ---

const DERIVE_MODES = [
  { mode: 'followUp', bodyCopied: false }, // 후속: 주제만 이어받고 본문은 빈값
  { mode: 'continue', bodyCopied: true }, // 계속: 원문 본문 복사
];

for (const variant of DERIVE_MODES) {
  test(`derive(${variant.mode}) — 새 기사(RDS·세션 author)를 만들고 원본은 한 글자도 바뀌지 않는다`, async () => {
    const { articleId, title } = await createArticle('D');
    const before = await readArticle(articleId);

    const res = await derive(articleId, 'D', variant.mode);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['articleId', 'ok']);
    assert.equal(res.json.ok, true);
    assert.equal(typeof res.json.articleId, 'string');
    assert.notEqual(res.json.articleId, articleId); // 새 articleId

    const created = await readArticle(res.json.articleId);
    assert.equal(created.contents.status, 'RDS');
    assert.equal(created.contents.author, actor('D').name ?? actor('D').userId);
    assert.equal(created.article.title, title); // 제목은 출발점으로 복사
    if (variant.bodyCopied) assert.equal(created.article.markupVersion, before.article.markupVersion);
    else assert.equal(created.article.markupVersion, ''); // followUp은 빈 본문

    // 원본 불변 — article·contents 전체를 그대로 비교한다(이 케이스의 핵심 단언).
    const after = await readArticle(articleId);
    assert.deepEqual(after.article, before.article);
    assert.deepEqual(after.contents, before.contents);

    record(DERIVE, 'success', {
      ...fromResponse(res, {
        values: {
          mode: variant.mode,
          newArticleIdDiffers: res.json.articleId !== articleId,
          newStatus: created.contents.status,
          newAuthorIsSessionUser: created.contents.author === (actor('D').name ?? actor('D').userId),
          titleCopied: created.article.title === title,
          bodyCopied: created.article.markupVersion === before.article.markupVersion,
          sourceUnchanged: JSON.stringify(after) === JSON.stringify(before),
        },
      }),
      caseId: `derive-${variant.mode}`,
    });
  });
}

test('derive — 복사 필드 실측(공통정보 복사 · 엠바고 초기화 · 송고 stamp/부서 미복사)', async () => {
  const fields = {
    coAuthor: unique('ct-coauthor'),
    category: unique('ct-category'),
    region: unique('ct-region'),
    attribute: unique('ct-attribute'),
    keyword: unique('ct-keyword'),
    internalComment: unique('ct-internal'),
    externalComment: unique('ct-external'),
    attachmentFile: '/uploads/ct-attach.png',
    referenceFile: '/uploads/ct-ref.png',
    department: unique('ct-dept'),
    departmentCode: 'CTD',
    embargoAt: future(24),
  };
  const { articleId } = await createArticle('D', fields);
  await moveTo(articleId, 'D', 'send', 'DES'); // 송고 stamp(sender/sentAt) + 엠바고 상태를 가진 원본
  const before = await readArticle(articleId);

  const res = await derive(articleId, 'R', 'continue');
  assert.equal(res.status, 200);
  const created = await readArticle(res.json.articleId);

  // 복사되는 것: 제목·본문(continue)·공통정보 9필드.
  const COPIED = ['coAuthor', 'category', 'region', 'attribute', 'keyword',
    'internalComment', 'externalComment', 'attachmentFile', 'referenceFile'];
  for (const key of COPIED) assert.equal(created.contents[key], before.contents[key], `${key}는 복사된다`);
  assert.equal(created.article.title, before.article.title);
  assert.equal(created.article.markupVersion, before.article.markupVersion);

  // 초기화되는 것: 엠바고 2컬럼(빈 문자열).
  assert.equal(created.contents.embargoAt, '');
  assert.equal(created.contents.secondEmbargoAt, '');

  // 복사되지 않는 것: 생애주기·송고 stamp·부서(derive dto에 없어 NULL) — author는 파생 실행자.
  assert.equal(created.contents.status, 'RDS');
  assert.equal(created.contents.sender, null);
  assert.equal(created.contents.sentAt, null);
  assert.equal(created.contents.distributedAt, null);
  assert.equal(created.contents.department, null);
  assert.equal(created.contents.departmentCode, null);
  assert.equal(created.contents.author, actor('R').name ?? actor('R').userId);

  // 원본 불변(엠바고·송고 stamp 포함 전체).
  const after = await readArticle(articleId);
  assert.deepEqual(after.article, before.article);
  assert.deepEqual(after.contents, before.contents);

  record(DERIVE, 'success', {
    ...fromResponse(res, {
      values: {
        mode: 'continue',
        commonFieldsCopied: COPIED.every((k) => created.contents[k] === before.contents[k]),
        embargoReset: created.contents.embargoAt === '' && created.contents.secondEmbargoAt === '',
        departmentCopied: created.contents.department !== null,
        sendStampCopied: created.contents.sender !== null || created.contents.sentAt !== null,
        newStatus: created.contents.status,
        sourceUnchanged: JSON.stringify(after) === JSON.stringify(before),
      },
    }),
    caseId: 'derive-copied-fields',
  });
});

test('derive 권한 — R·D·Z 모두 가능하고 DPS 기사에서도 파생된다(라우트는 ROLES 게이트만 본다)', async () => {
  const source = await reach('DPS');
  const before = await readArticle(source);

  for (const role of ['R', 'D', 'Z']) {
    const res = await derive(source, role, 'followUp');
    assert.equal(res.status, 200, `${role}의 derive는 허용된다`);
    assert.equal(res.json.ok, true);

    const created = await readArticle(res.json.articleId);
    assert.equal(created.contents.status, 'RDS'); // 원본이 DPS여도 새 기사는 RDS
    assert.equal(created.contents.author, actor(role).name ?? actor(role).userId);

    record(DERIVE, 'success', {
      ...fromResponse(res, {
        values: { role, sourceStatus: 'DPS', newStatus: created.contents.status, mode: 'followUp' },
      }),
      caseId: `derive-role-${role}-from-dps`,
    });
  }

  const after = await readArticle(source);
  assert.deepEqual(after.article, before.article);
  assert.deepEqual(after.contents, before.contents); // 3회 파생에도 원본 DPS는 불변
});
