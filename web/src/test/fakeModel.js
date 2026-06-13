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
    saveArticle(dto = {}) {
      if (dto.articleId) {
        const a = findArticle(dto.articleId);
        if (a) Object.assign(a, dto);
        else articles.push({ ...dto });
        notify('update');
        return { ok: true, articleId: dto.articleId };
      }
      const articleId = `AKRFAKE${String(seq++).padStart(9, '0')}`;
      articles.push({ ...dto, articleId, status: 'RDS' });
      notify('create');
      return { ok: true, articleId };
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

    subscribe(filter, onChange) {
      const handler = (signal) => onChange(signal, filter);
      listeners.add(handler);
      return {
        connected: () => true,
        unsubscribe: () => listeners.delete(handler),
      };
    },
  };
}
