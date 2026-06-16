// 번역 서버 프록시 서비스 — 기사 본문/제목을 외부 번역 API로 번역한다 (ADR-005 서버 프록시).
// provider: Google Cloud Translation v2 (운영 결정 — 사용자 승인).
// CRITICAL: API 키는 주입된 env(서버 환경변수)에서만 읽는다 — 소스 하드코딩 금지(news.md 보안).
// CRITICAL: 외부 호출은 주입된 fetchFn으로 추상화한다 — globalThis.fetch 직접 호출 금지(테스트 결정성).
// 외부 호출 실패/키 누락은 예외로 전파하지 않고 원문 폴백을 반환한다(news.md: 실패 시 graceful degrade).
// 기사 본문 텍스트를 로그로 외부에 흘리지 않는다(번역 요청 외 추가 전송 금지).

// --- provider 종속부(교체 가능 seam): 엔드포인트·요청 빌드·응답 파싱을 이 구획에 격리한다. ---
// provider 교체 시(예: DeepL/Papago) 아래 ENDPOINT·buildRequest·parseResponse만 바꾸면 된다.
const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

// 번역 요청을 만든다. 키가 없으면 undefined(키 누락 신호).
// Google v2는 API 키를 쿼리파라미터 ?key=<키>로 전달한다.
function buildRequest(text, targetLang, env = {}) {
  const key = env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) return undefined;
  const params = new URLSearchParams({
    key,
    q: text,
    target: targetLang,
    format: 'text',
  });
  return { url: `${ENDPOINT}?${params.toString()}`, options: { method: 'POST' } };
}

// Google v2 응답에서 번역문/감지 언어를 추출한다. 비정상 shape면 undefined.
function parseResponse(body) {
  const tr = body?.data?.translations?.[0];
  if (!tr || typeof tr.translatedText !== 'string') return undefined;
  return { translatedText: tr.translatedText, sourceLang: tr.detectedSourceLanguage };
}
// --- /provider 종속부 ---

export function createTranslate({ fetchFn, env }) {
  // text를 targetLang(기본 ko)로 번역한다. 항상 객체 반환(throw 없음).
  async function translate(text, targetLang = 'ko') {
    // 1) 빈/누락 text — 외부 호출 없이 빈 결과.
    if (!text) return { ok: true, translatedText: '' };

    // 2) 키 누락 — 외부 호출 없이 원문 그대로 graceful degrade.
    const req = buildRequest(text, targetLang, env);
    if (!req) return { ok: false, reason: 'no-key', translatedText: text };

    try {
      const res = await fetchFn(req.url, req.options);
      if (!res || !res.ok) return { ok: false, reason: 'error', translatedText: text };
      const body = await res.json();
      const parsed = parseResponse(body);
      if (!parsed) return { ok: false, reason: 'error', translatedText: text };
      return { ok: true, translatedText: parsed.translatedText, sourceLang: parsed.sourceLang };
    } catch {
      // 네트워크/파싱 오류 — 예외 대신 원문 폴백.
      return { ok: false, reason: 'error', translatedText: text };
    }
  }

  return { translate };
}
