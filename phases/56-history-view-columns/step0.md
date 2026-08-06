# Step 0: history-derive

## 목표

이력 로그에서 **제목·버전·상태를 파생하는 순수 모듈** `src/services/historyMeta.js`를 신설한다. DB/HTTP/Date/랜덤에 의존하지 않는 계산만 담는다. 결선(모델·서비스·라우트·프론트)은 이 step에서 하지 않는다.

왜 필요한가: `docs/news.md` 114~115행 "이력보기 … 수정시간/제목/수정자/상태/버전을 기본값으로 보여주고"의 5열 중 **제목·버전은 ArticleHistory에 저장 컬럼이 없고, 상태는 status 전이 행에만 있다**. 스키마를 늘리지 않고(DB 비파괴 — 이번 phase는 스키마 변경 0) 이미 append-only로 쌓여 있는 이력 로그 + 편집 스냅샷(`markupVersion`)에서 파생한다.

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 심볼명으로 재확인하라.

- `docs/news.md` 114~115행 — 이 phase의 유일한 스펙 원문. **읽기 전용(수정·스테이징 절대 금지 — 사용자 소유 미커밋 편집분)**.
- `docs/ARCHITECTURE.md` — 백엔드 계층(`controllers → services → models → db`), 의존성 주입, DB 비파괴 원칙.
- `docs/ADR.md` ADR-002(직접 SQL·멱등 마이그레이션)·ADR-006(얇은 transport + 계층형 도메인). **읽기 전용(무접촉)**.
- `src/db/schema.js` L59~69 — `ArticleHistory` 컬럼 전량: `id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, markupVersion`. **제목·버전 컬럼은 없다**. `markupVersion`은 편집(edit) 시점 본문 스냅샷이고 status 전이 행은 NULL이다.
- `src/models/articleHistoryModel.js` — `queryByArticle(articleId)`가 반환하는 행 shape(**id DESC = 최신순**): `{ id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, hasSnapshot }`. `hasSnapshot`은 `CASE WHEN markupVersion IS NOT NULL AND markupVersion != '' THEN 1 ELSE 0 END`(**숫자 1/0**)이다.
- `src/services/articleService.js`
  - L39~52 `hasEndMarker(article)` — 본문 blob 파싱 선례: `JSON.parse(raw)` 후 `doc.blocks`의 `b.text`를 `'\n'`으로 잇고, 파싱 실패 시 문자열 그대로 취급(레거시 평문 역호환).
  - L156 `record({ articleId, eventType: 'edit', actorUserId: fields.modifier, markupVersion: fields.markupVersion })` — **edit 이력의 스냅샷은 그 편집으로 저장되는 "새" 본문**이다(이전 본문이 아니다). 메타 전용 편집이면 `undefined` → NULL.
  - L216~222 / L283 — `eventType:'status'` 행(`action`=send/hold/kill/approveDelete/embargo…)에 `fromStatus`·`toStatus`가 실린다.
- `src/services/distributionService.js` L156 — `record({ articleId, eventType: 'distribute', action: kind, actorUserId })`. **배부 이력 행은 from/toStatus·스냅샷이 모두 없다**(ADR-008).
- `web/src/view/writerBody.js` L11~14 `bodyTitle(body)` — 프론트의 "본문 첫 줄 = 제목" 단일 출처: `blocksToText(deserialize(body))`의 첫 줄 `.trim()`. **이 step의 제목 파생은 이 규칙과 동형이어야 한다**(같은 본문에서 서로 다른 제목이 나오면 안 된다).
- `web/src/view/editorContent.js` L55~77 — `deserialize`/`blocksToText` 규칙: `{format:'yh-editor',version:1,blocks:[...]}` 문서, 블록 배열, 객체, 레거시 평문(줄 단위)까지 받아들이고, **텍스트 블록(`type:'text'`)만** 모아 `'\n'`으로 잇는다(임베드 제외).
- `test/articleHistoryService.test.js` — 이력 기록/조회의 기존 계약(특히 "목록은 blob 없이 `hasSnapshot`만", "create는 이력을 남기지 않는다")과 테스트 스타일(`node:test` + `assert/strict`).

## 배경 (자기완결) — 파생 규칙과 그 근거

`create`(최초 저장)는 이력 행을 남기지 않지만 **본문은 존재한다**. 이후 본문을 바꾼 편집만 스냅샷 행을 남긴다. 그래서:

