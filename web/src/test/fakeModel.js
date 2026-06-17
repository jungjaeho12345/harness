// fakeModel — Model 계약(ADR-003)을 만족하는 in-memory 가짜. 테스트/스토리에서 실제 네트워크 없이 주입한다.
// httpModel과 같은 응답 shape({ ok, items, user, articleId, ... })을 흉내내고, 비밀번호는 어떤 응답에도 넣지 않는다.
// assertModel을 통과해야 한다(모든 MODEL_KEYS를 함수로 구현).

function stripPassword(user) {
  if (!user) return user;
  const safe = { ...user };
  delete safe.password;
  return safe;
}

export function createFakeModel(seed = {}) {
  const users = [...(seed.users ?? [])];
  const articles = [...(seed.articles ?? [])];
  const receiverConfigs = [...(seed.receiverConfigs ?? [])];
  const mediaItems = [...(seed.mediaItems ?? [])];
  // articleId -> 이력 배열(최신순). 컨트롤러 테스트가 seed로 주입한다.
  const histories = { ...(seed.histories ?? {}) };
  // articleId -> 번역문(seed). 없으면 원문 모사로 graceful 폴백.
  const translations = { ...(seed.translations ?? {}) };
  const listeners = new Set();
  let session = null; // { sessionId, user }
  let seq = 1;

  const notify = (kind) => { for (const fn of listeners) fn({ kind }); };
  const findArticle = (articleId) => articles.find((a) => a.articleId === articleId);

  return {
    login(userId, password) {
      const found = users.find((u) => u.userId === userId
        && (password === undefined || u.password === password));
      if (!found) return { ok: false, reason: 'invalid-credentials' };
      const user = stripPassword(found);
      session = { sessionId: `fake-${userId}`, user };
      return { ok: true, sessionId: session.sessionId, user };
    },
    logout() {
      session = null;
      return { ok: true };
    },
    restoreSession() {
      return session
        ? { ok: true, user: session.user }
        : { ok: false, reason: 'unauthenticated' };
    },

    queryUsers() {
      return { ok: true, items: users.map(stripPassword) };
    },
    createUser(payload = {}) {
      users.push({ ...payload });
      return { ok: true, user: stripPassword(payload) };
    },
    updateUser(userId, fields = {}) {
      const u = users.find((x) => x.userId === userId);
      if (!u) return { ok: false, reason: 'not-found' };
      Object.assign(u, fields);
      return { ok: true, user: stripPassword(u) };
    },

    queryArticles(filters = {}) {
      let items = articles;
      if (filters.status !== undefined) {
        const allow = [].concat(filters.status);
        items = items.filter((a) => allow.includes(a.status));
      }
      if (filters.excludeStatus !== undefined) {
        const deny = [].concat(filters.excludeStatus);
        items = items.filter((a) => !deny.includes(a.status));
      }
      return { ok: true, items: items.map((a) => ({ ...a })) };
    },
    searchArticles(q = '') {
      const needle = String(q);
      const items = articles.filter((a) => (a.title ?? '').includes(needle));
      return { ok: true, items: items.map((a) => ({ ...a })) };
    },
    searchMedia(query, type) {
      const items = mediaItems.filter((m) => !type || m.type === type);
      return { ok: true, items: items.map((m) => ({ ...m })), error: false };
    },
    applyAction(articleId, action) {
      const a = findArticle(articleId);
      if (!a) return { ok: false, reason: 'not-found' };
      a.lastAction = action;
      notify('status');
      return { ok: true, articleId };
    },
    getArticle(articleId) {
      const a = findArticle(articleId);
      if (!a) return { ok: false, reason: 'not-found' };
      // 서버 getById와 같은 shape({ article, contents }). in-memory는 평탄 1행이라 둘 다 같은 행을 비춘다.
      return { ok: true, article: { ...a }, contents: { ...a } };
    },
    saveArticle(dto = {}) {
      // 서버는 본문을 markupVersion 컬럼에만 저장하고 body 키는 버린다(ARTICLE_FIELDS pick 이음새).
      // 같은 정규화를 해야 contract 불일치(본문이 body로 전송되는 버그)가 단위테스트에서도 드러난다.
      const { body, ...persist } = dto; // eslint-disable-line no-unused-vars
      if (persist.articleId) {
        const a = findArticle(persist.articleId);
        if (a) Object.assign(a, persist);
        else articles.push({ ...persist });
        notify('update');
        return { ok: true, articleId: persist.articleId };
      }
      const articleId = `AKRFAKE${String(seq++).padStart(9, '0')}`;
      articles.push({ ...persist, articleId, status: 'RDS' });
      notify('create');
      return { ok: true, articleId };
    },

    // --- 메뉴 액션: 이력 / 파생 / 번역 ---
    // 이력보기/송고이력보기 — seed의 이력 배열을 반환. sendOnly면 송고(action==='send') 항목만 필터.
    queryHistory(articleId, { sendOnly } = {}) {
      const items = (histories[articleId] ?? []).map((h) => ({ ...h }));
      const filtered = sendOnly ? items.filter((h) => h.action === 'send') : items;
      return { ok: true, items: filtered };
    },
    // 후속/계속기사작성 — saveArticle처럼 새 articleId를 만들어 push. 원본은 변경하지 않는다(비파괴 모사).
    deriveArticle(articleId, mode) {
      const src = findArticle(articleId);
      if (!src) return { ok: false, reason: 'not-found' };
      const newId = `AKRFAKE${String(seq++).padStart(9, '0')}`;
      // continue는 본문 복사·followUp은 빈 본문(서버 deriveArticle 도메인 모사). 원본 객체는 건드리지 않는다.
      const derived = { ...src, articleId: newId, status: 'RDS' };
      if (mode === 'followUp') delete derived.body;
      articles.push(derived);
      notify('create');
      return { ok: true, articleId: newId };
    },
    // 번역 — seed의 번역문, 없으면 원문(title) 모사로 graceful 폴백.
    translate(articleId, targetLang = 'ko') { // eslint-disable-line no-unused-vars
      if (translations[articleId] !== undefined) {
        return { ok: true, translatedText: translations[articleId] };
      }
      const a = findArticle(articleId);
      return { ok: true, translatedText: a?.title ?? '' };
    },
    // 파일 업로드(첨부파일/자료파일) — 네트워크 없이 server /api/upload 응답 shape({ ok, path, filename })을 모사.
    // 저장 path는 server와 동일하게 /uploads/ 접두사를 둔다(테스트/스토리가 path 문자열을 그대로 dto에 싣는다).
    uploadFile(file = {}) {
      const name = file.name ?? 'file';
      return { ok: true, path: `/uploads/fake-${name}`, filename: name };
    },

    lockArticle(articleId) {
      const a = findArticle(articleId);
      if (a) a.lockYN = 'Y';
      notify('lock');
      return { ok: true };
    },
    unlockArticle(articleId) {
      const a = findArticle(articleId);
      if (a) a.lockYN = 'N';
      notify('lock');
      return { ok: true };
    },
    forceUnlockArticle(articleId) {
      const a = findArticle(articleId);
      if (a) a.lockYN = 'N';
      notify('lock');
      return { ok: true };
    },

    queryReceiverConfig() {
      return { ok: true, items: receiverConfigs.map((c) => ({ ...c })) };
    },
    createReceiverConfig(entry = {}) {
      const id = seq++;
      receiverConfigs.push({ ...entry, id });
      return { ok: true, id };
    },
    deleteReceiverConfig(id) {
      const i = receiverConfigs.findIndex((c) => c.id === id);
      if (i >= 0) receiverConfigs.splice(i, 1);
      return { ok: true };
    },

    subscribe(filter, onChange, onStatus) {
      const handler = (signal) => onChange(signal, filter);
      listeners.add(handler);
      onStatus?.(true); // fake 스트림은 즉시 연결됨으로 본다.
      return {
        connected: () => true,
        unsubscribe: () => listeners.delete(handler),
      };
    },
  };
}
