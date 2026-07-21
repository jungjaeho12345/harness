# Step 0: photo-backend — Photo 테이블 + 등록/검색 API (백엔드 수직 슬라이스)

## 배경 / 요구사항

도구>사진발행/DB등록(`tools.publishPhoto`)은 현재 에디터 메뉴에서 **비활성 placeholder**다(news.md L186 메뉴명 한 줄이 스펙 전부). 이 phase는 그 메뉴를 결선해 **사진 자산 등록 + 검색 재임베드 풀 루프**를 만든다:

1. 에디터에서 현재 기사 본문의 이미지 임베드 하나를 골라 캡션과 함께 **사진DB에 등록**한다.
2. 이미지 검색 패널에 내부 '사진DB' 소스를 추가해 **등록된 사진을 캡션으로 검색**하고, 결과를 다른 기사에 **재임베드**한다.

이 step은 그 루프의 **백엔드 절반**만 만든다 — 신규 `Photo` 테이블(additive·비파괴)과 등록/검색 API 2개(세션 게이트). 프론트 결선(계약·다이얼로그·검색패널)은 step1~3이 담당한다.

이 step은 하나의 백엔드 수직 슬라이스(schema → model → service → controller → route)이며 단일 계약(사진 등록 + 캡션 검색 API)으로 함께 검증한다. **오직 `server/` + `src/` + `test/`만 다룬다. `web/`(프론트)는 절대 건드리지 않는다.**

### 확정된 설계 결정 (그대로 구현)

- **Photo 테이블은 신규·additive다.** 기존 4+1개 테이블(User/Article/Contents/ArticleHistory/ReceiverConfig)과 기존 데이터는 무변경. `createSchema`의 기존 멱등 마이그레이션(`CREATE TABLE IF NOT EXISTS` + 누락 컬럼 `ALTER ADD COLUMN`)이 신규 테이블을 자동·비파괴로 만든다 — **별도 마이그레이션 코드 금지.**
- **컬럼 설계**(SCHEMA.md 규약: id=INTEGER PK ROWID alias 자동증가, 나머지 VARCHAR, FK/보조 인덱스 없음 — ReceiverConfig와 동형):
  - `id` `INTEGER PRIMARY KEY` — 자동 증가(insert에서 제외).
  - `src` `VARCHAR` — 이미지 참조(업로드 경로 `/uploads/...` 또는 외부 `https://` URL). **등록 시 서버가 검증**한다(아래).
  - `caption` `VARCHAR` — 캡션(검색 대상 텍스트, 재임베드 시 이미지 alt로 쓰인다).
  - `sourceArticleId` `VARCHAR` — 출처 기사아이디(등록 시점 편집 중이던 기사; 미저장 신규 기사면 빈 문자열 — best-effort 출처 기록).
  - `registeredBy` `VARCHAR` — 등록자 userId. **세션에서만 도출**한다(ADR-004 — `req.body`의 값은 신뢰하지 않는다).
  - `createdAt` `VARCHAR` — 등록 시각(ISO-8601 UTC 문자열, 서버 stamp).
