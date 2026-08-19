# Step 9: media-upload

**외부 프록시·파일·사진 5 라우트**를 동결한다: `POST /api/articles/:id/translate`(#26) · `GET /api/media/search`(#31) · `POST /api/upload`(#32) · `POST /api/photos`(#33) · `GET /api/photos/search`(#34). 계약 축은 **외부 키 미설정 시의 graceful degrade(200인데 `ok:false`)**, **base64 업로드 계약(확장자 14종·5MB·`/uploads/<hex>.<ext>`)**, **사진 등록의 src 검증**이다.

## 읽어야 할 파일

- `phases/67-port-p1-contract/index.json` — decisions **(2)(5)(6)(9)(11)(16)(18)** · excluded (j)
- `docs/api-contract/endpoints.json` — `articles-translate`·`media-search`·`upload`·`photos-create`·`photos-search` 행
- `server/index.js` — translate 라우트(912~923행: 본문을 **서버 DB에서** 뽑아 프록시·graceful 객체 그대로 반환), media(994~1001행), upload(1011~1043행: 확장자·크기·`wx` 플래그·응답 path), photos(1048~1065행)
- `server/index.js` 310~316행 — `UPLOAD_EXT_ALLOWLIST` 14종 · `UPLOAD_MAX_BYTES`
- `src/services/mediaSearch.js` — 키 없을 때의 **결정적 데모 폴백**(picsum seed·고정 videoId 4종)과 실패 시 `{items:[],error:true}`
- `src/services/translate.js` — 키 없음(`no-key`)·외부 실패(`error`)·빈 입력(`{ok:true,translatedText:''}`)
- `src/services/photoService.js` · `src/services/fileRef.js` — `invalid-src` 판정(업로드 상대경로 또는 https만)
- `docs/SCHEMA.md` Photo 테이블 절 — append-only·registeredBy는 세션에서만
- `test/upload.test.js` · `test/photos-api.test.js` · `test/mediaSearch.test.js` · `test/translateService.test.js` — 예측 수립용

## 배경

- 러너가 외부 API 키 env 4종을 **삭제**하므로 이 프로파일에서는 실 네트워크 호출이 일어나지 않는다: 미디어 검색은 결정적 데모 결과, 번역은 키 없음 폴백. 이 "키 없는 서버의 계약"이 스위트가 동결하는 대상이며, 키가 있는 서버의 동작은 명세에 서술만 한다(미검증 기록).
- `POST /api/articles/:id/translate`는 **상태코드로 성공을 판정할 수 없는 대표 사례**다(키 없음도 200). Spring 이식에서 이걸 500이나 400으로 바꾸면 클라이언트가 조용히 깨진다.
- 업로드는 multipart가 아니라 **base64 JSON**(`{filename, contentBase64}`)이다. 응답 `path`는 `/uploads/<32-hex>.<ext>` 형식이고 파일명은 서버가 발급한다(사용자 filename은 확장자 판정에만 쓴다).
- 사진 등록은 `registeredBy`를 세션에서만 stamp하고 body의 값은 무시한다(ADR-004).

## 작업

### A. `contract/cases/default/media-upload.contract.js`

1. **인가**: 5 라우트 전부 미인증 → 401.
2. **media 검색**: 세션 + `?q=<고정 문자열>&type=image` → 200 `{ok:true, items:[...]}`(키 없는 서버이므로 데모 폴백) · items 원소 키 집합 실측(`title`·`link` 등) · `type=video` → 원소 키(`title`·`videoId`·`url`). `type` 누락/이상값은 video로 처리되는지 확인. 같은 질의를 두 번 호출해 **결과가 동일한지**(결정성) 확인한다. `error` 필드의 유무를 실측해 기록(응답에 `error: undefined`가 어떻게 직렬화되는지도 계약이다).
3. **translate**: step5의 픽스처 기사(본문 있음)로 `POST /api/articles/:id/translate` → **200** · `ok:false` + `reason:'no-key'`(실측 확인) 또는 실측된 다른 shape. **상태코드 200과 `ok:false`의 공존을 명세에 굵게 기록**한다. 없는 articleId → 404 `not-found`. `targetLang` 생략 시 기본값(`ko`)이 요청에 쓰이는지는 외부 호출이 없어 관측 불가 — 미검증으로 기록.
4. **upload 성공**: 아주 작은 png(수십 바이트 base64 상수)로 `POST /api/upload` → 200 `{ok:true, path, filename}` · `path`가 `/uploads/<hex>.png` 정규식과 일치(값은 리포트에 마스킹) · 응답 `filename`이 요청 filename과 같음. 이어서 **`GET <path>`로 파일이 실제 서빙되는지**(200 + content-type) 확인한다 — 정적 서빙이 업로드 계약의 일부다.
5. **upload 거부**: (a) 허용 밖 확장자(`.exe`) → 400 `invalid-file` (b) 확장자 없음 → 400 `invalid-file` (c) `contentBase64` 누락/비문자열 → 400 `invalid-file` (d) 5MB 초과(여유 있게 초과하는 크기, 예: 6MB 상당의 base64를 **런타임에 생성**) → 400 `too-large`. (d)는 실행 시간이 늘 수 있으니 1건만 둔다.
6. **확장자 화이트리스트 전수**: 14종 각각으로 최소 크기 업로드를 시도해 전부 200인지 확인한다(각 확장자에 유효한 파일 내용일 필요는 없다 — 서버는 확장자와 크기만 본다. 이 사실도 계약이므로 명세에 명시).
7. **photos 등록**: 4에서 받은 `/uploads/...` 경로로 `POST /api/photos` + caption(고유 토큰) → 200 `{ok:true, id}`. `https://` src도 1건. `javascript:`·`data:`·`http://`·`../` traversal → 400 `invalid-src`(각 1건).
8. **photos 신뢰 경계**: body에 `registeredBy:'someone-else'`를 넣어도 무시되는지 — 검색으로 되읽어 확인한다(응답에 registeredBy가 없으면 관측 불가로 기록).
9. **photos 검색**: `GET /api/photos/search?q=<7의 고유 caption 토큰>` → 자기 사진만 매칭 · 원소 키 집합 실측. 빈 `q` 동작 실측.

### B. 명세 반영 `docs/api-contract/openapi.yaml`

- 5 라우트 paths 추가.
- 업로드: 요청 스키마(`filename`·`contentBase64`), 확장자 14종 enum, 5MB 상한(디코드 후 바이트), 응답 `path` 패턴, "파일명은 서버가 발급한다"·"기존 파일을 덮어쓰지 않는다(`wx`)"를 description에.
- translate/media: **graceful degrade 계약**(200 + `ok:false`, 실패 시 빈 결과 + `error:true`)을 굵게 서술하고, 키가 설정된 서버의 동작은 "미검증(스위트는 키 없는 구성에서 측정)"으로 명시.
- photos: src 허용 규칙(업로드 상대경로 또는 https만)과 append-only(삭제 API 없음)를 명시.

## Acceptance Criteria

```bash
npm run test:contract -- --profile default --files contract/cases/default/media-upload.contract.js
npm run test:contract
npm test
npm run lint
node scripts/contract-inventory-check.mjs
git status --porcelain
```

## 검증 절차

1. 예측 먼저: translate의 상태코드(200 vs 4xx)·media의 `error` 필드 직렬화·업로드 거부 토큰 3종을 예측하고 실측과 대조해 요약에 남긴다.
2. **네트워크 무호출 확인**: 이 step의 케이스 실행 중 외부로 나가는 요청이 없다는 근거를 남긴다(러너가 키 env를 지운다는 사실 + 서비스 코드의 키 없음 분기). 키가 남아 있으면 데모 폴백이 아니라 실 API를 때리므로, 러너 env 조립을 다시 확인한다.
3. **업로드 산출물 위치 확인**: 업로드 파일이 **임시 DATA_DIR 아래**에만 생기고 리포 `uploads/`가 변하지 않았는지 러너의 데이터 안전 단언으로 확인한다(이 step이 그 단언의 첫 실전 검증이다).
4. **vacuity 변이 2종**(각각 원복): (a) 3번 translate의 기대 상태를 200→500으로 바꿔 red 확인 (b) 5-(a)의 기대 토큰을 `invalid-file`→`invalid_file`로 바꿔 red 확인.
5. 6MB 페이로드 케이스의 실행 시간을 재서 요약에 기록한다(전체 스위트 시간에 미치는 영향이 크면 크기를 5MB 바로 위로 줄인다).
6. AC 전부 실행 · 결정성(연속 2회 green) · 리포트 누출 재확인(업로드 hex 파일명·경로가 마스킹됐는지).
7. `git status --porcelain` 증분 = `contract/cases/default/media-upload.contract.js` · `docs/api-contract/openapi.yaml` · `phases/67-port-p1-contract/index.json`.
8. 아키텍처 체크: 서버 코드 무수정 · `npm test` 1327 유지 · 리포 `uploads/` 무변.
9. index.json step9 status·summary 갱신.

## 금지사항

- 외부 API 키를 설정해 실 API를 호출하는 케이스를 만들지 마라. 이유: 네트워크·할당량·과금에 의존하는 비결정적 스위트가 되고, 폐쇄망 배치에서 무조건 실패한다(ADR-008 egress 규율과도 충돌).
- 업로드 파일을 리포 `uploads/`에 쓰지 마라. 이유: 실 데이터 오염이며 러너의 데이터 안전 단언이 실패한다.
- 5MB 경계값(정확히 5,242,880 바이트)을 탐색하지 마라. 이유: 실행 시간 대비 가치가 낮다(excluded (j)) — "여유 있게 초과 → too-large" 1건이면 계약이 잠긴다.
- 업로드된 파일을 지우려 하지 마라. 이유: 서버에 삭제 API가 없고, 임시 DATA_DIR는 러너가 통째로 정리한다.
- `translate` 응답이 4xx이기를 기대하는 케이스를 쓰지 마라(실측이 200이라면). 이유: 클라이언트(httpModel)는 상태코드를 해석하지 않고 JSON 본문만 읽는다 — 이 관용이 계약의 일부이며 Spring도 따라야 한다.
- 사진 등록에서 `registeredBy`를 클라이언트 값으로 기대하지 마라. 이유: 신원은 세션에서만 도출한다(ADR-004).
