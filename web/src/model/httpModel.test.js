import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHttpModel, resolveUploadFilename } from './httpModel.js';

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

  // --- phase26 로그 뷰어 seam ---
  it('queryLogDigest GETs /api/logs/digest?date=... and returns { ok, digest }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, digest: { total: 3, byLevel: { INFO: 3 }, lines: [] } }));
    const model = createHttpModel({ base: BASE });

    const r = await model.queryLogDigest('2026-07-05');
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/logs/digest?date=2026-07-05`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('include');
    expect(r).toEqual({ ok: true, digest: { total: 3, byLevel: { INFO: 3 }, lines: [] } });
  });

  it('queryLogDigest omits the date query when no date is given', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, digest: { total: 0 } }));
    const model = createHttpModel({ base: BASE });

    await model.queryLogDigest();
    expect(callAt(0)[0]).toBe(`${BASE}/api/logs/digest`);
  });

  it('subscribeLogs opens /api/logs/stream with withCredentials, parses log entries and toggles status', () => {
    const instances = [];
    installFakeEventSource(instances);

    const model = createHttpModel({ base: BASE });

    const onLine = vi.fn();
    const onStatus = vi.fn();
    const sub = model.subscribeLogs(onLine, onStatus);

    expect(instances).toHaveLength(1);
    // 로그 스트림은 별도 채널 — 쿠키/헤더 인증만, 평문 세션 토큰을 URL에 붙이지 않는다.
    expect(instances[0].url).toBe(`${BASE}/api/logs/stream`);
    expect(instances[0].url).not.toContain('session=');
    expect(instances[0].opts).toEqual({ withCredentials: true });
    expect(sub.connected()).toBe(false);

    instances[0].emit('ready', '{"ok":true}');
    expect(sub.connected()).toBe(true);
    expect(onStatus).toHaveBeenCalledWith(true);

    const entry = { ts: '2026-07-05T06:00:00.000Z', level: 'INFO', message: 'hi', line: '[2026-07-05 06:00:00] [INFO] hi' };
    instances[0].emit('log', JSON.stringify(entry));
    expect(onLine).toHaveBeenCalledWith(entry);

    instances[0].emit('error', null);
    expect(sub.connected()).toBe(false);
    expect(onStatus).toHaveBeenCalledWith(false);

    sub.unsubscribe();
    expect(instances[0].closed).toBe(true);
  });

  it('subscribeLogs never puts a plaintext session token in the URL even when a token is stored', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-log', user: {} }));
    const instances = [];
    installFakeEventSource(instances);

    const model = createHttpModel({ base: BASE });
    await model.login('a', 'b'); // stores sid-log

    model.subscribeLogs(vi.fn());
    expect(instances[0].url).toBe(`${BASE}/api/logs/stream`);
    expect(instances[0].url).not.toContain('session=');
  });

  it('subscribeLogs skips malformed (non-JSON) log payloads without throwing', () => {
    const instances = [];
    installFakeEventSource(instances);

    const model = createHttpModel({ base: BASE });
    const onLine = vi.fn();
    model.subscribeLogs(onLine);

    expect(() => instances[0].emit('log', 'not-json{')).not.toThrow();
    expect(onLine).not.toHaveBeenCalled();
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
