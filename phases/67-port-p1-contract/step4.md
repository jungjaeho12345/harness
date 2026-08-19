# Step 4: articles-read

기사 **읽기 5 라우트**를 동결한다: `GET /api/articles/search`(#18) · `GET /api/articles`(#19) · `GET /api/articles/:id`(#20) · `GET /api/articles/:id/history`(#21) · `GET /api/articles/:id/history/:historyId`(#22). 이 step의 핵심 계약 축은 **응답 투영(`lockerSessionId`·`lockerClientId` 부재)** 과 **반복 쿼리 키 화이트리스트(`FILTER_KEYS` 실측 13키)** 다.

> **드리프트 주의**: 계획서 부록 A #19는 "필터 15키"라고 적었지만 `server/index.js` 378~384행의 `FILTER_KEYS`는 **13키**(`articleId, author, sender, status, excludeStatus, department, departments, createdAtFrom/To, sentAtFrom/To, distributedAtFrom/To`)다. **코드가 정본**이다 — 13키로 명세하고, 이 차이를 요약과 `docs/api-contract/README.md`의 "코드 ↔ 스펙 문서 차이" 절에 기록한다(계획서 파일은 고치지 마라).

## 읽어야 할 파일

- `phases/67-port-p1-contract/index.json` — decisions **(2)(5)(6)(9)(11)(16)(18)**
- `phases/67-port-p1-contract/step2.md` "작업 A" — `api`·`q`(반복 키 쿼리 빌더)·`fixtures.createArticle`·`record`
- `docs/api-contract/endpoints.json` — `articles-search`·`articles-list`·`articles-get`·`articles-history`·`articles-history-snapshot` 행
- `server/index.js` — `FILTER_KEYS`·`pickFilters`(378~390행), search/list/get 라우트(793~819행), history 2종(824~849행, 특히 `sendOnly` 판정과 `historyId` 정수 검사)
- `src/services/articleService.js` — `query`/`search`/`getById`/`queryHistory`/`getHistorySnapshot`의 반환 shape와 투영 호출 지점
- `src/services/contentsProjection.js` — 제거되는 2컬럼과 그 이유
- `src/services/historyMeta.js` — 이력 행 장식(`snapshotTitle`·`hasSnapshot`) 규칙
- `docs/SCHEMA.md` — Contents 컬럼 전수 · ArticleHistory 컬럼과 eventType 어휘
- `spikes/p0-spring/CONTRACT.md` "/api/articles 쿼리" 절 — 메뉴별 필터 조합(실측 정본은 코드)
- `test/contentsProjection.test.js` · `test/response-secrets.test.js` — 투영 계약의 기존 단언(예측 수립용)

## 배경

- 목록/검색 응답은 `{ ok:true, items:[...] }`이며 **페이징·총 개수 필드가 없다**(클라가 슬라이스한다). 이 "없음"도 계약이다.
- 배열 쿼리는 같은 키 반복이다(`?status=RDS&status=DDH`). Express가 배열로 파싱한다 — Spring은 이 형태를 반드시 받아야 한다. 콤마 구분(`?status=RDS,DDH`)이 어떻게 동작하는지도 **실측해서** 명세에 적는다(동작하면 그것도 계약, 안 되면 안 되는 것이 계약).
- `FILTER_KEYS` 밖의 쿼리 키는 **무시**된다(에러가 아니다). 이 관용도 계약이다.
- `GET /api/articles/:id`는 `{ok:true, article, contents}` 두 객체를 준다(본문은 `article.markupVersion`).
- 이력 목록은 본문 blob 없이 `hasSnapshot` 플래그만, 본문은 단건 스냅샷 라우트로만 온다. `historyId`가 정수가 아니면 404다.

## 작업

### A. `contract/cases/default/articles-read.contract.js`

픽스처: `fixtures.unique()`로 만든 고유 토큰을 제목에 박은 기사 2~3건을 **API로** 만든다(작성자·부서가 다른 조합 1건 포함). 절대 개수 단언 금지 — 항상 자기 토큰으로 좁혀서 단언한다.

1. **인가**: 5 라우트 전부 미인증 → 401 `unauthenticated`(각각 `record(..., 'unauthenticated')`).
2. **`GET /api/articles` 기본**: 세션(R) → 200 · `bodyKeys=['items','ok']` · 자기 픽스처가 items에 있다 · 행의 키 집합에 `lockerSessionId`·`lockerClientId`가 **없다** · 목록이 소비하는 키(`articleId,title,author,modifier,department,departmentCode,createdAt,editedAt,sentAt,distributedAt,status,lockYN`)가 있다(실측으로 확정).
3. **반복 키**: `?status=RDS&status=DDH` → 자기 픽스처(RDS)가 포함. 그 다음 `?status=DPS`만 → 자기 RDS 픽스처가 **빠진다**(필터가 실제로 동작한다는 음성 증거 — 이게 없으면 필터 케이스는 vacuous하다).
4. **`excludeStatus` · `department`/`departments` 반복 · `articleId` · `author` · 날짜 범위(`createdAtFrom`/`To`)**: 각 키가 최소 1회 양성/음성으로 관측되게 한다. **13키 전수**를 한 번에 넣는 케이스 1건(전부 무시되지 않고 200이 나온다) + 대표 키별 양성/음성 케이스로 구성한다. 코드에서 센 키 개수가 13이 아니면 **코드를 정본으로** 채택하고 차이를 요약에 남긴다.
5. **화이트리스트 밖 키 무시**: `?bogusKey=1&status=RDS` → `?status=RDS`와 같은 결과(자기 픽스처 기준으로 비교).
6. **`GET /api/articles/search`**: `?q=<고유 토큰>` → 자기 픽스처만 매칭. `?q=`(빈 값) 동작을 실측해 기록. 응답 shape는 목록과 동형인지 확인.
7. **`GET /api/articles/:id`**: 200 · `article`·`contents` 두 객체 · `contents`에 잠금 2컬럼 부재 · `article.markupVersion`이 저장한 본문과 같다. 없는 id → 404 `not-found`.
8. **`GET /api/articles/:id/history`**: 200 · `items` 배열 · 생성 직후에도 **404가 아니라 빈/1건 배열**(실측) · 행 키 집합(`eventType`·`action`·`fromStatus`·`toStatus`·`createdAt`·`snapshotTitle`·`hasSnapshot` 등 실측) · 본문(blob) 필드 부재. `?sendOnly=1`과 `?type=send` 두 표기 모두 동작하는지, `?sendOnly=0`/`false`가 어떻게 해석되는지 실측(코드 828~830행 판정 규칙이 계약이다).
9. **`GET /api/articles/:id/history/:historyId`**: 8에서 얻은 스냅샷 id로 200 · `item`에 본문 포함. **정수가 아닌 historyId** → 404. **다른 기사에 속한 historyId** → 404(articleId 스코프 강제 — 이 케이스가 없으면 권한 우회를 놓친다).
10. **역할 차이 확인**: R 세션과 D 세션이 같은 목록을 받는지(현행은 역할별 필터가 없다 — 실측해서 "역할 무관"이 계약임을 명시하거나 다르면 그 사실을 기록).

### B. 명세 반영 `docs/api-contract/openapi.yaml`

- 5 라우트의 paths 추가. `GET /api/articles`의 **13개**(실측) 쿼리 파라미터를 **전부** 선언하고, 배열 키는 `style: form, explode: true`(반복 키)로 명시한다. description에 "부록 A의 '15키'는 드리프트이며 코드가 정본"이라고 한 줄 남긴다.
- `ContentsRow` 스키마 description에 "`lockerSessionId`·`lockerClientId`는 어떤 응답에도 실리지 않는다(서버 투영 단일 지점)"를 명시한다.
- 페이징 필드가 없다는 사실을 응답 description에 적는다.

## Acceptance Criteria

```bash
npm run test:contract -- --profile default --files contract/cases/default/articles-read.contract.js
npm run test:contract
npm test
npm run lint
node scripts/contract-inventory-check.mjs
git status --porcelain
```

## 검증 절차

1. 예측 먼저: 5 라우트의 기대 상태·응답 키 집합·필터 동작을 코드에서 읽어 적고, 실행 후 차이를 요약에 남긴다(특히 `?sendOnly` 판정과 콤마 구분 쿼리의 실제 동작).
2. **투영 계약 강화 검사**: 응답 JSON 전체를 문자열로 훑어 `lockerSessionId`·`lockerClientId` 문자열이 **한 번도 등장하지 않는지** 확인하는 단언을 최소 1건 둔다(키 집합 비교만으로는 중첩 객체를 놓친다).
3. **vacuity 변이 2종**(각각 원복): (a) 3번 음성 케이스의 기대를 뒤집어(포함되어야 한다) red 확인, (b) 7번의 기대 상태 404→400 red 확인.
4. 픽스처 격리 확인: 같은 파일을 연속 2회 실행해도 green인지(고유 토큰이 매번 새로 생성되어 이전 실행 데이터와 충돌하지 않는지) 확인한다.
5. AC 전부 실행 · 리포트 누출 재확인(articleId가 리포트에 원문으로 남지 않았는지).
6. `git status --porcelain` 증분 = `contract/cases/default/articles-read.contract.js` · `docs/api-contract/openapi.yaml` · `phases/67-port-p1-contract/index.json`.
7. 아키텍처 체크: 서버 코드 무수정 · `npm test` 1327 유지 · 새 의존성 0.
8. index.json step4 status·summary 갱신.

## 금지사항

- 목록/검색 응답의 **절대 개수**를 단언하지 마라. 이유: 대상 서버(특히 68+ Spring)는 기존 데이터를 가진 상태로 돌 수 있고, 같은 스위트가 두 서버에서 같은 판정을 내려야 한다.
- 픽스처를 DB에 직접 넣지 마라. 이유: 계약 스위트는 대상 서버의 저장소를 모른다(MariaDB로 바뀌어도 그대로 돌아야 한다).
- 이력(history) 케이스에서 이력 행을 **삭제하거나 수정하려 하지 마라**. 이유: ArticleHistory는 append-only이며 DB 비파괴 원칙의 핵심이다.
- `?session=` 쿼리나 body의 role로 인가를 시도하는 케이스를 "성공 기대"로 쓰지 마라. 이유: 그 경로는 계약상 존재하지 않는다(있으면 안 되는 것이 계약).
- 다른 step이 openapi.yaml에 쓴 절을 수정하지 마라. 이유: 순차 append 규율(decisions (18)) — 오류를 발견하면 요약에 남기고 step12이 정리한다.
- 검색 케이스에서 한글 형태소·정렬 순서를 단언하지 마라. 이유: 그것은 DB(LIKE·collation) 동작이라 이관 후 달라질 수 있고, 이 phase가 동결하는 것은 **HTTP 계약**이다(정렬 계약이 실제로 코드에 있으면 그 사실만 명세에 기록).
