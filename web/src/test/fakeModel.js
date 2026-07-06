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
  // 서버 로그 record 배열 모사(각 { seq, ts, level, message, line }) — subscribeLogs 접속 replay에 쓴다.
  const logs = [...(seed.logs ?? [])];
  const listeners = new Set();
  const logListeners = new Set();
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
    // clientId(편집 탭 식별자)는 PUT 저장 시 잠금 보유 탭 검증(assertLockHolder)에 쓰인다 — in-memory에선
    // 보유 탭(lockerClientId)이 다르면 거부해 "2번째 탭 저장 차단" 계약을 단위테스트에서 재현할 수 있게 한다.
    saveArticle(dto = {}, clientId) {
      // 서버는 본문을 markupVersion 컬럼에만 저장하고 body 키는 버린다(ARTICLE_FIELDS pick 이음새).
      // 같은 정규화를 해야 contract 불일치(본문이 body로 전송되는 버그)가 단위테스트에서도 드러난다.
      const { body, ...persist } = dto; // eslint-disable-line no-unused-vars
      // 편집(PUT, articleId 보유)일 때만 잠금 보유 탭을 검증한다. 잠겨 있고 보유 탭이 다르면 거부.
      if (persist.articleId) {
        const locked = findArticle(persist.articleId);
        if (locked && locked.lockYN === 'Y' && locked.lockerClientId
          && clientId !== undefined && clientId !== locked.lockerClientId) {
          return { ok: false, reason: 'not-holder' };
        }
      }
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
    // 기사이력비교 — 스냅샷 단건 지연 조회 모사. seed 이력에서 id 일치 항목을 복사해 { ok, item }으로 반환한다
    // (원본 불변·읽기 전용). articleId 스코프 밖/없는 id는 서버와 동일하게 not-found.
    getHistorySnapshot(articleId, historyId) {
      const h = (histories[articleId] ?? []).find((x) => x.id === historyId);
      if (!h) return { ok: false, reason: 'not-found' };
      return { ok: true, item: { ...h } };
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

    // clientId(편집 탭 식별자)-aware in-memory 잠금. acquire 규칙(편집 잠금 계약 a/b/c 모델의 축소판):
    // 이미 다른 clientId가 잠그고 있으면 'locked' 거부(같은 세션 다른 탭/다른 사용자), 같은 clientId면 재획득 허용.
    lockArticle(articleId, action, clientId) { // action은 서버 게이트용 — fake는 잠금 식별(clientId)만 검증
      const a = findArticle(articleId);
      if (a) {
        if (a.lockYN === 'Y' && a.lockerClientId && clientId !== undefined && a.lockerClientId !== clientId) {
          return { ok: false, reason: 'locked' };
        }
        a.lockYN = 'Y';
        a.lockerClientId = clientId ?? null;
      }
      notify('lock');
      return { ok: true };
    },
    // 보유 탭(lockerClientId===clientId)만 해제한다. 비보유 탭은 not-holder, 이미 해제면 멱등 ok.
    unlockArticle(articleId, clientId) {
      const a = findArticle(articleId);
      if (a) {
        if (a.lockYN === 'Y' && a.lockerClientId
          && clientId !== undefined && a.lockerClientId !== clientId) {
          return { ok: false, reason: 'not-holder' };
        }
        a.lockYN = 'N';
        a.lockerClientId = null;
      }
      notify('lock');
      return { ok: true };
    },
    // 강제 해제(D/Z) — clientId 무관하게 잠금을 비운다(보유 탭 검증 없음).
    forceUnlockArticle(articleId) {
      const a = findArticle(articleId);
      if (a) { a.lockYN = 'N'; a.lockerClientId = null; }
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

    // --- 로그 뷰어(Z 전용 — 서버 게이트) 모사 ---
    // 다이제스트 — logsDigest seed가 있으면 그걸, 없으면 logs를 { ok, items } 복사본으로 반환(원본 불변).
    getLogsDigest() {
      return { ok: true, items: (seed.logsDigest ?? logs).map((r) => ({ ...r })) };
    },
    // 로그 스트림 모사 — 접속 시 seed 로그를 즉시 replay(서버 replay 모사)한 뒤 구독 등록.
    subscribeLogs(onLog, onStatus) {
      for (const r of logs) onLog({ ...r });
      const handler = (r) => onLog({ ...r });
      logListeners.add(handler);
      onStatus?.(true); // fake 스트림은 즉시 연결됨으로 본다.
      return {
        connected: () => true,
        unsubscribe: () => logListeners.delete(handler),
      };
    },
  };
}