- **등록 src 검증(보안 — 발행 HTML로 흐르는 경로).** 등록된 사진은 검색 후 다른 기사에 이미지 임베드로 재삽입되고 상세보기(articleDetail)의 발행 HTML까지 흐른다. 위험 스킴이 DB에 저장되면 재임베드 시점에 렌더 싱크로 흐른다. 그래서 **등록 시 서버가 src를 거부 기반으로 검증**한다:
  - 허용: `/uploads/`로 시작하는 상대경로(`..` 세그먼트 없음) **또는** `https://`(authority 포함) URL.
  - 거부: 빈 값, `javascript:`/`data:`/`http:` 등 그 외 스킴, 제어문자·공백, 백슬래시, 프로토콜상대(`//host`), `..` traversal → `{ ok:false, reason:'invalid-src' }`(라우트가 400).
  - **이 규칙은 이미 `src/services/articleService.js`의 `sanitizeFileRef`(L60~73)가 첨부/자료 파일 참조에 쓰는 것과 동일하다.** 규칙을 새로 재현하지 말고 **그 함수를 단일 출처로 재사용**한다(export하거나 작은 순수 모듈로 추출). 이유: 규칙을 두 번째로 재현하면 미묘한 발산으로 우회 벡터가 생긴다(phase 19에서 정확히 이 유형의 XSS가 났다 — 단일 출처가 안전).
  - `data:` 를 거부하는 이유: (a) 발행 HTML 렌더 게이트(`isAllowedImageSrc`)는 `data:image/`를 허용하지만, Photo.src로 base64 데이터 URL을 저장하면 재임베드마다 blob이 복제되어 DB가 폭증한다(phase 20이 본문 base64를 업로드 경로로 옮긴 것과 같은 교훈). (b) `sanitizeFileRef` 허용집합(`/uploads/`·`https://`)은 렌더 게이트 `isAllowedImageSrc`의 부분집합이라, 서버가 통과시킨 src는 재임베드 시 항상 렌더된다(정합).
- **인가: 로그인만 요구하는 세션 게이트**(역할 R/D/Z 무관). 이유: 이미지/글기사 검색(`/api/media/search`·`/api/articles/search`)이 세션만 요구하는 것과 동형 — 사진 등록/검색은 작성 흐름의 일부라 로그인 사용자면 누구나 쓸 수 있다. 역할 게이트를 붙이지 않는다.
- **단일 테이블 insert라 트랜잭션 불필요.** Article+Contents 동시 변경(articleModel.tx)과 달리 Photo는 한 테이블만 건드린다.
- **행 삭제/수정 없음.** 사진 삭제는 이 phase 범위 밖(CLAUDE.md "DB 내용 절대 삭제 금지"). `photoModel`에 remove/update/delete 메서드를 만들지 않는다(append-only + 검색 read).

## 읽어야 할 파일

