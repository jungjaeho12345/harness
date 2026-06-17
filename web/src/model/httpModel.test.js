import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHttpModel } from './httpModel.js';

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
      emit(type, data) { (this.listeners[type] ?? []).forEach((cb) => cb({ data })); }
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

  it('subscribe keeps the ?session= query fallback when a token is stored (dev cross-origin)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-q', user: {} }));
    const instances = [];
    installFakeEventSource(instances);

    const model = createHttpModel({ base: BASE });
    await model.login('a', 'b'); // stores sid-q (dev 폴백용)

    model.subscribe({}, vi.fn());
    expect(instances[0].url).toBe(`${BASE}/api/stream?session=sid-q`);
  });
});
