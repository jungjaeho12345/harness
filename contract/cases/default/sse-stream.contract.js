// 계약 케이스: GET /api/stream (인벤토리 id 'stream') — default 프로파일.
// 동결 축(step11 A):
//   (1) 미인증은 **스트림을 열기 전** 401 JSON으로 끝난다(SSE 헤더가 나가지 않는다).
//   (2) 헤더 실측 + 첫 프레임 `event: ready` / `data: {"ok":true}` + **빈 줄 종결자**(원문 바이트 1건).
//   (3) 쿠키(`sid`) 인증으로도 동일하게 열린다 — EventSource는 커스텀 헤더를 못 보내므로 실사용 경로다.
//   (4) `change` payload는 키가 정확히 `kind` 하나다(행 데이터 없음 — ADR-005 무효화 신호).
//   (5) 같은 세션의 동시 연결 2개가 트리거 1회에 **둘 다** 신호를 받는다(SPA가 실제로 2개를 연다).
//   (6) 세션 무효화 후 첫 이벤트에서 `event: unauthorized` 1회 + 봉인(push 시점 비연장 peek — ADR-007).
// 규율: 서버 코드 import 금지(CONTRACT_BASE_URL로만) · 고정 sleep 금지(ready 선행 + 조건 대기 + 타임아웃) ·
//   프레임 개수/순서 단언 금지("유한 시간 안에 조건 프레임 도착"만) · 스트림은 finally에서 반드시 close ·
//   리포트 기록은 record/fromResponse로만.
//
// CRITICAL(공용 세션 파괴 + 복구 의무 — 스위트 규약): POST /api/login은 같은 userId의 기존 세션을
//   **전부** 무효화한다(단일 세션 정책). 아래 A-6은 R로 전용 로그인해 그 세션을 로그아웃으로 죽이므로
//   공용 R 세션도 함께 사라진다. 규약은 "로그인한 케이스는 그 역할의 공용 세션을 반드시 복구한다"이다 —
//   A-6은 계약 단언을 모두 마친 뒤 R로 재로그인해 republish('R', ...)(contract/lib/session.js)로 세션
//   파일을 갱신한다. 그래서 뒤에 정렬되는 users.contract.js는 sid('R')를 정상 세션으로 쓸 수 있다.
//   스트림·트리거 자체는 공용 픽스처와 같은 sid('D')/sid('Z')를 쓴다(전용 세션은 A-6 안에서만 산다).
// CRITICAL(로그인 예산, decisions (8)): 이 파일은 default에서 **정확히 2회** 로그인한다
//   (A-6 전용 세션 1 + 공용 R 복구 1). 프로파일 합계 = 러너 3 + auth.contract.js 2 + 여기 2 = 7 ≤ 10회/15분
//   (server/index.js loginLimiter). 대상 역할이 R인 이유: 소실 역할을 R 하나로 모으는 auth.contract.js 규약을 따른다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { api, BASE_URL } from '../../lib/http.js';
import { openStream } from '../../lib/sse.js';
import { sid, credentials, republish } from '../../lib/session.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';
import { createArticle, acquireLock, unique } from '../../lib/fixtures.js';

requireProfile('default');

// 조건 대기 한도 — 고정 sleep이 아니라 "이 시간 안에 조건 프레임이 오는가"의 상한이다.
const WAIT_MS = 10000;

// ready 프레임의 **원문 바이트**(server/index.js 1137행 리터럴과 동일해야 한다).
// 끝의 빈 줄(\n\n)이 SSE 프레임 종결자다 — 빠지면 브라우저가 이벤트를 디스패치하지 않는다.
const READY_FRAME = 'event: ready\ndata: {"ok":true}\n\n';
const UNAUTHORIZED_DATA = '{"ok":false,"reason":"unauthenticated"}';

// openStream 결과 → fromResponse 입력(api() 반환 shape). 마스킹·헤더 허용목록은 record.js가 소유한다.
// SSE 200은 본문 JSON이 없으므로 ok를 상태코드에서 도출한다(fromResponse의 res.ok 자리).
const asResponse = (s) => ({ status: s.status, ok: s.status >= 200 && s.status < 300, json: s.json, headers: s.headers });