먼저 아래를 읽고 백엔드 MVC(controllers→services→models→db)·얇은 transport·DB 비파괴·세션 인가 의도를 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 백엔드 계층 분리(controllers→services→models→db), 얇은 transport, 의존성 주입, DB 비파괴, 명령어(`npm run lint`/`npm test`).
- `/docs/ADR.md` — ADR-002(node:sqlite 직접 SQL·멱등 마이그레이션·행 삭제 금지), ADR-004(세션 인가 — role은 세션에서만 도출), ADR-006(얇은 transport + 계층형 도메인·위임만).
- `/docs/SCHEMA.md` — 테이블 규약(VARCHAR·INTEGER PK ROWID alias·FK/보조 인덱스 없음·멱등 마이그레이션·비파괴), ReceiverConfig 컬럼(신규 INTEGER-PK 테이블 선례).
- `/docs/news.md` L186(도구 메뉴 '사진발행/DB등록'), L165(검색 결과 임베딩), L237(`/api/media/search`) — 사진 검색은 그 형제 계약이다.
- `src/db/schema.js` — **결선 지점**: `SCHEMA` 객체(L7~84)와 `createSchema`(L87~104). `SCHEMA`에 테이블 배열을 하나 추가하면 `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info`로 누락 컬럼만 `ALTER ADD COLUMN`한다(기존 DB에 자동·멱등·비파괴). **이 패턴 그대로 — 별도 마이그레이션 코드 금지.** `ReceiverConfig` 배열(L70~83)이 INTEGER-PK 테이블의 형태 참고.
- `src/models/receiverConfigModel.js` — **모델 템플릿**: `insert`가 present-only 컬럼으로 INSERT 후 `.lastInsertRowid`를 반환(L25~31), `query`가 `SELECT ... ORDER BY id`(L12~23). `remove`(DELETE, L34~36)는 **Photo에는 만들지 않는다**(설정 행 삭제는 rcv 전용 예외).
- `src/models/articleHistoryModel.js` — present-only `insertInto` 헬퍼(L11~17)와 `undefined` 키 제외 패턴(insert가 정의된 컬럼만 넣어 나머지는 NULL). 화이트리스트 컬럼 배열(`HISTORY_COLS`, L6~9)로 컬럼을 통제하는 방식.
- `src/services/articleService.js` — **재사용 지점**: `sanitizeFileRef`(L60~73, 거부 기반 src 정규화 — `/uploads/` 상대 또는 `https://`만 허용, `..`/제어문자/백슬래시/프로토콜상대/그 외 스킴 거부), `nowISO`(L27~29). `pick`(L21~25) 패턴. **이 파일의 `sanitizeFileRef`를 photoService에서 재사용**한다(단일 출처).
- `src/controllers/index.js` — **결선 지점**: 모델 결선(L29~33), 서비스 결선(L38~45), 도메인 객체(`article`/`media` 등, L61~102)와 `return { auth, user, article, media, ... }`(L102). 여기에 `photoModel`/`photoService`/`photo` 도메인을 추가한다.
- `server/index.js` — **결선 지점**: 세션 게이트 헬퍼 `sessionOf(req)`(L300~303)와 `UNAUTH`(L80)·`fail`·`STATUS_BY_REASON`(L84~100). 세션만 요구하는 읽기 라우트 `GET /api/articles/search`(L409~415)·`GET /api/media/search`(L608~615), 세션 게이트 쓰기 라우트 `POST /api/upload`(L625~657)가 형태 참고. `me.userId`로 신원 도출(POST /api/articles L479 참고).
- `test/upload.test.js`(L1~70) — **라우트 테스트 하네스**: `start()`가 in-memory DB + `createSchema` + `createControllers` + `createApp`로 앱을 띄우고, `seedUser`/`login`/`api(base, method, path, {sid, body})`로 인증 요청을 보낸다. Photo 라우트 테스트를 이 하네스로 작성한다.
- `test/schema.test.js` — 스키마/마이그레이션 테스트 컨벤션(`columns(db, 'Table')` 헬퍼, 구버전 테이블 + 기존 행 → `createSchema` 후 additive 반영·기존 행 보존). Photo 테이블 생성 + additive 마이그레이션 단언을 여기에 추가한다.
- `test/articleHistoryModel.test.js`, `test/receiverConfigModel.test.js` — 모델 단위 테스트 컨벤션(in-memory db + createSchema + insert/query 단언).
- `test/articleHistoryService.test.js`, `test/mediaSearch.test.js` — 서비스 단위 테스트 컨벤션(모델 주입·계약 단언).

이전 step에서 만들어진 코드는 없다(이 phase의 첫 step). 위 파일들을 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD로 진행한다(`node --test`). **테스트를 먼저 추가**하고 통과하는 최소 구현을 만든다.

### 1. 스키마 — `src/db/schema.js`
- `SCHEMA` 객체에 `Photo` 배열을 추가한다(ReceiverConfig 뒤). 컬럼은 위 "확정된 설계 결정"의 6개:
  ```
  Photo: [
    ['id', 'INTEGER PRIMARY KEY'],
    ['src', 'VARCHAR'],
    ['caption', 'VARCHAR'],
    ['sourceArticleId', 'VARCHAR'],
    ['registeredBy', 'VARCHAR'],
    ['createdAt', 'VARCHAR'],
  ],
  ```
- `createSchema`/`backfillEmptyDepartments`는 **수정하지 않는다** — 기존 로직이 신규 테이블을 additive·멱등·비파괴로 만든다.

### 2. 모델 — `src/models/photoModel.js` (신규)
- `createPhotoModel(db)` → `{ insert, searchByCaption }`.
- 컬럼 화이트리스트 `PHOTO_COLS = ['src', 'caption', 'sourceArticleId', 'registeredBy', 'createdAt']`(id 제외 — 자동 증가).
- `insert(record)` — present-only INSERT(정의된 컬럼만). **삽입된 행 id를 반환**한다(`.lastInsertRowid`를 Number로 — receiverConfigModel.insert 선례). 입력 컬럼이 하나도 없으면 throw(articleHistoryModel/receiverConfigModel과 동일).
- `searchByCaption(q)` — `SELECT * FROM Photo WHERE caption LIKE ? ORDER BY id DESC`, 파라미터 `%${q}%`. 최신 등록이 위에 오도록 `id DESC`.
- **remove/update/delete 메서드를 만들지 마라**(DB 비파괴·append-only).

