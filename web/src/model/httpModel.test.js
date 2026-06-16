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

  it('login POSTs credentials and uses credentials:include — no x-session-id header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, user: { userId: 'kim' } }));
    const model = createHttpModel({ base: BASE });

    const r = await model.login('kim', 'pw');
    expect(r.ok).toBe(true);

    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/login`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ userId: 'kim', password: 'pw' });
    expect(init.credentials).toBe('include');
    expect(init.headers['x-session-id']).toBeUndefined();

    // 이후 요청도 credentials:include — 쿠키 자동 전송, x-session-id 없음.
    await model.queryArticles();
    expect(callAt(1)[1].credentials).toBe('include');
    expect(callAt(1)[1].headers['x-session-id']).toBeUndefined();
  });

  it('logout POSTs to /api/logout with credentials:include — no sessionStorage side-effect', async () => {
    const model = createHttpModel({ base: BASE });
    await model.login('a', 'b');

    await model.logout();
    expect(callAt(1)[0]).toBe(`${BASE}/api/logout`);
    expect(callAt(1)[1].method).toBe('POST');
    expect(callAt(1)[1].credentials).toBe('include');
    expect(callAt(1)[1].headers['x-session-id']).toBeUndefined();

    // 로그아웃 후 후속 요청에도 x-session-id 없음 (쿠키는 서버가 만료).
    await model.queryArticles();
    expect(callAt(2)[1].credentials).toBe('include');
    expect(callAt(2)[1].headers['x-session-id']).toBeUndefined();
  });

  it('restoreSession GETs /api/session with credentials:include — no x-session-id', async () => {
    const model = createHttpModel({ base: BASE });

    await model.restoreSession();
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/session`);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
    expect(init.headers['x-session-id']).toBeUndefined();
    expect(init.body).toBeUndefined();
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

  it('subscribe opens EventSource with withCredentials:true and no ?session= query', async () => {
    const instances = [];
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

    const model = createHttpModel({ base: BASE });

    const onChange = vi.fn();
    const sub = model.subscribe({ menu: 'desk' }, onChange);

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe(`${BASE}/api/stream`); // ?session= 없음
    expect(instances[0].opts).toEqual({ withCredentials: true });
    expect(sub.connected()).toBe(false);

    instances[0].emit('ready', '{"ok":true}');
    expect(sub.connected()).toBe(true);

    instances[0].emit('change', '{"kind":"status"}');
    expect(onChange).toHaveBeenCalledWith({ kind: 'status' }, { menu: 'desk' });

    sub.unsubscribe();
    expect(instances[0].closed).toBe(true);
  });
});
