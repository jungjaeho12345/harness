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

  it('login POSTs credentials and does NOT store the session id (HttpOnly cookie holds it)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-1', user: { userId: 'kim' } }));
    const model = createHttpModel({ base: BASE });

    const r = await model.login('kim', 'pw');
    expect(r.user).toEqual({ userId: 'kim' });

    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/login`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ userId: 'kim', password: 'pw' });
    expect(init.headers['x-session-id']).toBeUndefined();

    // sessionStorage 토큰을 쓰지 않는다 — 쿠키가 세션을 보유한다.
    expect(sessionStorage.getItem('yh.sessionId')).toBeNull();

    // 이후 요청에도 x-session-id 헤더가 붙지 않는다(쿠키로 인증).
    await model.queryArticles();
    expect(callAt(1)[1].headers['x-session-id']).toBeUndefined();
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

  it('subscribe opens EventSource with withCredentials and NO ?session= query, routing change signals', async () => {
    const instances = [];
    class FakeEventSource {
      constructor(url, options) {
        this.url = url;
        this.options = options;
        this.listeners = {};
        this.closed = false;
        instances.push(this);
      }
      addEventListener(type, cb) { (this.listeners[type] ??= []).push(cb); }
      close() { this.closed = true; }
      emit(type, data) { (this.listeners[type] ?? []).forEach((cb) => cb({ data })); }
    }
    globalThis.EventSource = FakeEventSource;

    const model = createHttpModel({ base: BASE });

    const onChange = vi.fn();
    const sub = model.subscribe({ menu: 'desk' }, onChange);

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe(`${BASE}/api/stream`); // ?session= 제거
    expect(instances[0].url).not.toContain('session=');
    expect(instances[0].options).toEqual({ withCredentials: true }); // 쿠키 첨부
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
});