### 3. 서비스 — `src/services/photoService.js` (신규)
- `createPhotoService({ photoModel })` → `{ register, search }`.
- `register(dto = {}, { userId } = {})`:
  1. **src 검증**: `sanitizeFileRef(dto.src)`(articleService에서 재사용) 결과가 빈 문자열이면(빈 값 또는 부적격 스킴) `{ ok:false, reason:'invalid-src' }` 반환.
  2. 유효하면 정규화된 src로 insert할 record를 만든다: `{ src: <정규화값>, caption: dto.caption ?? '', sourceArticleId: dto.sourceArticleId ?? '', registeredBy: userId ?? null, createdAt: nowISO() }`.
  3. `photoModel.insert(record)`로 id를 얻어 `{ ok:true, id }` 반환.
  - **`registeredBy`는 인자 `userId`(세션 도출)로만 채운다** — `dto.registeredBy`가 있어도 무시한다(ADR-004 — 클라이언트 신뢰 금지).
- `search(q = '')` — `photoModel.searchByCaption(q)` 결과 행 배열을 그대로 반환(도메인 규칙 없음, 얇은 위임).
- `sanitizeFileRef`는 articleService.js에서 가져온다. articleService의 기존 동작은 **바꾸지 마라**(export만 추가하거나 순수 모듈로 추출 — 기존 `sanitizeFileRefFields`/save 경로 무변경). 재현(복붙)하지 말고 단일 출처를 공유한다. **권장: 작은 순수 모듈로 추출**(예: services 하위 공용 헬퍼) — photoService가 articleService를 정적 import하면 서비스 간 결합이 생겨 기존 DI 관례와 어긋난다(추출이 계층 정합).

### 4. 컨트롤러 — `src/controllers/index.js`
- `import { createPhotoModel } from '../models/photoModel.js';` / `import { createPhotoService } from '../services/photoService.js';`
- 모델·서비스 결선: `const photoModel = createPhotoModel(db);` / `const photoService = createPhotoService({ photoModel });`
- `photo` 도메인 추가(위임만 — 로직 재구현 금지, ADR-006):
  ```js
  const photo = {
    register: (dto, opts) => photoService.register(dto, opts),
    search: (q) => photoService.search(q),
  };
  ```
- `return { auth, user, article, media, translation, receiverConfig, collection, photo };`

### 5. 라우트 — `server/index.js`
- `POST /api/photos`(세션 게이트, 쓰기) — `GET /api/media/search`(L608) 근처 또는 `POST /api/upload`(L625) 뒤에 추가:
  ```js
  app.post('/api/photos', (req, res, next) => {
    // 세션 게이트(로그인만 — 이미지/글기사 검색과 동형, 역할 게이트 없음).
    // 신원(registeredBy)은 세션에서만 도출한다(ADR-004). body.registeredBy는 신뢰하지 않는다.
    ... const { me } = sessionOf(req); if (!me) return res.status(401).json(UNAUTH);
    ... const { src, caption, sourceArticleId } = req.body ?? {};
    ... const r = controllers.photo.register({ src, caption, sourceArticleId }, { userId: me.userId });
    ... if (!r.ok) return res.status(400).json(r);  // invalid-src → 400
    ... return res.json(r);  // { ok, id }
  });
  ```
  - 전역 JSON 파서가 이 라우트를 처리한다(본문은 작다 — src/caption 문자열). `/api/upload`처럼 큰 limit 파서를 붙일 필요 없다(base64를 받지 않는다).
