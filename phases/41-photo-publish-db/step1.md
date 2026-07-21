# Step 1: model-contract — Photo 등록/검색 계약 3면 (contract/httpModel/fakeModel)

## 배경 / 요구사항

step0에서 백엔드에 사진 등록/검색 API 2개를 만들었다:
- `POST /api/photos` (세션 게이트) — body `{ src, caption, sourceArticleId }` → `{ ok, id }`. `registeredBy`/`createdAt`은 서버가 세션·시각으로 stamp.
- `GET /api/photos/search?q=<캡션>` (세션 게이트) → `{ ok, items }`(각 item: `{ id, src, caption, sourceArticleId, registeredBy, createdAt }`).

이 step은 프론트가 그 API를 부를 수 있게 **주입형 Model 계약(ADR-003)의 3면을 동시에 갱신**한다 — `MODEL_KEYS`(contract.js) + `httpModel`(REST 배선) + `fakeModel`(in-memory 가짜). 이 계약이 프론트/백 서비스 계약을 잇는 단일 통합 seam이라, 세 면을 함께 바꿔 shape 불일치를 한 곳에서 잠근다.

**이 step은 계약(model) 레이어만 다룬다.** View/Controller(다이얼로그·검색패널)는 절대 건드리지 않는다 — step2·step3이 담당한다.

### 확정된 설계 결정 (그대로 구현)

- 계약 키 2개 추가: **`publishPhoto`**(등록), **`searchPhotos`**(검색).
- `publishPhoto(payload)` → `POST /api/photos`. payload는 `{ src, caption, sourceArticleId }`. **role/registeredBy를 싣지 않는다**(서버가 세션에서 도출 — ADR-004). 응답 `{ ok, id }` 그대로 반환.
- `searchPhotos(q)` → `GET /api/photos/search`(쿼리 `q`). 응답 `{ ok, items }` 그대로 반환.
- `fakeModel`은 in-memory Photo 스토어로 **등록→검색 루프를 재현**한다(단위/컴포넌트 테스트가 네트워크 없이 풀 루프를 검증할 수 있게). `registeredBy`는 fake의 현재 세션 사용자로 stamp(서버 동형 — 클라 값 신뢰 안 함).

## 읽어야 할 파일

먼저 아래를 읽고 계약 3면 패턴과 기존 형제 메서드(searchMedia/searchArticles/uploadFile)의 shape을 파악하라:

- `/docs/ADR.md` — ADR-003(주입형 Model 계약·`freeze`된 MODEL_KEYS·httpModel 뒤 배선 격리·fakeModel 주입·백엔드 shape 수동 동기화), ADR-004(role은 서버 세션에서만 — 계약이 role을 싣지 않는 이유).
- `/docs/ARCHITECTURE.md` — 프론트 MVC(View←Controller←Model), 얇은 transport, 실시간은 무효화 신호.
- **step0 산출물**(이전 step 요약도 참고): `src/db/schema.js`의 `Photo` 배열, `server/index.js`의 `POST /api/photos`·`GET /api/photos/search` 라우트, `src/services/photoService.js`(응답 shape `{ ok, id }` / `{ ok, items }`). **httpModel 응답 shape은 이 라우트와 1:1로 맞춘다.**
- `web/src/model/contract.js` — **결선 지점**: `MODEL_KEYS` 배열(L5~36)과 `assertModel`(L39~48). 배열에 키 2개를 추가한다. 관련 형제: `searchArticles`·`searchMedia`(L13~14, 검색), `uploadFile`(L30, 파일 쓰기 — 주석 스타일 참고).
- `web/src/model/httpModel.js` — **결선 지점**: `request(path, {method, body, query})` 단일 통로(L80~96), 반환하는 메서드 객체(L98~288). 형제 배선: `searchArticles(q)`(L139~141, `request('/api/articles/search', { query:{ q } })`), `searchMedia(query,type)`(L142~144), `saveArticle`(L157~163, POST body). 여기에 `publishPhoto`/`searchPhotos`를 추가한다.
- `web/src/test/fakeModel.js` — **결선 지점**: in-memory 시드(L12~26, `mediaItems`·`articles`·`seq`·`session`), `searchMedia`(L81~84), `searchArticles`(L76~80), `saveArticle`(L100~123, 새 id 발급 + notify), `uploadFile`(L161~164). Photo 스토어와 `publishPhoto`/`searchPhotos`를 추가한다. `assertModel`을 통과해야 하므로 **모든 MODEL_KEYS를 함수로 구현**해야 한다.
- `web/src/model/contract.test.js` — 계약 테스트 컨벤션(MODEL_KEYS·assertModel 단언).
- `web/src/model/httpModel.test.js` — httpModel 배선 테스트 컨벤션(fetch 스텁으로 요청 path/method/body/query 단언). searchMedia/searchArticles/uploadFile 테스트가 형제 패턴.

이전 step(step0)에서 만든 라우트 shape을 꼼꼼히 확인하고(요청 body 키·응답 키), 계약 3면이 그와 정확히 일치하도록 작업하라.

## 작업

TDD로 진행한다(`vitest`). **테스트를 먼저** 추가하고 통과하는 구현을 만든다.

### 1. 계약 — `web/src/model/contract.js`
- `MODEL_KEYS` 배열에 두 키를 추가한다(형제 검색 키 근처, 주석 한 줄과 함께):
  ```js
  // 사진발행/DB등록(phase 41) — 등록 POST /api/photos · 캡션 검색 GET /api/photos/search와 1:1.
  'publishPhoto',
  'searchPhotos',
  ```