- **버전(version)**: "그 이벤트 시점에 유효했던 본문 버전". 최초 저장 본문을 **v1**로 두고, 오래된 순으로 훑으며 스냅샷 보유 행을 만날 때마다 1 증가시킨다. **스냅샷 행 자신은 '증가 후' 값**을 갖는다(그 편집이 새 버전을 만든 것이므로 첫 스냅샷 행 = 2). 스냅샷 없는 행(상태 전이·배부·메타 전용 편집)은 직전까지의 값을 그대로 갖는다.
- **제목(title)**: 그 시점 유효 본문의 첫 줄. 스냅샷 보유 행은 자기 스냅샷에서, 나머지는 **직전(더 오래된) 스냅샷의 제목을 승계**한다. 승계할 스냅샷이 없는 구간(v1 구간)은 원칙적으로 `''`이다 — 알 수 없는 과거 값을 현재 값으로 채우면 사용자가 "그때 제목"으로 오독하기 때문이다(이력보기는 감사 성격 화면).
  - **예외 하나**: 스냅샷이 **한 건도 없는** 기사(create → send만 있는 흔한 경로)는 현재 `Article.markupVersion`이 **곧 v1 본문**이다(그 뒤로 본문이 바뀐 적이 없다는 뜻이므로). 이 경우에 한해 호출자가 넘긴 `v1Body`로 v1 구간 제목을 파생한다 — 추측이 아니라 동치다. 스냅샷이 1건이라도 있으면 현재 본문은 v1이 아니므로 `v1Body`는 **무시**한다.
  - 이 모듈은 스스로 DB를 조회하지 않는다 — `v1Body`는 **주입**받을 뿐이다(조회는 step2 서비스 책임).
- **상태(status)**: 그 시점 기사 상태. status 전이 행은 `toStatus`(전이 후). 그 외 행은 직전(더 오래된) 전이의 `toStatus`를 승계하고, 그보다도 앞선 행은 **이후(더 최신) 첫 전이의 `fromStatus`를 역승계**한다(전이 직전 상태는 그 전이 행이 알고 있다). 둘 다 없으면 `''`.

송고이력보기(`sendOnly`)는 서버에서 status/send 행만 남기고 필터하므로, **파생은 반드시 필터 이전의 전체 이력 위에서** 계산돼야 한다(그렇지 않으면 송고 행의 버전·제목이 전부 빈다). 그래서 파생을 프론트가 아니라 백엔드에 둔다 — 이 모듈은 그 계산의 순수 코어다(필터·조회 결선은 step2).

## TDD — 테스트 먼저

`test/historyMeta.test.js`를 신설하고 red → green으로 진행한다(`node:test` + `node:assert/strict`, 기존 백엔드 테스트 스타일).

**`snapshotTitle(markupVersion)`**
1. 블록 문서(`{"format":"yh-editor","version":1,"blocks":[{"type":"text","text":"헤드라인"},{"type":"text","text":"본문"}]}`) → `'헤드라인'`.
2. 첫 텍스트 블록이 공백뿐이면 `''`(trim 후 빈 문자열 — `bodyTitle` 동형).
3. 임베드 블록이 첫 원소여도 **텍스트 블록만** 세어 첫 텍스트 줄을 낸다.
4. 텍스트 블록의 `text`에 개행이 들어 있으면 **첫 줄만** 낸다.
5. 레거시 평문(JSON 아님) `'제목줄\n본문'` → `'제목줄'`.
6. `null`/`undefined`/`''`/`'{'`(깨진 JSON은 평문 취급) 입력에 throw하지 않는다.
7. 200자를 넘는 첫 줄은 **200자로 잘라** 반환한다(말줄임표 없음).

**`decorateHistoryRows(rows, snapshots, { v1Body } = {})`**
8. 입력이 `id DESC`(최신순)여도 **버전 번호는 오래된 순 기준**이다: `edit(스냅샷)`·`status/send`·`edit(스냅샷)` 순으로 쌓인 이력에서 오래된 행부터 `2, 2, 3`이 되고, 반환 배열의 **순서는 입력과 동일(최신순)** 이다.
9. 스냅샷이 하나도 없으면 모든 행의 `version`이 `1`이다.
10. 제목 승계: `edit(스냅샷 '가')` 이후의 status 행들은 `title === '가'`이고, 그보다 오래된 행은 `''`이다.
11. 상태 승계: `status(RDS→DPS)` 이후의 edit 행은 `status === 'DPS'`, 그보다 오래된 edit 행은 `status === 'RDS'`(역승계), 전이 행이 하나도 없으면 `''`.
12. 배부 행(`eventType:'distribute'`, from/toStatus 없음)도 승계 규칙을 그대로 받는다(전용 분기 없음).
13. **원본 불변**: 입력 배열·행 객체가 변형되지 않고(깊은 비교), 반환은 새 배열·새 객체다.
14. **markupVersion 미노출**: 반환 행 어디에도 `markupVersion` 키가 없다(`snapshots`로 blob을 넘겨도).
15. `snapshots`가 비어 있거나 `undefined`여도 throw하지 않고 `version`은 정확하다(증가 판정은 `hasSnapshot`만 본다) — `title`만 `''`로 남는다.
16. `hasSnapshot`이 `1`/`0`(숫자)로 오는 실제 모델 shape에서 정상 동작한다.
17. 빈 배열 입력 → 빈 배열 반환.
18. **순수성**: 같은 입력으로 두 번 호출하면 완전히 같은 결과다(시각·랜덤 비의존).