- `GET /api/photos/search`(세션 게이트, 읽기):
  ```js
  app.get('/api/photos/search', (req, res, next) => {
    ... const { me } = sessionOf(req); if (!me) return res.status(401).json(UNAUTH);
    ... return res.json({ ok: true, items: controllers.photo.search(req.query.q ?? '') });
  });
  ```
  - **라우트 순서**: `/api/photos`(POST)와 `/api/photos/search`(GET)는 메서드·경로가 달라 `/api/articles/:id` 같은 `:id` 충돌이 없다. 다만 `GET /api/photos/search`는 향후 `GET /api/photos/:id` 같은 라우트가 생기면 그 앞에 둔다(현재는 무관 — `:id` 라우트 없음).
- (선택) `STATUS_BY_REASON`에 `'invalid-src': 400`을 추가해도 되지만, 위처럼 라우트에서 명시적 `res.status(400)`로 반환하면 매핑 없이도 된다. 둘 중 하나만.
- 두 라우트 모두 형제 라우트와 동형으로 핸들러 본문을 `try { … } catch (e) { next(e); }`로 감싼다. 이유: 전역 에러핸들러가 `next(e)`에 의존한다 — 래퍼 없는 동기 throw는 미처리로 샌다(위 스케치의 `...`는 축약 표기이며 try/catch 생략 허가가 아니다).

### 6. 테스트 (먼저 작성)
- `test/schema.test.js`:
  - `createSchema` 후 `Photo` 테이블이 존재하고 컬럼(id/src/caption/sourceArticleId/registeredBy/createdAt)이 모두 있음을 단언(`columns(db,'Photo')`).
  - Photo가 없는 구버전 DB + 기존 다른 테이블 행 → `createSchema` 후 Photo가 additive로 생기고 **기존 행이 보존됨**을 단언(기존 마이그레이션 테스트 패턴 재사용).
- `test/photoModel.test.js`(신규):
  - `insert`가 새 id를 반환하고, 이후 `searchByCaption`으로 그 행이 조회됨을 단언(present-only insert).
  - `searchByCaption`가 캡션 부분일치(LIKE)로 필터하고, 매칭 없으면 빈 배열, 정렬이 `id DESC`(최신 우선)임을 단언.
  - **remove/delete/update 메서드가 없음**을 단언(예: `typeof model.remove === 'undefined'` — append-only·DB 비파괴 가드).
- `test/photoService.test.js`(신규):
  - `register`가 유효 src(`/uploads/x.png`, `https://cdn/x.png`)를 받아 `{ ok:true, id }`를 반환하고, `registeredBy`가 **인자 userId**로 저장됨을 단언(모델 스파이/조회로 확인). `dto.registeredBy`를 보내도 무시되고 세션 userId가 이김을 단언.
  - `register`가 부적격 src(`javascript:alert(1)`, `data:image/png;base64,AAA`, `http://x/y.png`, 빈 문자열)에 `{ ok:false, reason:'invalid-src' }`를 반환하고 **insert가 호출되지 않음**을 단언.
  - `createdAt`가 ISO 문자열로 stamp됨(대략 — 존재·형식)을 단언.
  - `search`가 캡션 매칭 행을 반환함을 단언.
- `test/photos-api.test.js`(신규 — `test/upload.test.js` 하네스 복제):
  - `POST /api/photos` 미인증 → 401 unauthenticated.
  - 인증 후 유효 src 등록 → 200 `{ ok, id }`, 그리고 `GET /api/photos/search?q=<캡션>`로 방금 등록한 사진이 조회됨(풀 루프).
  - `registeredBy`가 **세션 사용자**로 저장됨(body에 다른 registeredBy를 실어도 세션이 이김)을 검색 결과로 단언.
  - 부적격 src(`javascript:` 등) 등록 → 400 invalid-src, 그리고 검색 결과에 없음.
  - `GET /api/photos/search` 미인증 → 401.
- (선택) `test/controllers.test.js`에 `controllers.photo`가 존재하고 register/search 함수를 노출함을 단언.

### 7. 문서 — `docs/SCHEMA.md` additive 갱신
- Photo 테이블 섹션을 기존 테이블 섹션들(예: ReceiverConfig)과 동형 포맷으로 **추가**하고, 상단 "테이블은 … N개이다" 서술의 개수를 보정한다(ReceiverConfig 추가 선례가 섹션+개수를 함께 갱신했다). 문서만 추가/보정하는 doc-only 비파괴 변경 — 기존 테이블 서술은 건드리지 마라.

