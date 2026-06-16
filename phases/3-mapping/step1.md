# Step 1: mapping-button

매핑 모드(`mode:'mapping'`)일 때 작성 페이지 액션바에 **송고/보류/KILL이 아니라 '저장' 버튼만** 표시되도록 버튼 규칙을 정한다. 이 step은 **순수 함수 한 모듈(`web/src/view/writerButtons.js`)** 만 다룬다. 실제 버튼 클릭→저장 결선(WriterPage)은 step3, 진입 결선/메뉴 활성화는 step2/step4다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/news.md` — line 139~145(기사작성 워크플로우: 송고/보류/KILL 버튼·확인창·제목/"(끝)" 가드), line 199~203(편집 진입 매핑 규칙).
- `/web/src/view/writerButtons.js` — **이 step에서 수정할 파일.** 핵심 이해 포인트:
  - `submitButtons({ mode, status, role, articleId })` 순수 함수 — 진입 컨텍스트(mode)·상태(status)·권한(role)·신규여부(articleId)로 표시할 액션 키 배열을 반환한다. 표/규칙에 없는 조합은 빈 배열.
  - 현재 진리표: 신규(`!articleId || mode==='new'`)→송고·보류 / `revise`·`portalRevise`→D만 송고·보류 / `edit` RDS→송고·보류·KILL / `edit` DDH→D·Z 송고·KILL.
  - `SUBMIT_LABELS = { send:'송고', hold:'보류', kill:'KILL' }` — 키→라벨 맵.
  - `ORDER = ['send','hold','kill']`, `order(set)`는 ORDER 순으로 거른다.
- `/web/src/view/writerButtons.test.js` — 이 함수의 단위 테스트(진리표 케이스). 이 파일에 매핑 케이스를 추가한다.
- `/web/src/controller/useWriteController.js` — step 0에서 추가한 `mode:'mapping'`과 저장 콜백(예: `saveMapping`)을 확인하라(매핑 탭은 `articleId`가 있고 `status`가 원본 상태). 단, **이 파일은 수정하지 마라**(읽기만).

이전에 만들어진 코드를 꼼꼼히 읽고 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD: **테스트를 먼저 작성**한 뒤 통과하는 구현을 작성한다.

핵심 결정(이 phase에서 확정한 매핑 저장 흐름 — 반드시 따른다):
- 매핑은 본문 텍스트·생애주기를 건드리지 않는 **임베드 추가 PUT**이다. 따라서 매핑 탭의 액션바에는 송고/보류/KILL을 **표시하지 않고**, '저장'(save) 버튼 **하나만** 표시한다. 송고 흐름("(끝)" 검증·제목 검증·상태 전이)과 완전히 분리된다.

구현(시그니처는 재량, 기존 패턴 재사용):
- `SUBMIT_LABELS`에 `save: '저장'` 라벨을 추가한다(기존 send/hold/kill 라벨은 그대로 둔다).
- `submitButtons({ mode, ... })`에서 `mode === 'mapping'`이면 **다른 모든 분기보다 먼저** `['save']`를 반환하도록 매핑 분기를 맨 앞에 둔다. 이유: 매핑 탭은 `articleId`가 있고 `status`가 원본 상태(예: DPS)라, 매핑 분기를 뒤에 두면 기존 edit/revise 규칙에 먼저 걸려 송고/보류 버튼이 떠버린다. 매핑 분기를 **함수 진입 직후 최우선**으로 처리하라.
- `'save'`는 `ORDER`/`order()` 거름망을 거치지 않아도 된다(단일 키). `order(['save'])`를 쓰려면 `ORDER`에 `'save'`를 포함해야 하므로, 매핑은 그냥 `['save']`를 직접 반환하는 편이 단순하다(재량).

테스트(`writerButtons.test.js`에 케이스 추가):
- `submitButtons({ mode:'mapping', articleId:'AKR...', status:'DPS', role:'D' })` → `['save']`.
- `mode:'mapping'`일 때 status/role을 RDS/DDH/R/Z 등으로 바꿔도 항상 `['save']`만 나오는지(매핑 분기가 최우선이라 다른 규칙에 안 걸림).
- `SUBMIT_LABELS.save === '저장'`.
- 기존 진리표(신규·revise·portalRevise·edit RDS·edit DDH)가 무회귀인지(매핑 분기 추가가 기존 케이스에 영향 없음).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. 위 AC를 실행한다. 기존 web 테스트 + 신규 테스트가 모두 통과해야 한다(무회귀).
2. 아키텍처 체크리스트:
   - 매핑 mode가 송고/보류/KILL이 아니라 '저장' 단일 버튼만 반환하는가?
   - 매핑 분기가 최우선이라 원본 status(DPS 등)·role에 관계없이 항상 `['save']`인가?
   - 기존 진리표가 무회귀인가?
3. `phases/3-mapping/index.json`의 step 1을 업데이트(completed + summary: 추가한 'save' 라벨·매핑 분기 위치(최우선)·반환값). 실패 시 error, 개입 필요 시 blocked.

## 금지사항

- 매핑 탭에 송고/보류/KILL 버튼을 표시하지 마라. 이유: 매핑은 상태 전이가 아니라 임베드 추가 PUT이다. 송고 버튼이 뜨면 사용자가 의도치 않게 생애주기 전이를 일으킨다.
- 매핑 분기를 기존 edit/revise 분기 뒤에 두지 마라. 이유: 매핑 탭은 articleId·status(예: DPS)를 가지므로 기존 규칙에 먼저 걸려 잘못된 버튼이 표시된다 — 함수 진입 직후 최우선으로 처리하라.
- `useWriteController.js`/`WriterPage.jsx`를 수정하지 마라. 이유: 이 step은 순수 버튼 규칙 함수만 다룬다 — 클릭 결선은 step3 소관이다.
- 기존 테스트를 깨뜨리지 마라.
