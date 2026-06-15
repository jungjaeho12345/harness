// httpModel — Model 계약(ADR-003)의 실제 REST/SSE 배선. 모든 transport(fetch/EventSource)는
// 이 파일 안에만 있다. View/Controller는 절대 직접 fetch/EventSource를 호출하지 않는다.
//
// 세션은 서버가 발급한 HttpOnly 쿠키(yh.sid)가 보유한다. HttpOnly는 JS가 못 읽으므로 프론트는
// 토큰을 다루지 않고, 브라우저가 자동 전송하도록 fetch는 credentials:'include', EventSource는
// withCredentials:true로 쿠키를 첨부한다(cross-origin :5173↔:3001, 서버 CORS credentials:true와 짝).
// F5(새로고침) 복원은 /api/session을 쿠키 신원으로 호출해 동작한다. 응답의 sessionId는 더 이상
// 신뢰/저장하지 않는다. 응답 shape은 server/index.js 라우트와 1:1로 맞춘다.

// 배열 값은 server의 반복 파라미터 파싱(status IN / departments IN)에 맞춰 같은 키를 여러 번 append한다.
function buildQuery(params = {}) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((v) => sp.append(key, v));
    else sp.append(key, value);
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

export function createHttpModel({ base = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:3001' } = {}) {
  // 모든 REST 호출의 단일 통로 — 쿠키 첨부(credentials:'include') + JSON 직렬화/역직렬화.
  async function request(path, { method = 'GET', body, query } = {}) {
    const headers = {};
    const init = { method, headers, credentials: 'include' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}${buildQuery(query)}`, init);
    return res.json();
  }

  return {
    // --- 인증 / 세션 ---
    // 로그인 성공 시 서버가 Set-Cookie(yh.sid)로 세션을 발급한다. 프론트는 result.user만 상위로 흘리고
    // sessionId는 저장하지 않는다(쿠키가 보유).
    login(userId, password) {
      return request('/api/login', { method: 'POST', body: { userId, password } });
    },
    // 서버가 세션 무효화 + clearCookie로 처리한다. 프론트가 따로 토큰을 지울 것이 없다.
    logout() {
      return request('/api/logout', { method: 'POST' });
    },
    // F5 복원 — 쿠키(credentials:'include')로 서버에 신원을 묻는다. 세션 없으면 throw가 아니라
    // 비로그인 응답({ ok:false, reason:'unauthenticated' })을 그대로 돌려준다.
    restoreSession() {
      return request('/api/session');
    },

    // --- 사용자 (Z 게이트는 서버가 강제. 응답에 비밀번호 없음) ---
    queryUsers(filters = {}) {
      return request('/api/users', { query: filters });
    },
    createUser(payload) {
      return request('/api/users', { method: 'POST', body: payload });
    },
    updateUser(userId, fields) {
      return request(`/api/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: fields });
    },

    // --- 기사 조회/검색/저장 ---
    queryArticles(filters = {}) {
      return request('/api/articles', { query: filters });
    },
    // 단건 조회 — 본문(markupVersion)을 포함한 전체 기사 { ok, article, contents }. 편집 진입 시 본문 채우기.
    getArticle(articleId) {
      return request(`/api/articles/${encodeURIComponent(articleId)}`);
    },
    searchArticles(q) {
      return request('/api/articles/search', { query: { q } });
    },
    searchMedia(query, type) {
      return request('/api/media/search', { query: { q: query, type } });
    },
    // role은 서버 세션에서 도출 — body로 보내지 않는다(ADR-004).
    applyAction(articleId, action) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/action`, {
        method: 'POST',
        body: { action },
      });
    },
    // articleId 유무로 신규 생성(POST)/부분 수정(PUT, 잠금 보유자)을 한 메서드가 분기한다.
    saveArticle(dto = {}) {
      if (dto.articleId) {
        return request(`/api/articles/${encodeURIComponent(dto.articleId)}`, { method: 'PUT', body: dto });
      }
      return request('/api/articles', { method: 'POST', body: dto });
    },

    // --- 편집 잠금 ---
    lockArticle(articleId, action) {
      const body = action ? { action } : {};
      return request(`/api/articles/${encodeURIComponent(articleId)}/lock`, { method: 'POST', body });
    },
    unlockArticle(articleId) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/unlock`, { method: 'POST' });
    },
    forceUnlockArticle(articleId) {
      return request(`/api/articles/${encodeURIComponent(articleId)}/force-unlock`, { method: 'POST' });
    },

    // --- 수신 설정 (Z 전용 — 서버 게이트) ---
    queryReceiverConfig(filters = {}) {
      return request('/api/receiver-config', { query: filters });
    },
    createReceiverConfig(entry) {
      return request('/api/receiver-config', { method: 'POST', body: entry });
    },
    deleteReceiverConfig(id) {
      return request(`/api/receiver-config/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    // --- 실시간 무효화 스트림 (SSE) ---
    // EventSource는 커스텀 헤더를 못 보내므로 withCredentials:true로 HttpOnly 쿠키를 첨부해 인증한다
    // (step2: 서버가 ?session= 쿼리를 더 이상 신뢰하지 않으므로 쿼리 토큰을 제거).
    // ADR-005: 표준 EventSource가 끊김 시 자동 재연결을 제공한다. onChange는 "무효화 신호"만 받으며,
    // filter는 그대로 넘겨 Controller가 자기 필터로 재조회하게 한다.
    subscribe(filter, onChange) {
      const source = new EventSource(`${base}/api/stream`, { withCredentials: true });
      let connected = false;
      source.addEventListener('ready', () => { connected = true; });
      source.addEventListener('change', (event) => {
        let signal = {};
        try {
          signal = event.data ? JSON.parse(event.data) : {};
        } catch {
          signal = {};
        }
        onChange(signal, filter);
      });
      source.addEventListener('error', () => { connected = false; });
      return {
        connected: () => connected,
        unsubscribe: () => source.close(),
      };
    },
  };
}