```bash
npm run lint          # ESLint 클린
npm run build         # vite 빌드(웹 번들 — 백엔드 변경이 프론트를 깨지 않음 확인)
npm run test:web      # 웹 테스트(회귀 없음 — 이 step은 web 미변경이라 전부 그대로 통과)
npm test              # 백엔드(node --test) — 신규 schema/photoModel/photoService/photos-api 포함 전체 통과
```

기대 단언(요약):
- `Photo` 테이블이 additive로 생성되고, 구버전 DB 마이그레이션 시 기존 행이 보존된다.
- `photoModel.insert`가 새 id를 반환하고 `searchByCaption`가 캡션 LIKE로 조회한다(remove/update 없음).
- `photoService.register`가 유효 src만 등록하고 부적격 src는 `invalid-src`로 거부하며, `registeredBy`는 세션 userId로만 stamp된다.
- `POST /api/photos`(세션 게이트)가 등록하고 `GET /api/photos/search`(세션 게이트)가 조회하며, 미인증은 401이다.
- 기존 백엔드·웹 테스트가 **모두 그대로 통과**한다(회귀 없음).

## 검증 절차

1. 위 AC 커맨드를 실행한다(Windows에서 인코딩 이슈 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트:
   - additive 마이그레이션만(SCHEMA 배열 한 덩어리)·행 삭제/UPDATE 없음·단일 테이블 insert(트랜잭션 불필요).
   - 세션 게이트(로그인만·역할 게이트 없음)·신원은 세션에서만 도출(ADR-004).
   - src 검증은 `sanitizeFileRef` 단일 출처 재사용(규칙 재현 금지).
   - 컨트롤러는 위임만(로직 재구현 없음, ADR-006).
   - `web/` 미변경.
3. 결과에 따라 `phases/41-photo-publish-db/index.json`의 step 0을 갱신(completed+summary / error+error_message / blocked+blocked_reason).

## 금지사항

- 상위 `phases/index.json`(top-level 트래커)을 수정하지 마라. 이유: 오케스트레이터/execute.py 관리 파일 — step은 `phases/41-photo-publish-db/index.json`(로컬)만 갱신한다.

- Photo 행을 삭제/수정하는 코드(remove/update/delete)를 만들지 마라. 이유: DB 비파괴·append-only. 사진 삭제는 이 phase 범위 밖(CLAUDE.md).
- 기존 테이블(User/Article/Contents/ArticleHistory/ReceiverConfig)이나 그 데이터를 건드리지 마라. 이유: 이 step은 신규 테이블 additive만.
- `registeredBy`를 `req.body`에서 받지 마라. 이유: 신뢰 경계는 서버 — 등록자는 검증된 세션(me.userId)에서만 도출한다(ADR-004).
- src 검증 규칙을 photoService에 새로 재현(복붙)하지 마라. 이유: `sanitizeFileRef`와 미묘히 발산하면 우회 벡터가 생긴다(phase 19 XSS 유형) — 단일 출처를 공유한다.
- `data:` src를 허용하지 마라. 이유: (1) 재임베드마다 base64 blob 복제로 DB 폭증(phase 20 교훈), (2) 허용집합을 렌더 게이트(`isAllowedImageSrc`)의 부분집합으로 유지해 정합.
- Photo 등록/검색에 역할(R/D/Z) 게이트를 붙이지 마라. 이유: 이미지/글기사 검색과 동형 — 세션만 요구한다.
- `web/`(프론트 계약·다이얼로그·검색패널)를 이 step에서 건드리지 마라. 이유: 이 step은 백엔드 계약만 — 프론트 결선은 step1~3.
- 기존 테스트를 깨뜨리지 마라. `sanitizeFileRef` export/추출은 순수 리팩터로 하고 기존 save 경로 동작을 바꾸지 마라.