// 프레임 **원문 바이트** 확인 전용(파서를 거친 결과만 보면 종결자 누락을 못 잡는다 — sse.js는 '\n\n'을
// 잘라 버린다). lib(openStream)이 원문을 노출하지 않으므로 이 케이스만 fetch로 직접 첫 프레임을 읽는다 —
// 접근 수단은 여전히 CONTRACT_BASE_URL 하나뿐이라 프레임워크 중립은 유지된다.
async function readRawFirstFrame(path, { sessionId }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAIT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { accept: 'text/event-stream', 'x-session-id': sessionId },
      signal: controller.signal,
    });
    if (!res.body) return { status: res.status, headers: res.headers, raw: '' };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    try {
      while (!raw.includes('\n\n')) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => { /* 취소 경합 — 무해 */ });
    }
    return { status: res.status, headers: res.headers, raw };
  } finally {
    clearTimeout(timer);
    controller.abort(); // 열린 커넥션을 남기지 않는다(러너 종료 지연 방지).
  }
}

// change 신호 1건 대기 + 계약 단언 + 기록. 트리거는 ready 수신 **후**에만 호출된다.
async function expectChange(stream, kind, trigger, caseId) {
  await trigger();
  const frame = await stream.waitFor((f) => f.event === 'change' && f.json?.kind === kind, WAIT_MS);
  assert.ok(frame, `change(kind=${kind}) 프레임이 ${WAIT_MS}ms 안에 도착해야 한다`);
  // 계약의 핵심: payload는 무효화 신호뿐이다 — 행 데이터(articleId·title·status 등)가 실리면 위반이다.
  assert.deepEqual(Object.keys(frame.json).sort(), ['kind']);
  record('stream', 'change', {
    status: 200,
    ok: true,
    reason: null,
    bodyKeys: Object.keys(frame.json).sort(),
    values: { event: 'change', kind, dataKeys: Object.keys(frame.json).sort().join(',') },
    caseId,
  });
  return frame;
}

// --- A-1 미인증: 스트림을 열기 전에 끝난다 ---

test('GET /api/stream — 세션 없으면 401 JSON(스트림을 열지 않는다)', async () => {
  const s = await openStream('/api/stream');
  try {
    assert.equal(s.status, 401);
    const ct = s.headers.get('content-type') ?? '';
    assert.match(ct, /application\/json/);
    assert.doesNotMatch(ct, /text\/event-stream/); // 열고 나서 오류 프레임을 보내는 구현은 위반이다.
    assert.deepEqual(s.json, { ok: false, reason: 'unauthenticated' });

    record('stream', 'unauthenticated', {
      ...fromResponse(asResponse(s), { values: { streamOpened: false } }),
      caseId: 'no-session',
    });
  } finally {
    s.close();
  }
});

// --- A-2 연결·ready ---

