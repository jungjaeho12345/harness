# Step 5: fake-history-contract

## 목표

프론트 테스트 더블 `web/src/test/fakeModel.js`의 `queryHistory`를 **서버 응답 계약과 일치**시킨다: 목록에는 본문 blob(`markupVersion`)을 싣지 않고, 서버가 파생해 주는 `title`·`version`·`status`는 시드 값 그대로 통과시킨다. 계약 검증은 `web/src/model/contract.test.js`에 잠근다.

이 step은 **Model 계층(테스트 더블 + 계약 테스트)** 만 다룬다. View 결선은 step6이다.

## 읽어야 할 파일

- `docs/ARCHITECTURE.md` — 프론트 MVC와 "Model은 freeze된 계약, 테스트는 fakeModel 주입".
- `docs/ADR.md` ADR-003(주입형 Model 계약이 프론트/백 계약을 잇는 단일 통합 seam). **읽기 전용(무접촉)**.
- `web/src/test/fakeModel.js`
  - L157~163 `queryHistory(articleId, { sendOnly } = {})` — 현재: `histories[articleId]` 시드를 `{ ...h }`로 얕은 복사해 반환하고 `sendOnly`면 `action === 'send'` 필터.
  - L164~170 `getHistorySnapshot(articleId, historyId)` — **같은 시드 배열**에서 `id` 일치 항목을 복사해 `{ ok, item }`(본문 포함)으로 반환. 이 함수는 `markupVersion`이 필요하므로 **시드에서 blob을 지우면 안 된다**(목록 반환에서만 제외해야 한다).
- `web/src/model/httpModel.js` L198~206 — 실제 `queryHistory`는 `GET /api/articles/:id/history` 응답 JSON을 그대로 반환한다(가공 없음). 즉 **fake가 흉내 내야 하는 건 서버 응답 shape**이다.
- `web/src/model/contract.test.js` L119~140 — 기존 `queryHistory` 계약 케이스(시드 반환·sendOnly 필터·없는 기사 빈 배열). L142~ `getHistorySnapshot` 케이스(시드 `histories`에 `hasSnapshot: 1`과 `markupVersion`이 함께 들어 있다).
- `web/src/view/WriterPage.test.jsx` L5495~5510 부근 — 기사이력비교 시드: `{ id, articleId, eventType, action, actorUserId, createdAt, hasSnapshot: 1, markupVersion: OLD_BODY }`. **`hasSnapshot`으로 필터하고 본문은 `getHistorySnapshot`으로 따로 받는다** — 목록에서 blob을 빼도 이 테스트들은 영향받지 않아야 한다(실행으로 확인).
- `web/src/view/WriterPage.jsx` L690 `entries = r.items.filter((h) => h.hasSnapshot)` — 목록 소비처.
- step2 산출물 요약(서버 계약): `/history` item = `{ id, articleId, eventType, action, fromStatus, toStatus, actorUserId, createdAt, hasSnapshot, title, version, status }`, `markupVersion` 없음.

## 배경 (자기완결)

`fakeModel`은 서버 응답을 흉내 내는 seam이다. 지금은 `histories` 시드를 통째로 복사해 반환하므로 **실제 서버가 절대 주지 않는 `markupVersion`이 목록에 섞여 있다**. 이 상태로 step6의 뷰를 만들면 "fake에서는 있는데 실서버에는 없는 필드"에 뷰가 의존해도 테스트가 잡아내지 못한다(제목을 blob에서 직접 파싱하는 식의 잘못된 구현이 green으로 통과한다).

반대로 `title`/`version`/`status`는 **서버가 계산해 주는 값**이므로 fake는 계산하지 않고 시드 값을 그대로 통과시킨다(테스트가 원하는 값을 시드로 명시 — 파생 규칙 자체는 백엔드 테스트가 검증한다).

**알려진 잔여(이번 step 범위 밖)**: `sendOnly` 필터 조건이 서버(`eventType === 'status' && action === 'send'`)와 fake(`action === 'send'`)로 미세하게 다르다. 이번 phase는 이 드리프트를 건드리지 않는다 — 무관한 기존 테스트의 시드 가정을 흔들 수 있어 **별도 phase**에서 다룬다. 이 step에서 필터 조건을 "고치지" 마라.

## TDD — 테스트 먼저

`web/src/model/contract.test.js`에 케이스를 **추가**한다(기존 케이스 수정 금지).

1. **blob 미노출**: `histories` 시드에 `markupVersion`이 있어도 `queryHistory`의 item에는 `markupVersion` 키가 없다(`sendOnly` 경로 포함).
2. **파생 필드 통과**: 시드에 `title: '헤드라인', version: 3, status: 'DPS'`를 넣으면 그대로 반환된다.
3. **기존 필드 보존**: `id/articleId/eventType/action/fromStatus/toStatus/actorUserId/createdAt/hasSnapshot`가 그대로 온다.
4. **시드 불변**: `queryHistory` 호출 후에도 원본 시드 객체에 `markupVersion`이 남아 있고, 이어서 `getHistorySnapshot`이 본문을 정상 반환한다(같은 배열을 공유하므로 반드시 확인).
5. **회귀**: 기존 `sendOnly` 필터·없는 기사 빈 배열 계약이 그대로다(기존 케이스 무수정 green).

