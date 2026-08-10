import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHttpModel, resolveUploadFilename } from './httpModel.js';
import { assertModel } from './contract.js';

const BASE = 'http://api.test';

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

describe('createHttpModel', () => {
  let fetchMock;
  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;

  beforeEach(() => {
    sessionStorage.clear();
    fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    globalThis.EventSource = realEventSource;
  });

  const callAt = (i) => fetchMock.mock.calls[i];

  // 부팅 계약(main.jsx) 동형 — MODEL_KEYS에 키를 추가하면 httpModel에도 반드시 함수가 있어야 한다(3면 동기화 잠금).
  it('satisfies the full MODEL_KEYS contract (assertModel — 부팅과 동형)', () => {
    expect(() => assertModel(createHttpModel({ base: BASE }))).not.toThrow();
  });

  it('sends credentials:include on every request (cookie transport)', async () => {
    const model = createHttpModel({ base: BASE });
    await model.queryArticles();
    await model.saveArticle({ title: 'new' });
    expect(callAt(0)[1].credentials).toBe('include');
    expect(callAt(1)[1].credentials).toBe('include');
  });

  it('login POSTs credentials and stores the session id for the dev cross-origin fallback', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-1', user: { userId: 'kim' } }));
    const model = createHttpModel({ base: BASE });

    const r = await model.login('kim', 'pw');
    expect(r.user).toEqual({ userId: 'kim' });

    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/login`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ userId: 'kim', password: 'pw' });
    // 로그인 요청 자체에는 아직 토큰이 없다(저장 전).
    expect(init.headers['x-session-id']).toBeUndefined();

    // 인증의 1차 수단은 HttpOnly 쿠키지만, dev cross-origin 폴백을 위해 sessionId를 보관한다.
    expect(sessionStorage.getItem('yh.sessionId')).toBe('sid-1');

    // 이후 요청에는 쿠키(credentials)와 함께 x-session-id 폴백 헤더가 병행 첨부된다.
    await model.queryArticles();
    expect(callAt(1)[1].headers['x-session-id']).toBe('sid-1');
    expect(callAt(1)[1].credentials).toBe('include');
  });

  it('logout POSTs with credentials and never touches sessionStorage', async () => {
    const model = createHttpModel({ base: BASE });

    await model.logout();
    expect(callAt(0)[0]).toBe(`${BASE}/api/logout`);
    expect(callAt(0)[1].method).toBe('POST');
    expect(callAt(0)[1].credentials).toBe('include');
    expect(callAt(0)[1].headers['x-session-id']).toBeUndefined();
    expect(sessionStorage.getItem('yh.sessionId')).toBeNull();
  });

  it('restoreSession GETs /api/session with credentials (cookie identity), no header token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, user: { userId: 'kim' } }));
    const model = createHttpModel({ base: BASE });

    const r = await model.restoreSession();
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/session`);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
    expect(init.headers['x-session-id']).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(r).toEqual({ ok: true, user: { userId: 'kim' } });
  });

  it('restoreSession returns the (non-throwing) unauthenticated body when there is no session', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, reason: 'unauthenticated' }));
    const model = createHttpModel({ base: BASE });
    const r = await model.restoreSession();
    expect(r).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('saveArticle POSTs when no articleId and PUTs /:id when present', async () => {
    const model = createHttpModel({ base: BASE });

    await model.saveArticle({ title: 'new' });
    expect(callAt(0)[0]).toBe(`${BASE}/api/articles`);
    expect(callAt(0)[1].method).toBe('POST');

    await model.saveArticle({ articleId: 'AKR1', title: 'edit' });
    expect(callAt(1)[0]).toBe(`${BASE}/api/articles/AKR1`);
    expect(callAt(1)[1].method).toBe('PUT');
  });

  it('saveArticle puts the intent action in the create(POST) body only — not on PUT, not when omitted, never role', async () => {
    const model = createHttpModel({ base: BASE });

    // 신규(create=POST)만 의도 action을 body에 싣는다 — 서버 initialStatus가 Z+hold를 DDH로 둔다(step0).
    await model.saveArticle({ title: 'new' }, null, 'hold');
    expect(callAt(0)[1].method).toBe('POST');
    expect(JSON.parse(callAt(0)[1].body)).toMatchObject({ title: 'new', action: 'hold' });

    await model.saveArticle({ title: 'new2' }, null, 'send');
    expect(JSON.parse(callAt(1)[1].body).action).toBe('send');

    // 편집(PUT)에는 action을 싣지 않는다 — 상태 전이는 applyAction 담당.
    await model.saveArticle({ articleId: 'AKR1', title: 'edit' }, null, 'send');
    expect(callAt(2)[1].method).toBe('PUT');
    expect(JSON.parse(callAt(2)[1].body).action).toBeUndefined();

    // action 미전달이면 body에 action 키가 없다(하위호환). role은 어떤 경우에도 싣지 않는다(ADR-004).
    await model.saveArticle({ title: 'new3' });
    const lastBody = JSON.parse(callAt(3)[1].body);
    expect(lastBody.action).toBeUndefined();
    expect(lastBody.role).toBeUndefined();
  });

  it('getArticle GETs /api/articles/:id with no body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, article: { articleId: 'AKR1' }, contents: {} }));
    const model = createHttpModel({ base: BASE });
    const r = await model.getArticle('AKR1');
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/articles/AKR1`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(r.article.articleId).toBe('AKR1');
  });

  // 이력 조회는 canonical queryHistory(/:id/history)로 통합됐다 — superseded getArticleHistory/getSendHistory는 제거.
  it('queryHistory GETs /api/articles/:id/history and adds sendOnly=1 only when requested', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, items: [{ eventType: 'create' }] }));
    const model = createHttpModel({ base: BASE });

    const r = await model.queryHistory('AKR1');
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/articles/AKR1/history`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(r).toEqual({ ok: true, items: [{ eventType: 'create' }] });

    await model.queryHistory('AKR1', { sendOnly: true });
    expect(callAt(1)[0]).toBe(`${BASE}/api/articles/AKR1/history?sendOnly=1`);
  });

  // 기사이력비교 — 목록(hasSnapshot 경량)과 달리 본문(markupVersion)은 이 단건 GET으로만 지연 조회한다.
  it('getHistorySnapshot GETs /api/articles/:id/history/:historyId with no body and returns { ok, item }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, item: { id: 7, markupVersion: '{}' } }));
    const model = createHttpModel({ base: BASE });

    const r = await model.getHistorySnapshot('AKR1', 7);
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/articles/AKR1/history/7`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(r).toEqual({ ok: true, item: { id: 7, markupVersion: '{}' } });
  });

  it('createUser POSTs /api/users and updateUser PUTs /api/users/:id', async () => {
    const model = createHttpModel({ base: BASE });

    await model.createUser({ userId: 'kim', password: 'x' });
    expect(callAt(0)[0]).toBe(`${BASE}/api/users`);
    expect(callAt(0)[1].method).toBe('POST');

    await model.updateUser('kim', { name: 'Kim' });
    expect(callAt(1)[0]).toBe(`${BASE}/api/users/kim`);
    expect(callAt(1)[1].method).toBe('PUT');
    expect(JSON.parse(callAt(1)[1].body)).toEqual({ name: 'Kim' });
  });

  it('applyAction POSTs the action without sending role in the body', async () => {
    const model = createHttpModel({ base: BASE });
    await model.applyAction('AKR1', 'send');
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/articles/AKR1/action`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ action: 'send' });
    expect(body.role).toBeUndefined();
  });

  it('queryArticles serializes array filters as repeated query params', async () => {
    const model = createHttpModel({ base: BASE });
    await model.queryArticles({ departments: ['정치', '경제'], status: 'DPS' });
    const url = new URL(callAt(0)[0]);
    expect(url.pathname).toBe('/api/articles');
    expect(url.searchParams.getAll('departments')).toEqual(['정치', '경제']);
    expect(url.searchParams.get('status')).toBe('DPS');
  });

  it('lock/unlock/force-unlock map to their POST routes', async () => {
    const model = createHttpModel({ base: BASE });
    await model.lockArticle('AKR1', 'portalRevise');
    expect(callAt(0)[0]).toBe(`${BASE}/api/articles/AKR1/lock`);
    expect(JSON.parse(callAt(0)[1].body)).toEqual({ action: 'portalRevise' });

    await model.unlockArticle('AKR1');
    expect(callAt(1)[0]).toBe(`${BASE}/api/articles/AKR1/unlock`);

    await model.forceUnlockArticle('AKR1');
    expect(callAt(2)[0]).toBe(`${BASE}/api/articles/AKR1/force-unlock`);
  });

  it('sends the x-edit-client header on lock when a clientId is given (per-tab lock identity)', async () => {
    const model = createHttpModel({ base: BASE });
    await model.lockArticle('AKR1', 'revise', 'tab-client-1');
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/articles/AKR1/lock`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-edit-client']).toBe('tab-client-1');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ action: 'revise' });
  });

  it('sends the x-edit-client header on unlock when a clientId is given (holder release)', async () => {
    const model = createHttpModel({ base: BASE });
    await model.unlockArticle('AKR1', 'tab-client-2');
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/articles/AKR1/unlock`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-edit-client']).toBe('tab-client-2');
    expect(init.credentials).toBe('include');
  });

  it('sends the x-edit-client header on save(PUT) so the server checks the lock holder (blocks a 2nd tab)', async () => {
    const model = createHttpModel({ base: BASE });
    await model.saveArticle({ articleId: 'AKR1', title: 'edit' }, 'tab-client-3');
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/articles/AKR1`);
    expect(init.method).toBe('PUT');
    expect(init.headers['x-edit-client']).toBe('tab-client-3');
    expect(init.credentials).toBe('include');
  });

  it('omits the x-edit-client header when no clientId is given (backwards compatible)', async () => {
    const model = createHttpModel({ base: BASE });
    await model.lockArticle('AKR1', 'revise');
    await model.unlockArticle('AKR1');
    await model.saveArticle({ articleId: 'AKR1', title: 'edit' });
    expect(callAt(0)[1].headers['x-edit-client']).toBeUndefined();
    expect(callAt(1)[1].headers['x-edit-client']).toBeUndefined();
    expect(callAt(2)[1].headers['x-edit-client']).toBeUndefined();
  });

  it('request always sends credentials: include so the session cookie rides cross-origin', async () => {
    const model = createHttpModel({ base: BASE });

    // 토큰이 없어도(쿠키 인증 전제) credentials는 항상 포함된다.
    await model.queryArticles();
    expect(callAt(0)[1].credentials).toBe('include');
    expect(callAt(0)[1].headers['x-session-id']).toBeUndefined();

    // 토큰 보관 후에도 credentials는 유지된다.
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-9', user: {} }));
    await model.login('a', 'b');
    await model.queryArticles();
    expect(callAt(2)[1].credentials).toBe('include');
    expect(callAt(2)[1].headers['x-session-id']).toBe('sid-9');
  });

  it('restoreSession works cookie-only (no stored token) and still sends credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, user: { userId: 'kim' } }));
    const model = createHttpModel({ base: BASE });

    // sessionStorage가 비어 있어도(쿠키만 있는 상황) 서버가 신원을 돌려준다.
    const r = await model.restoreSession();
    expect(r).toEqual({ ok: true, user: { userId: 'kim' } });
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/session`);
    expect(init.credentials).toBe('include');
    expect(init.headers['x-session-id']).toBeUndefined(); // 헤더 없이 쿠키만으로 인증
  });

  it('keeps the x-session-id header fallback when a token is stored (no regression)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-h', user: {} }));
    const model = createHttpModel({ base: BASE });
    await model.login('a', 'b');

    await model.queryArticles();
    expect(callAt(1)[1].headers['x-session-id']).toBe('sid-h');
    expect(callAt(1)[1].credentials).toBe('include');
  });

  it('logout clears sessionStorage so no header is sent afterwards', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-clr', user: {} }));
    const model = createHttpModel({ base: BASE });
    await model.login('a', 'b');
    expect(sessionStorage.getItem('yh.sessionId')).toBe('sid-clr');

    await model.logout();
    expect(sessionStorage.getItem('yh.sessionId')).toBeNull();
  });

  it('uploadFile reads the File as a data URL, strips the prefix, and POSTs raw base64 to /api/upload', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, path: '/uploads/abc.png', filename: 'pic.png' }));
    const model = createHttpModel({ base: BASE });

    // "hello" → base64 aGVsbG8= (jsdom의 FileReader.readAsDataURL이 data:...;base64,를 만든다).
    const file = new File(['hello'], 'pic.png', { type: 'image/png' });
    const r = await model.uploadFile(file);

    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/upload`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    const body = JSON.parse(init.body);
    expect(body.filename).toBe('pic.png');
    // prefix("data:...;base64,")는 제거되고 raw base64만 전송된다(서버 계약).
    expect(body.contentBase64).toBe('aGVsbG8=');
    expect(body.contentBase64).not.toMatch(/^data:/);
    expect(r).toEqual({ ok: true, path: '/uploads/abc.png', filename: 'pic.png' });
  });

  it('uploadFile synthesizes a pasted-<ts>.<ext> filename for an extensionless clipboard image', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, path: '/uploads/xyz.png', filename: 'pasted-1.png' }));
    const model = createHttpModel({ base: BASE });

    // 클립보드 이미지: file.name이 비어 있고 확장자가 없다 → MIME(image/png)에서 png를 도출해 합성.
    const file = new File(['hello'], '', { type: 'image/png' });
    await model.uploadFile(file);

    const body = JSON.parse(callAt(0)[1].body);
    expect(body.filename).toMatch(/^pasted-\d+\.png$/);
    // 요청 body shape·raw base64 전송은 불변(서버 계약).
    expect(body.contentBase64).toBe('aGVsbG8=');
  });

  it('uploadFile keeps an extensioned filename untouched (attachment back-compat)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, path: '/uploads/r.pdf', filename: 'report.pdf' }));
    const model = createHttpModel({ base: BASE });

    const file = new File(['hello'], 'report.pdf', { type: 'application/pdf' });
    await model.uploadFile(file);

    expect(JSON.parse(callAt(0)[1].body).filename).toBe('report.pdf');
  });

  function installFakeEventSource(instances) {
    class FakeEventSource {
      constructor(url, opts) {
        this.url = url;
        this.opts = opts;
        this.listeners = {};
        this.closed = false;
        instances.push(this);
      }
      addEventListener(type, cb) { (this.listeners[type] ??= []).push(cb); }
      close() { this.closed = true; }
      // 실제 EventSource는 close() 이후 어떤 이벤트도 발화하지 않고 재연결도 하지 않는다 —
      // 가짜도 같은 성질을 갖게 해 "닫은 뒤에는 데이터가 흐르지 않는다"를 그대로 단언할 수 있게 한다.
      emit(type, data) {
        if (this.closed) return;
        (this.listeners[type] ?? []).forEach((cb) => cb({ data }));
      }
    }
    globalThis.EventSource = FakeEventSource;
  }

  it('subscribe opens EventSource with withCredentials and routes change signals', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-5', user: {} }));
    const instances = [];
    installFakeEventSource(instances);

    const model = createHttpModel({ base: BASE });

    const onChange = vi.fn();
    const sub = model.subscribe({ menu: 'desk' }, onChange);

    expect(instances).toHaveLength(1);
    // 쿠키가 1차 수단 — withCredentials로 cross-origin 쿠키를 싣는다(step5).
    expect(instances[0].opts).toEqual({ withCredentials: true });
    expect(sub.connected()).toBe(false);

    instances[0].emit('ready', '{"ok":true}');
    expect(sub.connected()).toBe(true);

    instances[0].emit('change', '{"kind":"status"}');
    expect(onChange).toHaveBeenCalledWith({ kind: 'status' }, { menu: 'desk' });

    instances[0].emit('error', null);
    expect(sub.connected()).toBe(false);

    sub.unsubscribe();
    expect(instances[0].closed).toBe(true);
  });

  it('subscribe omits the session query when there is no stored token (cookie-only)', async () => {
    const instances = [];
    installFakeEventSource(instances);

    const model = createHttpModel({ base: BASE });
    // 토큰이 없으면(쿠키 인증 전제) URL에 세션 토큰을 노출하지 않는다.
    model.subscribe({}, vi.fn());

    expect(instances[0].url).toBe(`${BASE}/api/stream`);
    expect(instances[0].url).not.toContain('session=');
    expect(instances[0].opts).toEqual({ withCredentials: true });
  });

  it('subscribe never appends a ?session= query even when a token is stored (cookie-only auth)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-q', user: {} }));
    const instances = [];
    installFakeEventSource(instances);

    const model = createHttpModel({ base: BASE });
    // 토큰이 보관돼 있어도(REST의 x-session-id 폴백용) 스트림 URL에는 싣지 않는다 —
    // 서버 /api/stream은 쿠키·헤더만 읽으므로(폐기된 쿼리 폴백) 인증 효과 없이 평문 토큰만 노출된다.
    await model.login('a', 'b'); // stores sid-q

    model.subscribe({}, vi.fn());
    expect(instances[0].url).toBe(`${BASE}/api/stream`);
    expect(instances[0].url).not.toContain('session=');
    expect(instances[0].url).not.toContain('sid-q');
    // 쿠키(withCredentials)가 SSE의 유일한 인증 수단이 됐으므로 반드시 잠근다.
    expect(instances[0].opts).toEqual({ withCredentials: true });
    // REST 경로는 폴백 헤더를 계속 싣는다(readSessionId 유지 근거 — SSE와 달리 헤더 전송이 가능하다).
    await model.queryArticles();
    expect(callAt(1)[1].headers['x-session-id']).toBe('sid-q');
  });

  it('publishPhoto POSTs /api/photos with the payload body and never role/registeredBy (ADR-004)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, id: 7 }));
    const model = createHttpModel({ base: BASE });

    const r = await model.publishPhoto({ src: '/uploads/a.png', caption: '현장', sourceArticleId: 'AKR1' });
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/photos`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    const body = JSON.parse(init.body);
    // 호출자가 구성한 payload 그대로 — 신원/역할은 어떤 형태로도 싣지 않는다(서버 세션 도출).
    expect(body).toEqual({ src: '/uploads/a.png', caption: '현장', sourceArticleId: 'AKR1' });
    expect(body.role).toBeUndefined();
    expect(body.registeredBy).toBeUndefined();
    // 응답 { ok, id } 그대로 반환(step0 라우트와 1:1).
    expect(r).toEqual({ ok: true, id: 7 });
  });

  it('searchPhotos GETs /api/photos/search?q= with the encoded query and returns { ok, items }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, items: [{ id: 1, caption: '토픽' }] }));
    const model = createHttpModel({ base: BASE });

    const r = await model.searchPhotos('토픽');
    const [url, init] = callAt(0);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/photos/search');
    expect(parsed.searchParams.get('q')).toBe('토픽'); // URLSearchParams 인코딩을 거쳐 전송된다.
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('include');
    expect(r).toEqual({ ok: true, items: [{ id: 1, caption: '토픽' }] });
  });

  it('queryDistributionTargets GETs /api/distribution-targets with the filters as query (no body, no role)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      items: [{ id: 1, name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' }],
    }));
    const model = createHttpModel({ base: BASE });

    const r = await model.queryDistributionTargets({ active: 'Y' });
    const [url, init] = callAt(0);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/distribution-targets');
    expect(parsed.searchParams.get('active')).toBe('Y');
    expect(parsed.searchParams.get('role')).toBeNull(); // 신원/역할은 어떤 형태로도 싣지 않는다(ADR-004).
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('include');
    // 응답을 가공 없이 그대로 반환한다(라우트와 1:1).
    expect(r).toEqual({ ok: true, items: [{ id: 1, name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y' }] });

    // 필터 미전달이면 쿼리 없이 그대로 호출한다.
    await model.queryDistributionTargets();
    expect(callAt(1)[0]).toBe(`${BASE}/api/distribution-targets`);
  });

  it('createDistributionTarget POSTs /api/distribution-targets with the entry body and never role (ADR-004)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, id: 3 }));
    const model = createHttpModel({ base: BASE });

    const r = await model.createDistributionTarget({ name: 'KBS', kind: 'press', spoolDir: 'kbs' });
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/distribution-targets`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ name: 'KBS', kind: 'press', spoolDir: 'kbs' });
    expect(body.role).toBeUndefined();
    expect(r).toEqual({ ok: true, id: 3 });
  });

  it('updateDistributionTarget PUTs /api/distribution-targets/:id with only the changed fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, changes: 1 }));
    const model = createHttpModel({ base: BASE });

    const r = await model.updateDistributionTarget(7, { name: '한국방송' });
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/distribution-targets/7`);
    expect(init.method).toBe('PUT');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ name: '한국방송' });
    expect(r).toEqual({ ok: true, changes: 1 });
  });

  it('deactivateDistributionTarget POSTs /:id/deactivate with no body (soft delete — DELETE 라우트 없음)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, changes: 1 }));
    const model = createHttpModel({ base: BASE });

    const r = await model.deactivateDistributionTarget(7);
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/distribution-targets/7/deactivate`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('include');
    expect(r).toEqual({ ok: true, changes: 1 });
  });

  // --- 배부 실패 복구/실행(phase 57 MVP-4) — /api/distribution/{failures,retry,tick} 라우트와 1:1 ---
  it('queryDistributionFailures GETs /api/distribution/failures with the filters as query (no body)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, items: [{ articleId: 'AKR1', targetId: 3 }] }));
    const model = createHttpModel({ base: BASE });

    const r = await model.queryDistributionFailures({ limit: 5 });
    const [url, init] = callAt(0);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/distribution/failures');
    expect(parsed.searchParams.get('limit')).toBe('5');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('include');
    // 응답을 가공 없이 그대로 반환한다(라우트와 1:1).
    expect(r).toEqual({ ok: true, items: [{ articleId: 'AKR1', targetId: 3 }] });

    // 필터 미전달이면 쿼리 없이 그대로 호출한다.
    await model.queryDistributionFailures();
    expect(callAt(1)[0]).toBe(`${BASE}/api/distribution/failures`);
  });

  it('retryDistribution POSTs /api/distribution/retry with exactly { historyId } — never role/kind/articleId (ADR-004)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, articleId: 'AKR1', targetId: 12, kind: 'press', at: 't' }));
    const model = createHttpModel({ base: BASE });

    const r = await model.retryDistribution(34);
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/distribution/retry`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    const body = JSON.parse(init.body);
    // 한 키뿐 — 기사·수신처·kind·시각·role 전부 서버가 실패 이력·세션에서 도출한다(클라 입력 금지).
    expect(body).toEqual({ historyId: 34 });
    expect(Object.keys(body)).toEqual(['historyId']);
    expect(r).toEqual({ ok: true, articleId: 'AKR1', targetId: 12, kind: 'press', at: 't' });
  });

  it('runDistributionTick POSTs /api/distribution/tick with NO body (서버가 body를 읽지 않는다 — 파라미터 클라 결정 금지)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, at: 't', scanned: 0, distributed: [], failed: [], invalid: [] }));
    const model = createHttpModel({ base: BASE });

    const r = await model.runDistributionTick();
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/distribution/tick`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('include');
    expect(r).toEqual({ ok: true, at: 't', scanned: 0, distributed: [], failed: [], invalid: [] });
  });

  it('distribution failure/tick requests carry the x-session-id fallback header when a token is stored', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-d', user: {} }));
    const model = createHttpModel({ base: BASE });
    await model.login('a', 'b');

    await model.queryDistributionFailures();
    await model.retryDistribution(1);
    await model.runDistributionTick();
    for (const i of [1, 2, 3]) {
      expect(callAt(i)[1].headers['x-session-id']).toBe('sid-d');
      expect(callAt(i)[1].credentials).toBe('include');
    }
  });

  it('getLogsDigest GETs /api/logs/digest with no body and returns { ok, items } (never role)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, items: [{ seq: 1, level: 'INFO' }] }));
    const model = createHttpModel({ base: BASE });

    const r = await model.getLogsDigest();
    const [url, init] = callAt(0);
    // 쿼리 자체가 없다 — role/권한 값은 어떤 형태로도 싣지 않는다(ADR-004, 서버 세션 도출).
    expect(url).toBe(`${BASE}/api/logs/digest`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('include');
    expect(r).toEqual({ ok: true, items: [{ seq: 1, level: 'INFO' }] });
  });

  it('subscribeLogs opens EventSource on /api/logs/stream with withCredentials and routes ready/log/error', async () => {
    const instances = [];
    installFakeEventSource(instances);

    const model = createHttpModel({ base: BASE });
    const onLog = vi.fn();
    const onStatus = vi.fn();
    const sub = model.subscribeLogs(onLog, onStatus);

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe(`${BASE}/api/logs/stream`);
    // 인증은 HttpOnly 쿠키(withCredentials)로만 — role 게이트는 서버가 강제(ADR-004/007).
    expect(instances[0].opts).toEqual({ withCredentials: true });
    expect(sub.connected()).toBe(false);

    instances[0].emit('ready', '{"ok":true}');
    expect(sub.connected()).toBe(true);
    expect(onStatus).toHaveBeenCalledWith(true);

    const record = { seq: 1, ts: 1000, level: 'INFO', message: 'boot', line: '[2026-07-06 09:00:00] [INFO] boot' };
    instances[0].emit('log', JSON.stringify(record));
    expect(onLog).toHaveBeenCalledWith(record);

    // 파싱 불가/빈 데이터는 무시한다(onLog 미호출).
    instances[0].emit('log', 'not-json');
    instances[0].emit('log', '');
    expect(onLog).toHaveBeenCalledTimes(1);

    instances[0].emit('error', null);
    expect(sub.connected()).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith(false);

    sub.unsubscribe();
    expect(instances[0].closed).toBe(true);
  });

  it('subscribeLogs never appends a ?session= query even when a token is stored (cookie-only auth)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-log', user: {} }));
    const instances = [];
    installFakeEventSource(instances);

    const model = createHttpModel({ base: BASE });
    await model.login('a', 'b'); // 토큰이 보관돼 있어도 로그 스트림 URL에는 싣지 않는다(서버가 쿼리 토큰을 읽지 않음).

    model.subscribeLogs(vi.fn());
    expect(instances[0].url).toBe(`${BASE}/api/logs/stream`);
    expect(instances[0].url).not.toContain('session=');
  });

  // 서버(phase52 step3)는 push 시점 재인증에 실패하면 두 스트림 공통으로 아래 프레임을 1회 보내고 연결을 끝낸다:
  //   event: unauthorized / data: {"ok":false,"reason":"unauthenticated"}
  // 표준 EventSource는 끊기면 자동 재연결하므로(ADR-005), 죽은 세션에서는 매 재연결이 401로 실패하며
  // 요청 로그(링 버퍼)를 채운다 → 클라이언트가 이 이벤트에서 스스로 닫아야 한다.
  describe('SSE terminal close — event: unauthorized', () => {
    const UNAUTHORIZED = '{"ok":false,"reason":"unauthenticated"}';

    it('subscribe closes the EventSource on the terminal unauthorized event (no reconnect storm)', () => {
      const instances = [];
      installFakeEventSource(instances);

      const model = createHttpModel({ base: BASE });
      const onChange = vi.fn();
      const onStatus = vi.fn();
      const sub = model.subscribe({ menu: 'desk' }, onChange, onStatus);

      instances[0].emit('ready', '{"ok":true}');
      expect(sub.connected()).toBe(true);

      instances[0].emit('unauthorized', UNAUTHORIZED);

      // 닫혔다 = 브라우저가 재연결하지 않는다(401 폭주·로그 오염 차단).
      expect(instances[0].closed).toBe(true);
      expect(sub.connected()).toBe(false);
      expect(onStatus).toHaveBeenLastCalledWith(false);

      // 닫힌 뒤에는 어떤 데이터도 흐르지 않고, 대체 스트림을 새로 열지도 않는다.
      instances[0].emit('change', '{"kind":"status"}');
      expect(onChange).not.toHaveBeenCalled();
      expect(instances).toHaveLength(1);

      // 소비처(Controller)의 정리 호출은 종료 이후에도 안전하다(멱등).
      expect(() => sub.unsubscribe()).not.toThrow();
      expect(instances[0].closed).toBe(true);
      expect(sub.connected()).toBe(false);
    });

    it('subscribeLogs closes the EventSource on the terminal unauthorized event (Z 게이트 상실·세션 만료)', () => {
      const instances = [];
      installFakeEventSource(instances);

      const model = createHttpModel({ base: BASE });
      const onLog = vi.fn();
      const onStatus = vi.fn();
      const sub = model.subscribeLogs(onLog, onStatus);

      instances[0].emit('ready', '{"ok":true}');
      expect(sub.connected()).toBe(true);

      instances[0].emit('unauthorized', UNAUTHORIZED);

      expect(instances[0].closed).toBe(true);
      expect(sub.connected()).toBe(false);
      expect(onStatus).toHaveBeenLastCalledWith(false);

      instances[0].emit('log', JSON.stringify({ seq: 2, level: 'INFO', message: 'after' }));
      expect(onLog).not.toHaveBeenCalled();
      expect(instances).toHaveLength(1);

      expect(() => sub.unsubscribe()).not.toThrow();
      expect(instances[0].closed).toBe(true);
    });

    it('closes on the terminal event even when its data is empty or unparseable (고정 토큰 — 파싱에 분기하지 않는다)', () => {
      const instances = [];
      installFakeEventSource(instances);

      const model = createHttpModel({ base: BASE });
      const streamSub = model.subscribe({}, vi.fn());
      const logsSub = model.subscribeLogs(vi.fn());

      instances[0].emit('unauthorized', '');
      instances[1].emit('unauthorized', 'not-json');

      expect(instances[0].closed).toBe(true);
      expect(instances[1].closed).toBe(true);
      expect(streamSub.connected()).toBe(false);
      expect(logsSub.connected()).toBe(false);
    });

    it('subscribe keeps the stream open on a transient error (EventSource 자동 재연결 보존 — ADR-005)', () => {
      const instances = [];
      installFakeEventSource(instances);

      const model = createHttpModel({ base: BASE });
      const onChange = vi.fn();
      const onStatus = vi.fn();
      const sub = model.subscribe({ menu: 'desk' }, onChange, onStatus);

      instances[0].emit('ready', '{"ok":true}');
      instances[0].emit('error', null);

      // 연결 끊김으로 보고하되 닫지는 않는다 — 일시 단절은 브라우저 재연결로 회복돼야 한다.
      expect(sub.connected()).toBe(false);
      expect(onStatus).toHaveBeenLastCalledWith(false);
      expect(instances[0].closed).toBe(false);

      // 재연결 성공 시나리오: 같은 소스가 ready/change를 다시 흘린다.
      instances[0].emit('ready', '{"ok":true}');
      expect(sub.connected()).toBe(true);
      instances[0].emit('change', '{"kind":"status"}');
      expect(onChange).toHaveBeenCalledWith({ kind: 'status' }, { menu: 'desk' });
    });

    it('subscribeLogs keeps the stream open on a transient error (EventSource 자동 재연결 보존 — ADR-005)', () => {
      const instances = [];
      installFakeEventSource(instances);

      const model = createHttpModel({ base: BASE });
      const onLog = vi.fn();
      const sub = model.subscribeLogs(onLog);

      instances[0].emit('ready', '{"ok":true}');
      instances[0].emit('error', null);

      expect(sub.connected()).toBe(false);
      expect(instances[0].closed).toBe(false);

      instances[0].emit('ready', '{"ok":true}');
      expect(sub.connected()).toBe(true);
      const record = { seq: 9, ts: 1000, level: 'INFO', message: 'back', line: 'back' };
      instances[0].emit('log', JSON.stringify(record));
      expect(onLog).toHaveBeenCalledWith(record);
    });
  });

  // request()는 reject하지 않는다 — 모든 실패를 서버 실패 응답과 같은 shape({ ok:false, reason })으로
  // 정규화한다. 화면은 { ok, reason }만 다루므로 reject는 unhandled rejection + 무반응 UI가 된다(step7).
  describe('failure normalization — request never rejects', () => {
    it('resolves { ok:false, reason:"network-error" } when fetch itself rejects (server unreachable)', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const model = createHttpModel({ base: BASE });
      const r = await model.queryDistributionTargets();
      // 두 키만 — status/url/에러 메시지·스택을 싣지 않는다(에러 원문 유출·shape 확장 금지).
      expect(r).toEqual({ ok: false, reason: 'network-error' });
    });

    it('resolves { ok:false, reason:"invalid-response" } when the body is not JSON (proxy HTML error page)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => { throw new SyntaxError('Unexpected token <'); },
      });
      const model = createHttpModel({ base: BASE });
      const r = await model.queryDistributionTargets();
      expect(r).toEqual({ ok: false, reason: 'invalid-response' });
    });

    it('returns a JSON failure body untouched — normalization never overwrites server reasons (403 forbidden)', async () => {
      // 서버가 살아 있으면 항상 JSON({ ok:false, reason })을 준다 — 상태코드로 사유를 재작성하지 않는다.
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ ok: false, reason: 'forbidden' }),
      });
      const model = createHttpModel({ base: BASE });
      const r = await model.queryDistributionTargets();
      expect(r).toEqual({ ok: false, reason: 'forbidden' });
    });

    it('returns a JSON success body untouched (regression)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, items: [{ id: 1, name: 'KBS' }] }));
      const model = createHttpModel({ base: BASE });
      const r = await model.queryDistributionTargets();
      expect(r).toEqual({ ok: true, items: [{ id: 1, name: 'KBS' }] });
    });

    it('login normalized to network-error never stores a session id (no side effect)', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const model = createHttpModel({ base: BASE });
      const r = await model.login('kim', 'pw');
      expect(r).toEqual({ ok: false, reason: 'network-error' });
      expect(sessionStorage.getItem('yh.sessionId')).toBeNull();
    });

    it('still assembles the request exactly as before when fetch fails (path/method/headers/credentials)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-f', user: {} }));
      const model = createHttpModel({ base: BASE });
      await model.login('a', 'b'); // sid-f 보관 → 이후 요청에 x-session-id 폴백 첨부.

      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const r = await model.applyAction('AKR1', 'send');
      expect(r).toEqual({ ok: false, reason: 'network-error' });

      const [url, init] = callAt(1);
      expect(url).toBe(`${BASE}/api/articles/AKR1/action`);
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(init.headers['x-session-id']).toBe('sid-f');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual({ action: 'send' });
    });
  });
});

describe('resolveUploadFilename', () => {
  it('keeps a filename that already has an extension (attachment/reference back-compat)', () => {
    expect(resolveUploadFilename('report.pdf', 'application/pdf')).toBe('report.pdf');
    expect(resolveUploadFilename('sheet.xlsx', 'application/vnd.ms-excel')).toBe('sheet.xlsx');
    // MIME이 이미지여도 확장자가 있으면 재작성하지 않는다.
    expect(resolveUploadFilename('photo.jpeg', 'image/png')).toBe('photo.jpeg');
  });

  it('synthesizes pasted-<ts>.<ext> from the MIME type when the name has no extension', () => {
    expect(resolveUploadFilename('', 'image/png')).toMatch(/^pasted-\d+\.png$/);
    expect(resolveUploadFilename('', 'image/jpeg')).toMatch(/^pasted-\d+\.jpg$/);
    expect(resolveUploadFilename('', 'image/gif')).toMatch(/^pasted-\d+\.gif$/);
    expect(resolveUploadFilename('', 'image/webp')).toMatch(/^pasted-\d+\.webp$/);
  });

  it('treats a trailing-dot name as extensionless and synthesizes from MIME', () => {
    expect(resolveUploadFilename('image.', 'image/png')).toMatch(/^pasted-\d+\.png$/);
  });

  it('does NOT fabricate an extension for a MIME miss — passes the original name through (server rejects)', () => {
    // image/bmp, image/svg+xml은 맵에 없다 → 임의 확장자를 지어내지 않고 원본 그대로 → 서버가 invalid-file로 거부.
    expect(resolveUploadFilename('', 'image/bmp')).toBe('');
    expect(resolveUploadFilename('', 'image/svg+xml')).toBe('');
    expect(resolveUploadFilename('', '')).toBe('');
    expect(resolveUploadFilename('', undefined)).toBe('');
  });
});