### 2. httpModel — `web/src/model/httpModel.js`
- 반환 메서드 객체에 배선 2개를 추가한다(검색/저장 형제 옆):
  ```js
  // 사진 등록 — role/registeredBy를 싣지 않는다(서버가 세션에서 도출, ADR-004). 응답 { ok, id }.
  publishPhoto(payload = {}) {
    return request('/api/photos', { method: 'POST', body: payload });
  },
  // 사진DB 캡션 검색 — 응답 { ok, items } 그대로 반환.
  searchPhotos(q) {
    return request('/api/photos/search', { query: { q } });
  },
  ```
  - body는 `{ src, caption, sourceArticleId }`를 그대로 전달한다(호출자가 구성). 시그니처는 payload 객체 하나 — saveArticle이 dto를 받는 것과 동형.

### 3. fakeModel — `web/src/test/fakeModel.js`
- in-memory 스토어를 시드에 추가한다: `const photos = [...(seed.photos ?? [])];` (기존 `mediaItems`/`articles` 옆). id 발급은 기존 `seq`를 공유하거나 별도 카운터 — receiverConfig처럼 `seq++`.
- `publishPhoto(payload = {})`:
  ```js
  const { src, caption, sourceArticleId } = payload;
  const id = seq++;
  photos.push({
    id, src, caption: caption ?? '', sourceArticleId: sourceArticleId ?? '',
    registeredBy: session?.user?.userId ?? null,  // 서버 동형 — 세션 사용자로 stamp(payload 값 신뢰 안 함)
    createdAt: new Date().toISOString(),
  });
  return { ok: true, id };
  ```
- `searchPhotos(q = '')`:
  ```js
  const needle = String(q);
  const items = photos.filter((p) => (p.caption ?? '').includes(needle));
  return { ok: true, items: items.map((p) => ({ ...p })) };  // 복사본 — 원본 불변
  ```
  - searchArticles(L76~80)와 동형(부분일치 + 복사본 반환).

### 4. 테스트 (먼저 작성)
- `web/src/model/contract.test.js`:
  - `MODEL_KEYS`가 `'publishPhoto'`·`'searchPhotos'`를 포함함을 단언.
  - fakeModel이 `assertModel`을 통과함(모든 키 구현)을 단언 — 기존 테스트가 이미 있으면 자동 커버되나, 신규 키 누락 시 실패하도록 확인.
- `web/src/model/httpModel.test.js`:
  - `publishPhoto({ src, caption, sourceArticleId })`가 `POST /api/photos`로 JSON body를 보냄을 단언(fetch 스텁 — method·path·parse된 body 확인). role/registeredBy가 body에 없음을 단언.
  - `searchPhotos('토픽')`가 `GET /api/photos/search?q=토픽`를 부름을 단언(query 인코딩).
  - (searchMedia/searchArticles 테스트가 형제 — 같은 스텁 패턴 재사용.)
- fakeModel 루프 테스트(contract.test.js나 별도 fakeModel 테스트에 추가):
  - 로그인(세션 있음) 상태에서 `publishPhoto`로 등록 후 `searchPhotos`로 캡션 검색 시 그 사진이 반환되고 `registeredBy`가 세션 userId임을 단언.
  - payload에 `registeredBy`를 실어도 fake가 무시하고 세션 사용자로 stamp함을 단언(계약 정합 — 서버와 동일 신뢰 경계).

## Acceptance Criteria

```bash
npm run lint          # ESLint 클린
npm run build         # vite 빌드
npm run test:web      # 웹 테스트 — 신규 contract/httpModel/fakeModel 단언 포함 전체 통과
npm test              # 백엔드(node --test) — 이 step은 백엔드 미변경이라 그대로 통과
```

기대 단언(요약):
- `MODEL_KEYS`에 `publishPhoto`·`searchPhotos`가 있고 fakeModel이 `assertModel`을 통과한다.
- `httpModel.publishPhoto`가 `POST /api/photos`(body에 role/registeredBy 없음), `searchPhotos`가 `GET /api/photos/search?q=`를 부른다.
- `fakeModel`이 등록→검색 루프를 재현하고 `registeredBy`를 세션 사용자로 stamp한다.
- 기존 웹·백엔드 테스트가 **모두 그대로 통과**한다(회귀 없음).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 계약 3면(contract/httpModel/fakeModel)이 동시에·정합으로 갱신됨(shape 일치).
   - httpModel 응답 shape이 step0 라우트(`{ ok, id }` / `{ ok, items }`)와 1:1.
   - role/registeredBy를 계약에서 싣지 않음(ADR-004).
   - View/Controller 미변경(이 step은 model 레이어만).
3. 결과에 따라 `phases/41-photo-publish-db/index.json`의 step 1을 갱신(completed+summary / error / blocked).

## 금지사항

- 상위 `phases/index.json`(top-level 트래커)을 수정하지 마라. 이유: 오케스트레이터/execute.py 관리 파일 — step은 `phases/41-photo-publish-db/index.json`(로컬)만 갱신한다.
- `publishPhoto` body에 `role`이나 `registeredBy`를 싣지 마라. 이유: 신원/역할은 서버가 세션에서만 도출한다(ADR-004) — 계약이 클라 값을 실으면 신뢰 경계가 흐려진다.
- httpModel에서 `fetch`/`request`를 우회해 직접 XHR/EventSource를 쓰지 마라. 이유: 모든 REST는 `request` 단일 통로(쿠키·세션 헤더·JSON 직렬화)를 거친다(ADR-003).
- View/Controller(WriterPage·useSearchController·다이얼로그)를 이 step에서 건드리지 마라. 이유: 이 step은 계약(model) 레이어만 — UI 결선은 step2·step3.
- fakeModel이 `assertModel`을 통과하지 못하게 두지 마라(키 누락). 이유: 계약 위반 — 모든 MODEL_KEYS를 함수로 구현해야 한다.
- 기존 테스트를 깨뜨리지 마라.