**`v1Body` 경계(스냅샷 0건 예외)**
19. **스냅샷 0건 + `v1Body` 제공**: 이력이 status 전이뿐(`hasSnapshot` 전부 falsy)이고 `{ v1Body: markup('첫 제목\n본문') }`을 넘기면, 모든 행의 `title === '첫 제목'`이고 `version === 1`이다.
20. **스냅샷 0건 + `v1Body` 미제공**: 같은 이력에 `v1Body`가 없으면 `title === ''`(기존 규칙 유지, throw 금지).
21. **스냅샷 1건 이상이면 `v1Body`는 무시된다**: 스냅샷 행이 있는 이력에 `v1Body`를 함께 넘겨도 v1 구간 행의 `title`은 여전히 `''`이고, 스냅샷 행·그 이후 행의 제목은 스냅샷에서 나온다(현재 본문 = 최신 버전이지 v1이 아니다).
22. `v1Body`가 빈 문자열/`null`/파싱 불가여도 throw 없이 `title === ''`이다.

## 작업

`src/services/historyMeta.js`를 신설한다. 시그니처만 고정하고 내부 구현은 재량이다.

```js
export const MAX_HISTORY_TITLE_LEN = 200;

// markupVersion 스냅샷 → 그 본문의 제목(첫 텍스트 줄, trim, 상한 절단). 파싱 불가/빈 값 → ''.
export function snapshotTitle(markupVersion) {}

// rows: articleHistoryModel.queryByArticle() 결과(id DESC 최신순)
// snapshots: [{ id, markupVersion }] 배열 하나로 고정(undefined/빈 배열 허용). 내부에서 Map으로 바꾸든 말든 재량.
// options.v1Body: 스냅샷이 '한 건도 없을 때만' 쓰는 v1 본문(= 현재 Article.markupVersion). 그 외에는 무시.
// 반환: 입력과 같은 길이·같은 순서의 새 배열. 각 원소 = 입력 행 얕은 복사 + { title, version, status }.
export function decorateHistoryRows(rows, snapshots, { v1Body } = {}) {}
```

규칙(반드시 지킬 것):
0. `snapshots`의 입력 타입은 **배열 하나로 고정**한다(호출자가 Map을 만들어 넘기게 하지 마라 — 계약이 둘이면 테스트도 둘이 된다). `undefined`/빈 배열은 허용한다.
1. **버전 증가 판정은 `hasSnapshot`만 본다**(snapshots 배열의 유무·내용과 무관) — 스냅샷 blob을 못 받는 호출 경로에서도 버전 번호가 결정적이어야 한다.
1-1. **`v1Body`는 `snapshots`가 비어 있을 때만** v1 구간 제목 파생에 쓴다(`snapshotTitle(v1Body)`). 스냅샷이 1건이라도 있으면 무시하라 — 그때의 현재 본문은 v1이 아니라 최신 버전이다. `v1Body`가 없거나 파싱 불가면 기존대로 `''`.
2. `version`은 **1-base 정수**이고 항상 값이 있다(`null` 금지). `title`·`status`는 문자열이고 값이 없으면 `''`(`null`/`undefined` 금지 — 표시 폴백은 뷰 책임).
3. 계산은 오래된 순으로 한 번, 상태 역승계를 위해 필요하면 한 번 더 훑는 정도로 끝낸다(정렬 재배열 금지 — **반환 순서는 입력 순서 그대로**). 입력이 이미 `id DESC`라는 전제를 주석에 명시하고, 순서 판단은 배열 위치가 아니라 `id`로 하라(같은 `createdAt`이 여러 건일 수 있다).
4. 순수·결정적: `Date`/`Date.now`/`Math.random`/`db`/`fetch`/`process.env` 사용 금지. 파일 상단에 이 사실을 한 줄 주석으로 남겨라(`historyDiff.js`·`embargoPolicy.js`와 같은 톤).
5. 본문 파싱은 `articleService.hasEndMarker`(L39~52)의 방어 패턴을 따르되 **텍스트 블록만** 센다(임베드의 `title` 같은 필드를 제목으로 오인하지 마라 — `blocksToText` 동형).
6. 이 모듈은 `src/` 안 어떤 모듈도 import하지 않는다(순수 코어). 프론트(`web/`)에서 import하지도 않는다.