test('GET /api/stream — 세션 헤더로 200 event-stream + 첫 프레임 ready', async () => {
  const s = await openStream('/api/stream', { sid: sid('D') });
  try {
    assert.equal(s.status, 200);
    assert.equal(s.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(s.headers.get('cache-control'), 'no-cache');

    const ready = await s.waitFor((f) => f.event === 'ready', WAIT_MS);
    assert.ok(ready, `ready 프레임이 ${WAIT_MS}ms 안에 도착해야 한다`);
    assert.equal(ready.data, '{"ok":true}');
    assert.deepEqual(ready.json, { ok: true });

    record('stream', 'success', {
      ...fromResponse(asResponse(s), {
        values: { firstEvent: 'ready', firstData: ready.data },
        headers: ['content-type', 'cache-control'],
      }),
      caseId: 'ready-header-auth',
    });
  } finally {
    s.close();
  }
});

test('GET /api/stream — ready 프레임 원문 바이트가 빈 줄로 종결된다', async () => {
  const r = await readRawFirstFrame('/api/stream', { sessionId: sid('D') });

  assert.equal(r.status, 200);
  assert.ok(r.raw.includes('\n\n'), '프레임 종결자(빈 줄)가 원문에 있어야 한다');
  assert.equal(r.raw.startsWith(READY_FRAME), true, 'ready 프레임 원문 바이트가 계약과 정확히 같아야 한다');

  record('stream', 'frame-bytes', {
    status: r.status,
    ok: true,
    reason: null,
    bodyKeys: [],
    values: { readyFrameRaw: READY_FRAME, terminatedByBlankLine: true },
    caseId: 'ready-raw-bytes',
  });
});

// --- A-3 쿠키 인증(EventSource 실사용 경로) ---

test('GET /api/stream — 쿠키(sid)만으로도 열린다(EventSource 경로)', async () => {
  const s = await openStream('/api/stream', { headers: { cookie: `sid=${sid('D')}` } });
  try {
    assert.equal(s.status, 200);
    assert.match(s.headers.get('content-type') ?? '', /text\/event-stream/);
    const ready = await s.waitFor((f) => f.event === 'ready', WAIT_MS);
    assert.ok(ready, 'ready 프레임(쿠키 인증)');
    assert.deepEqual(ready.json, { ok: true });

    record('stream', 'success', {
      ...fromResponse(asResponse(s), {
        values: { firstEvent: 'ready', auth: 'cookie' },
        headers: ['content-type', 'cache-control'],
      }),
      caseId: 'ready-cookie-auth',
    });
  } finally {
    s.close();
  }
});

// --- A-4 change 신호 4종 ---

test('GET /api/stream — change 신호 4종(create/lock/update/status)의 payload는 kind 하나뿐이다', async () => {
  const s = await openStream('/api/stream', { sid: sid('D') });
  try {
    assert.ok(await s.waitFor((f) => f.event === 'ready', WAIT_MS), 'ready 선행'); // 구독 등록 전 트리거는 유실된다.

    let articleId;
    const clientId = unique('ct-tab');

    await expectChange(s, 'create', async () => {
      ({ articleId } = await createArticle('D'));
    }, 'kind-create');

    await expectChange(s, 'lock', async () => {
      await acquireLock(articleId, 'D', clientId);
    }, 'kind-lock');

    await expectChange(s, 'update', async () => {
      const res = await api('PUT', `/api/articles/${articleId}`, {
        sid: sid('D'),
        headers: { 'x-edit-client': clientId },
        body: { title: unique('contract-title') },
      });
      assert.equal(res.status, 200, '트리거(PUT) 자체는 성공해야 한다');
      assert.equal(res.json?.ok, true);
    }, 'kind-update');

    await expectChange(s, 'status', async () => {
      const res = await api('POST', `/api/articles/${articleId}/action`, {
        sid: sid('D'), body: { action: 'send' },
      });
      assert.equal(res.status, 200, '트리거(action send) 자체는 성공해야 한다');
      assert.equal(res.json?.ok, true);
    }, 'kind-status');
  } finally {
    s.close();
  }
});

// --- A-5 동시 연결 2개(SPA 실사용 패턴) ---

test('GET /api/stream — 같은 세션의 동시 연결 2개가 트리거 1회에 둘 다 신호를 받는다', async () => {
  const a = await openStream('/api/stream', { sid: sid('D') });
  let b;
  try {
    b = await openStream('/api/stream', { sid: sid('D') });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.ok(await a.waitFor((f) => f.event === 'ready', WAIT_MS), 'ready(연결 1)');
    assert.ok(await b.waitFor((f) => f.event === 'ready', WAIT_MS), 'ready(연결 2)');

    await createArticle('D'); // 트리거 1회.

    const fa = await a.waitFor((f) => f.event === 'change' && f.json?.kind === 'create', WAIT_MS);
    const fb = await b.waitFor((f) => f.event === 'change' && f.json?.kind === 'create', WAIT_MS);
    assert.ok(fa, '연결 1이 신호를 받아야 한다');
    assert.ok(fb, '연결 2도 같은 트리거로 신호를 받아야 한다');
    assert.deepEqual(Object.keys(fb.json).sort(), ['kind']);

    record('stream', 'change', {
      status: 200,
      ok: true,
      reason: null,
      bodyKeys: ['kind'],
      values: { connections: 2, bothReceived: true, kind: 'create' },
      caseId: 'fanout-two-connections',
    });
  } finally {
    a.close();
    if (b) b.close();
  }
});

// --- A-6 세션 무효화 종료(R 전용 세션 로그인 — 공용 R 세션은 아래 복구 케이스가 되살린다) ---

test('GET /api/stream — 세션이 죽으면 다음 이벤트에서 unauthorized 1회 후 봉인된다', async () => {
  // 이 파일의 첫 번째 직접 로그인(예산 회계는 파일 상단 CRITICAL 참조). 비밀번호는 요청 body에만 쓴다.
  // 이 로그인이 공용 R 세션을 무효화한다 — 복구는 이 파일 마지막 케이스가 한다(스위트 규약).
  const cred = credentials('R');
  const login = await api('POST', '/api/login', { body: { userId: cred.userId, password: cred.password } });
  assert.equal(login.status, 200, '전용 세션 로그인은 성공해야 한다');
  assert.equal(login.json?.ok, true);
  const privateSid = login.json.sessionId; // 리포트·로그에 절대 담지 않는다.

  const s = await openStream('/api/stream', { sid: privateSid });
  try {
    assert.equal(s.status, 200);
    assert.ok(await s.waitFor((f) => f.event === 'ready', WAIT_MS), 'ready 선행');

    const out = await api('POST', '/api/logout', { sid: privateSid }); // 전용 세션만 파괴한다.
    assert.equal(out.status, 200);

    // 종료는 "다음 이벤트"에 관측된다(주기 재검증 타이머 없음 — ADR-008). 트리거는 공용 D 세션으로 쏜다.
    await createArticle('D');

    const frame = await s.waitFor((f) => f.event === 'unauthorized', WAIT_MS);
    assert.ok(frame, `unauthorized 프레임이 ${WAIT_MS}ms 안에 도착해야 한다`);
    assert.equal(frame.data, UNAUTHORIZED_DATA);
    assert.deepEqual(frame.json, { ok: false, reason: 'unauthenticated' });

    // 봉인: 이후 트리거에도 프레임이 오지 않는다(무효화 이후 한 줄도 나가지 않는다).
    await createArticle('D');
    assert.equal(await s.waitFor(() => true, 2000), null, '무효화 이후 프레임이 더 오면 안 된다');

    record('stream', 'termination', {
      status: 200,
      ok: false,
      reason: 'unauthenticated',
      bodyKeys: ['ok', 'reason'],
      values: { event: 'unauthorized', frameData: UNAUTHORIZED_DATA, sealedAfterFrame: true },
      caseId: 'unauthorized-after-logout',
    });
  } finally {
    s.close();
  }
});

// --- 공용 세션 복구(스위트 규약 — 반드시 이 파일의 마지막) ---
// A-6이 전용 세션과 함께 공용 R 세션까지 소실시켰다. 계약 단언이 아니라 스위트 위생이므로 record하지 않는다.
// 별도 케이스로 둔 이유: A-6이 중간에 실패해도 복구는 반드시 실행돼야 뒤 파일(users)이 연쇄 401로 무너지지 않는다.
test('공용 R 세션 복구 — A-6이 파괴한 sid(\'R\')을 되살린다', async () => {
  const cred = credentials('R');
  const res = await api('POST', '/api/login', { body: { userId: cred.userId, password: cred.password } });

  assert.equal(res.status, 200, '복구 로그인이 실패하면 뒤 파일의 sid(R) 케이스가 전부 401로 무너진다');
  assert.equal(res.json?.ok, true);
  republish('R', { sid: res.json.sessionId, user: res.json.user }); // 토큰은 lib 밖으로 흘리지 않는다.

  const check = await api('GET', '/api/session', { sid: sid('R') });
  assert.equal(check.status, 200, '복구된 공용 세션은 즉시 사용 가능해야 한다');
  assert.equal(check.json?.user?.role, 'R');
});
