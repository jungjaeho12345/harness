# Step 5: translate-service

우클릭 메뉴의 **번역(translate)** 백엔드 도메인 로직을 구현한다. 기사 본문/제목을 외부 번역 API로 번역한다. 외부 의존성이므로 **mediaSearch와 동일한 추상화 패턴**(주입 `fetchFn` + env API 키)을 따르고, **키가 없거나 호출이 실패하면 예외 대신 graceful degrade**(원문 또는 빈 결과 반환)한다. 이 step은 백엔드 도메인 레이어(service)만 다룬다.

> ⚠️ **blocked 위험:** 번역 provider/API 키는 미해결 결정사항이다(이 phase의 미해결 항목 — 권장: DeepL 또는 Google Cloud Translation). **provider 선택과 키 주입은 운영 결정이므로, 키가 없으면 이 step은 graceful degrade 경로(키 없음→원문 그대로 반환)까지 구현·테스트하고 `completed`로 둔다.** 실제 외부 번역 호출의 라이브 검증은 키가 필요하므로, 키 없이 검증 불가한 부분이 있으면 그 부분만 명확히 적고 진행하라(단위 테스트는 가짜 fetchFn으로 전부 가능 — blocked가 되면 안 된다).

## 읽어야 할 파일

- `/docs/ADR.md` — ADR-005(외부 호출은 서버 프록시·주입 추상화), 철학(외부 의존성 최소화·실패 시 빈 결과).
- `/docs/ARCHITECTURE.md` — `src/services/` 위치, 보안 경계(API 키는 서버 환경변수).
- `/docs/news.md` — 51~52행(외부 검색 API 키는 서버 환경변수·실패 시 빈 결과 — **번역도 동일 정책을 따른다**), 85행(번역 메뉴), 88행(현재 비활성).
- 현재 구현(반드시 정독 — 이 패턴을 그대로 본떠라):
  - `src/services/mediaSearch.js` — `createMediaSearch({ fetchFn, env })`: 키를 **주입 env에서만** 읽음(하드코딩 금지)·URL 빌드·실패/키누락 시 `{items:[],error:true}` graceful return·try/catch로 throw 방지.
  - `src/controllers/index.js` — `createMediaSearch`가 `env`/`fetchFn`을 합성 루트에서 주입받는 방식(L23-24, L40, L75-77).
  - 테스트 패턴: `test/mediaSearch.test.js` — 가짜 `fetchFn`/`env`로 네트워크 없이 결정적 검증(키 누락→fetch 미호출·HTTP non-ok→빈 결과·throw→빈 결과).

이전 코드를 정독하고, mediaSearch가 키 누락·네트워크 오류를 어떻게 graceful하게 처리하는지 이해한 뒤 작업하라.

## 작업

### TDD 순서: 먼저 실패 테스트를 쓴다

`test/translateService.test.js`(node --test, 가짜 `fetchFn`/`env` 주입 — **실제 네트워크 없음**) 시나리오:

1. 키가 주입된 env + 정상 응답(가짜 fetchFn)일 때 `translate(text, targetLang)`가 번역 결과 `{ ok:true, translatedText, sourceLang? }`를 반환한다.
2. **키 누락**(env에 번역 키 없음) 시 fetch를 호출하지 **않고** graceful degrade — `{ ok:false, reason:'no-key', translatedText: <원문> }`(원문 그대로, 예외 없음). 프론트가 원문/안내를 표시할 수 있게 한다.
3. **네트워크 throw**·**HTTP non-ok**(가짜 fetchFn) 시 예외 없이 `{ ok:false, reason:'error', translatedText: <원문> }`.
4. API 키가 URL/헤더로 **주입 env에서만** 읽히고 소스에 하드코딩되지 않는다(테스트: 다른 키 주입 시 다른 요청).
5. 빈/누락 text는 빈 결과(`{ ok:true, translatedText:'' }` 또는 `no-input`) — 결정해 주석으로 명시.

먼저 실패를 확인한 뒤 구현한다.

### 구현: `src/services/translate.js`

`createTranslate({ fetchFn, env })`를 만들고 `{ translate }`를 반환하라. **mediaSearch.js 구조를 그대로 본떠라**:

```
const ENDPOINT = <provider 엔드포인트 상수>;  // 권장: DeepL https://api-free.deepl.com/v2/translate 또는 Google translation
function buildRequest(text, targetLang, env)  // 키 없으면 undefined 반환
async function translate(text, targetLang = 'ko')
  // 1) text 비면 빈 결과
  // 2) const req = buildRequest(...); 없으면(키 누락) { ok:false, reason:'no-key', translatedText: text }
  // 3) try { res = await fetchFn(...); !res.ok → { ok:false, reason:'error', translatedText: text } }
  //    catch { return { ok:false, reason:'error', translatedText: text } }
  // 4) 정상: body에서 번역문 추출 → { ok:true, translatedText, sourceLang }
```

**핵심 규칙:**
- API 키는 **주입 `env`에서만** 읽는다(예: `env.TRANSLATE_API_KEY`). 소스 하드코딩 금지(news.md 보안·CLAUDE.md UTF-8/보안).
- 외부 호출은 **주입 `fetchFn`으로만**. `globalThis.fetch` 직접 호출 금지(테스트 결정성).
- **실패·키 누락은 예외로 전파하지 않는다.** 항상 객체 반환. 프론트가 원문 또는 "번역 불가" 안내를 표시할 수 있도록 `translatedText`에 원문을 폴백으로 담는다(news.md: 외부 실패 시 graceful degrade).
- provider 선택은 **미해결 결정사항**이다. 합리적 기본(DeepL Free 또는 Google)을 선택하되, provider 종속 부분(엔드포인트·요청 shape·응답 파싱)을 한 곳(`buildRequest`/파싱 함수)에 격리하고 주석으로 "provider 미확정 — 교체 가능 seam"을 남겨라.

### 결선(controllers)

`src/controllers/index.js`에서 `createTranslate({ fetchFn, env })`를 합성 루트 기본값(전역 fetch·process.env)으로 결선하고, `translate: { run: (text, targetLang) => translate.translate(text, targetLang) }`(또는 기존 `media`처럼 단일 객체)를 반환에 추가하라(위임만). **HTTP 라우트는 step6 소관 — server/index.js는 건드리지 마라.**

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

기존 테스트를 단 1개도 깨뜨리지 마라. **이 step의 모든 테스트는 가짜 fetchFn으로 동작해 실제 키 없이 통과해야 한다.**

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - API 키가 주입 env에서만 읽히고 하드코딩이 없는가? (보안)
   - 외부 호출이 주입 fetchFn으로만 이뤄지고 globalThis.fetch 직접 호출이 없는가? (테스트 결정성)
   - 키 누락·네트워크 오류·HTTP non-ok가 예외 없이 graceful 객체 반환인가? (news.md degrade)
   - provider 종속부가 한 곳에 격리됐는가?
3. 결과에 따라 `phases/1-menu-actions/index.json`의 step 5를 업데이트한다:
   - 성공(단위 테스트 전부 통과) → `"status": "completed"`, `"summary": "...(provider·env 키 이름 명시)"`
   - 단, **실제 외부 번역 호출의 라이브 검증이 필요해 진행 불가하면** → `"status": "blocked"`, `"blocked_reason": "번역 provider 미확정/API 키 미주입 — TRANSLATE_API_KEY 등 운영 결정 필요"`. (단위 테스트만으로 graceful 경로가 검증되면 blocked가 아니라 completed로 둔다.)

## 금지사항

- API 키를 소스에 하드코딩하지 마라. 이유: news.md 보안 — 키는 서버 환경변수(주입 env)에서만.
- `globalThis.fetch`를 직접 호출하지 마라. 이유: 테스트 결정성 — 주입 fetchFn만 사용(mediaSearch 패턴).
- 외부 호출 실패/키 누락을 throw로 전파하지 마라. 이유: news.md — 외부 실패 시 오류가 아니라 graceful degrade(원문/빈 결과).
- 기사 본문 텍스트를 로그로 외부에 흘리지 마라. 이유: news.md 163행 정신(기사 텍스트 외부 전송 최소화) — 번역 요청 외 추가 전송 금지.
- `server/index.js`/프론트를 이 step에서 수정하지 마라. 이유: HTTP는 step6, 프론트는 step7·10.
- 기존 테스트를 깨뜨리지 마라.