## Acceptance Criteria

```bash
npm test          # 실패 0 — 백엔드 777(기준선) + 이번 step 신규 케이스
npm run lint      # 통과
```

**diff scope**: step을 시작하기 전에 `git status --porcelain`을 찍어 스냅샷으로 남겨라. 종료 시점의 `git status --porcelain`이 그 스냅샷과 **다른 부분**은 `src/services/historyMeta.js`, `test/historyMeta.test.js` **2개뿐**이어야 한다. (절대 목록 비교 금지 — 이 트리에는 이 phase가 건드리면 안 되는 사용자 소유 미커밋 파일이 이미 있다: `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 4종(각각 확인 후 원복):
   - 버전 증가를 "스냅샷 배열에 값이 있을 때"로 바꾸면 케이스 15가 red.
   - 상태 역승계를 지우면 케이스 11의 "그보다 오래된 edit 행" 단언만 red.
   - 제목 승계를 지우면 케이스 10만 red(버전·상태 케이스는 green 유지 — 세 파생이 서로 독립임을 확인).
   - `v1Body`를 스냅샷 유무와 무관하게 적용하도록 바꾸면 케이스 21이 red(예외가 "스냅샷 0건"에만 걸려 있는지 확인).
3. 아키텍처 체크리스트:
   - 이 모듈이 `db`/HTTP/`Date`/랜덤을 전혀 쓰지 않는가?
   - `src/models/**`·`src/services/articleService.js`·`server/**`·`web/**`를 건드리지 않았는가(결선은 step1·2·6 소관)?
   - DB 스키마·행 변경 0건인가?
4. `phases/56-history-view-columns/index.json`의 step0을 `completed` + `summary`로 갱신한다. summary에 (a) 두 export의 최종 시그니처, (b) 버전 1-base·증가 판정 기준, (c) 제목·상태 승계/역승계 규칙과 빈 값 표현(`''`), (d) 제목 200자 상한, (e) `v1Body` 예외 조건을 명시하라.

## 금지사항

- `docs/news.md`를 수정하거나 커밋에 포함하지 마라. 이유: 사용자 소유의 미커밋 편집분이며, 이 phase의 입력 스펙이다.
- `docs/ADR.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라. 이유: 이번 phase 무접촉 대상이다.
- `git add -A`/`git add .`로 스테이징하지 마라 — 반드시 이번 step이 만든 파일만 명시 경로로 `git add` 하라. 이유: 작업 트리에 사용자 소유 미커밋 파일(`docs/news.md` 등)이 이미 있어, 통짜 add는 그것들을 커밋에 끌어들인다.
- 미커밋 사용자 파일(`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`)을 `git restore`/`git checkout --`/`git stash`/`git clean`으로 되돌리거나 치우지 마라. 이유: 이 phase의 유일한 스펙 원문이 소실된다.
- 스키마에 `title`/`version` 컬럼을 추가하지 마라. 이유: 이 phase는 스키마 변경 0이 목표다 — 파생으로 충분하고, 저장 컬럼을 늘리면 과거 행 백필이라는 DB 쓰기 작업이 따라붙는다(DB 비파괴 원칙과 정면 충돌).
- 반환 행에 `markupVersion`을 실어 보내지 마라. 이유: `/history` 목록은 blob 없는 경량 계약이며(모델·서비스·테스트가 이미 그 계약을 강제한다), 이력 수만큼 본문 전체가 응답에 실리면 페이로드가 폭증한다.
- 제목 파생을 "첫 블록의 아무 문자열 필드"로 넓히지 마라. 이유: 임베드 블록의 `title`(사진 캡션·링크 텍스트)이 기사 제목으로 둔갑한다 — 프론트 `bodyTitle`은 텍스트 블록만 센다.
- 이 모듈에서 기사/본문을 **조회**하지 마라(모델·db 주입 금지). 이유: 순수 계산 모듈이어야 테스트가 결정적이다 — 필요한 본문은 `v1Body`로 주입받는다.
- `v1Body`를 스냅샷이 있는 이력에까지 적용하지 마라. 이유: 스냅샷이 1건이라도 있으면 현재 본문은 v1이 아니라 최신 버전이다 — 과거 행에 현재 제목이 붙어 사용자가 "그때 제목"으로 오독한다(스냅샷 0건일 때만 현재 본문 = v1 본문이라는 동치가 성립한다).
- 반환 배열을 재정렬하지 마라. 이유: 호출자(서비스·뷰)와 기존 테스트가 `id DESC` 최신순 계약에 묶여 있다.
