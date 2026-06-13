// httpModel — Model 계약(ADR-003)의 실제 REST/SSE 배선. 모든 transport(fetch/EventSource)는
// 이 파일 안에만 있다. View/Controller는 절대 직접 fetch/EventSource를 호출하지 않는다.
//
// 세션 토큰(x-session-id)은 여기서 소유한다 — 로그인 응답의 sessionId를 sessionStorage에 보관하고
// 모든 요청에 자동 첨부한다. F5(새로고침) 후에도 보관된 토큰으로 restoreSession이 동작한다.
// 응답 shape은 server/index.js(step8) 라우트와 1:1로 맞춘다.

const SESSION_STORAGE_KEY = 'yh.sessionId';

function readSessionId() {
  try {
    return globalThis.sessionStorage?.getItem(SESSION_STORAGE_KEY) ?? null;
  } catch {
    // sessionStorage 접근 불가(SSR/프라이버시 모드 등) — 토큰 없음으로 취급.
    return null;
  }
}

function writeSessionId(sessionId) {
  try {
    if (sessionId) globalThis.sessionStorage?.setItem(SESSION_STORAGE_KEY, sessionId);
    else globalThis.sessionStorage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // sessionStorage 접근 불가 — 무시(이번 세션은 메모리 없이 진행).
  }
}

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
  // 모든 REST 호출의 단일 통로 — 세션 헤더 자동 첨부 + JSON 직렬화/역직렬화.
  async function request(path, { method = 'GET', body, query } = {}) {
    const headers = {};
    const sessionId = readSessionId();
    if (sessionId) headers['x-session-id'] = sessionId;
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}${buildQuery(query)}`, init);
    return res.json();
  }

  return {
    // --- 인증 / 세션 ---
    async login(userId, password) {
      const result = await request('/api/login', { method: 'POST', body: { userId, password } });
      if (result?.ok && result.sessionId) writeSessionId(result.sessionId);
      return result;
    },
    async logout() {
      const result = await request('/api/logout', { method: 'POST' });
      writeSessionId(null);
      return result;
    },
    // F5 복원 — 보관된 sessionId 헤더로 서버에 신원을 묻는다. 세션 없으면 throw가 아니라
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
    // EventSource는 커스텀 헤더를 못 보내므로 ?session= 쿼리로 인증한다(server 폴백).
    // ADR-005: 표준 EventSource가 끊김 시 자동 재연결을 제공한다. onChange는 "무효화 신호"만 받으며,
    // filter는 그대로 넘겨 Controller가 자기 필터로 재조회하게 한다.
    subscribe(filter, onChange) {
      const url = `${base}/api/stream${buildQuery({ session: readSessionId() })}`;
      const source = new EventSource(url);
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