## 작업

`web/src/test/fakeModel.js`의 `queryHistory`만 수정한다.

1. 시드 행을 복사할 때 **`markupVersion`을 제외**한다(원본 시드는 변형하지 마라 — `getHistorySnapshot`이 같은 배열을 읽는다).
2. `title`·`version`·`status`는 시드에 있으면 그대로 통과시킨다(fake에서 계산·기본값 주입 금지 — 없으면 없는 대로 둔다. 뷰는 빈 값을 `'—'`로 처리한다).
3. `sendOnly` 필터 조건(`action === 'send'`)은 그대로 둔다.
4. 함수 위 주석을 갱신해 "서버 `/history`는 blob 없는 경량 목록이고 `title`/`version`/`status`는 서버 파생"이라는 사실을 남겨라(다음 사람이 fake에 blob을 되살리지 않게).
5. `getHistorySnapshot`·`histories` 시드 구조·다른 fake 메서드는 건드리지 마라.

## Acceptance Criteria

```bash
npm run test:web  # 실패 0 — step4 종료 시점 개수 + 이번 신규 케이스
npm run lint      # 통과
npm run build     # 통과
npm test          # 백엔드 무접촉 — 실패 0
```

**diff scope**: step을 시작하기 전에 `git status --porcelain`을 찍어 스냅샷으로 남겨라. 종료 시점의 `git status --porcelain`이 그 스냅샷과 **다른 부분**은 `web/src/test/fakeModel.js`, `web/src/model/contract.test.js` **2개뿐**이어야 한다(절대 목록 비교 금지 — 트리에 사용자 소유 미커밋 파일이 이미 있다).

## 검증 절차

1. 위 AC 커맨드를 실행한다. 특히 `web/src/view/WriterPage.test.jsx`(기사이력비교)와 `web/src/view/ListPage.test.jsx`(이력보기 3건)가 **무수정 green**인지 확인한다 — 깨진다면 목록에서 blob을 빼는 것 이상을 건드린 것이다.
2. 변이 검증 2종(확인 후 원복):
   - `markupVersion` 제외를 되돌리면 케이스 1이 red.
   - 시드 객체에서 `delete h.markupVersion`(원본 변형)으로 구현하면 케이스 4가 red(`getHistorySnapshot` 실패).
3. 아키텍처 체크리스트:
   - fake가 서버가 하지 않는 계산(제목 파싱·버전 매기기)을 하지 않는가?
   - `MODEL_KEYS`(`web/src/model/contract.js`)를 바꾸지 않았는가(새 메서드 없음 — 이번 phase는 기존 계약의 shape만 넓힌다)?
   - `httpModel.js`를 건드리지 않았는가(응답 그대로 반환이면 충분)?
4. `phases/56-history-view-columns/index.json`의 step5를 `completed` + `summary`로 갱신한다. summary에 fake 목록 반환 shape과 "blob 제외·파생 필드 pass-through" 원칙을 명시하라.

## 금지사항

- fake에서 제목·버전·상태를 계산하지 마라. 이유: 파생 규칙의 단일 출처는 백엔드(`src/services/historyMeta.js`)다 — fake가 자체 규칙을 가지면 두 규칙이 갈라져도 프론트 테스트는 계속 green이다.
- 시드 배열의 원본 객체를 변형(`delete`/대입)하지 마라. 이유: `getHistorySnapshot`이 같은 배열을 읽는다 — 기사이력비교 테스트가 본문을 못 받아 깨진다.
- `web/src/model/contract.js`의 `MODEL_KEYS`나 `httpModel.js`를 수정하지 마라. 이유: 새 메서드가 없고 응답 JSON을 그대로 반환하는 구조라 변경이 불필요하다 — 계약 키를 건드리면 `assertModel` 강제와 다른 소비처가 흔들린다.
- 다른 fake 메서드(queryArticles·saveArticle 등)를 정리·리팩터하지 마라. 이유: 이 phase 범위 밖이고, 프론트 전 테스트의 공유 더블이라 회귀 표면이 가장 넓다.
- `sendOnly` 필터 조건을 서버와 맞추려고 고치지 마라. 이유: 알려진 잔여 드리프트이며(배경 참조) 기존 시드 가정에 묶인 무관한 테스트를 흔든다 — 별도 phase 소관이다.
- `docs/news.md`·`docs/ADR.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라. 이유: 이번 phase 무접촉 대상이며, `docs/news.md`는 사용자 소유의 미커밋 편집분(이 phase의 입력 스펙)이다.
- `git add -A`/`git add .`로 스테이징하지 마라 — 반드시 이번 step이 만진 파일만 명시 경로로 `git add` 하라. 이유: 작업 트리에 사용자 소유 미커밋 파일(`docs/news.md` 등)이 이미 있어, 통짜 add는 그것들을 커밋에 끌어들인다.
- 미커밋 사용자 파일(`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`)을 `git restore`/`git checkout --`/`git stash`/`git clean`으로 되돌리거나 치우지 마라. 이유: 이 phase의 유일한 스펙 원문이 소실된다.
