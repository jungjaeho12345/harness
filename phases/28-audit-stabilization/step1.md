# Step 1: title-derivation-central

기사 제목은 **본문 첫 줄**에서 파생된다. 그런데 `WriterPage.jsx`에서 제목(`title` 필드)을 재동기화하는 경로는 타이핑(`onTextChange`) **하나뿐**이고, 타이핑 외 본문변경 경로(약어변환·간체번체 변환·모두 바꾸기·바꾸기·대소문자 변환·줄삭제·(끝)/(계속)삽입·약물/날짜 삽입 등)는 `updateField('body', ...)`만 호출하고 `title`을 갱신하지 않는다. 그 결과 본문 첫 줄을 바꾼 뒤 저장하면 **DB에 옛 제목이 남는(제목 stale, major)** 결함이 생긴다. 제목 파생을 **중앙 경로 하나로 통일**해 모든 본문변경 경로가 공유하게 한다.

> 후속 phase 29(편집 메뉴)가 이 중앙 경로를 재사용할 예정이다. **재사용 가능한 단일 choke point** 형태로 만들어라.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — 프로젝트 규칙(DB 비파괴·TDD·conventional commits).
- `/docs/ARCHITECTURE.md` — 프론트 MVC(View←Controller←Model, 34행), transport 격리(ADR-003).
- `/docs/ADR.md` — ADR-003(주입형 Model 계약, View는 transport 비의존), zero-dep·TDD.
- `/docs/news.md` — 기사 에디터 첫째 줄=제목(158행), 본문 블록 구조/색상(159~172행), 송고/보류 시 제목 필요(146행).
- `/web/src/view/WriterPage.jsx` — **수정 대상**. 본문변경 경로가 여러 곳에 흩어져 있다. 반드시 **현재 파일을 처음부터 정독**하고 `updateField('body', ...)`를 호출하는 **모든** 지점을 찾아라. 최소한 다음이 포함된다(행 번호는 참고, 실제 위치 확인):
  - `onTextChange`(약 241~245행) — 유일하게 title도 갱신(첫 줄).
  - `insertEnd`(약 248행)·`insertContinue`(약 255행)·`onGlyphPick`(약 263행)·`insertDate`(약 274행)·`convertAbbrev`(약 299행)·`applySimpTrad`(약 309행) — title 미갱신.
  - `onReplaceOne`(약 393행)·`onReplaceAll`(약 405행) — 바꾸기, title 미갱신.
  - `onMenuSelect`의 대소문자 변환(VIEW_TRANSFORMS, 약 462~469행) — title 미갱신.
  - `onKeyDown`의 줄삭제(약 589행) — title 미갱신.
  - `onRemoveEmbed`(약 592~597행)·`insertEmbedAtLine`(약 603~612행) — 임베드 전용(첫 텍스트 줄 불변이라 title은 안 바뀌지만, 일관성을 위해 같은 choke point를 지나도 무해하다).
  - `file.recover`(약 442행) — 초안 복구는 `draft`의 각 필드(`title` 포함)를 `updateField`하므로 이미 title이 채워진다(별도 처리 불필요, 깨지 않게 유지).
- `/web/src/view/writerBody.js` — **참고(재사용 대상, 원칙적으로 수정 불필요)**. `bodyTitle(body)`(11~14행)가 이미 "본문(문자열/블록) → blocksToText → 첫 줄 trim"으로 **제목 파생 단일 출처**다. 이 함수를 재사용한다(재구현 금지). `serializeBodyFromBlocks`(18~25행)는 onTextChange가 쓰는 직렬화 헬퍼다.
- `/web/src/view/editorContent.js` — `serialize`/`deserialize`/`blocksToText` 계약(제목 파생의 기준 텍스트 = 텍스트 블록만 개행 결합).
- `/web/src/controller/useWriteController.js` — **참고(원칙적으로 수정 불필요)**. `updateField`(260~267행)가 **매핑 모드에서는 `['body']`만 허용**하고 그 외에는 `EDITABLE_FIELDS`(title 포함)를 허용함을 확인하라. → 중앙 경로가 매핑 모드에서 `updateField('title', ...)`를 호출해도 컨트롤러가 안전하게 거부(no-op)한다. `toSaveDto`(58~63행)가 `tab.fields.title`을 서버로 싣는다(제목이 stale이면 여기로 옛 값이 나간다).
- `/web/src/view/WriterPage.test.jsx` — **수정 대상(테스트 추가)**. `setup({ pendingEdit, seed, identity })`로 편집 탭을 열고 `.yh-editor`/`.yh-editor__line`을 조작하는 기존 패턴을 따른다(예: Ctrl+D 줄삭제 테스트가 약 439행, Backspace가 약 452행).

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경(결함 상세)

- 제목은 본문 첫 줄에서 파생된다(news.md 158행). `onTextChange`만 `updateField('title', 첫 줄)`을 하고, 나머지 본문변경 경로는 body만 갱신한다.
- 예: 본문 첫 줄이 "한국"인 기사에서 '모두 바꾸기'로 "한국"→"대한민국"을 실행하면 body의 첫 줄은 "대한민국"이 되지만 `tab.fields.title`은 "한국"으로 남는다. 저장 시 `toSaveDto`가 옛 제목("한국")을 서버에 싣는다(DB에 stale 제목 영속).
- `onAction`(송고/보류, 약 708행)이 `bodyTitle(body) || fields.title`로 제목 유무를 판정하므로 "제목 없음" 오탐은 없지만, **DB에 저장되는 제목 필드**는 여전히 stale이다.

## 작업 (TDD — 테스트 먼저)

### 1) 테스트 먼저 작성 — `/web/src/view/WriterPage.test.jsx`

각 대표 경로가 본문 첫 줄을 바꾼 뒤 **탭의 title이 재동기화**되는지 검증한다. 저장 dto를 관찰하는 게 가장 직접적이다 — `createFakeModel`이 노출하는 저장 호출 인자(예: `saveArticle`에 전달된 dto)로 `title`을 확인하거나, 송고/보류 성공 시 서버로 나간 dto의 `title`을 확인한다. `fakeModel`의 실제 관찰 API는 `/web/src/test/fakeModel.js`를 읽어 확인하고 그 계약에 맞춰 단언하라. 최소 아래 2~3경로를 커버한다:

- **모두 바꾸기 경로**: 첫 줄을 포함하는 query로 `replaceAll`을 발생시킨 뒤(찾기/바꾸기 다이얼로그 또는 `onReplaceAll` 결선 경유) → 이어 저장/송고 시 dto의 `title`이 **바뀐 첫 줄**과 일치함을 단언한다.
- **대소문자 변환 경로**: 첫 줄에 캐럿을 두고 보기>대문자로 바꾸기(VIEW_TRANSFORMS)를 발생시킨 뒤 → title이 변환된 첫 줄과 동기화됨을 단언한다.
- **줄삭제 경로**: 첫 줄을 Ctrl+D로 지운 뒤 → title이 새 첫 줄로 동기화됨을 단언한다.
- **회귀 가드**: 기존 `onTextChange`(타이핑) 경로의 title 동기화·기존 테스트가 **그대로 통과**해야 한다.
- **매핑 모드 무해성(권장)**: 매핑 탭에서 임베드 삽입(본문 body만 변경) 시 오류 없이 동작하고 title 갱신 시도가 컨트롤러에서 안전히 무시됨을 확인한다(매핑은 텍스트/제목을 바꾸지 않는다).

### 2) 구현 — `/web/src/view/WriterPage.jsx`

- **중앙 choke point 헬퍼**를 하나 만든다. 시그니처 예(이름·형태는 재량이나 단일 함수로):

  ```js
  // 본문 변경 단일 경로 — body를 갱신하고 제목(본문 첫 줄)을 항상 재동기화한다.
  // 모든 본문변경 핸들러가 updateField('body', ...) 대신 이 함수를 쓴다(제목 stale 방지·phase 29 재사용).
  const commitBody = (nextBody) => {
    updateField('body', nextBody);
    updateField('title', bodyTitle(nextBody)); // 매핑 모드면 컨트롤러가 title을 안전히 거부(no-op)
  };
  ```

  - `nextBody`는 **직렬화된 본문 문자열**(기존 각 경로가 이미 `serialize(...)`/`serializeBodyFromBlocks(...)`/`appendEmbedToBody(...)`/`r.body` 등으로 만든 값)을 받는다. 제목 파생은 **반드시 `writerBody.bodyTitle`을 재사용**한다(첫 줄 파생 로직 재구현 금지).
- 위 "읽어야 할 파일"에서 찾은 **모든 `updateField('body', X)` 호출을 `commitBody(X)`로 교체**한다. `onTextChange`도 별도 title 갱신 줄을 지우고 `commitBody(serializeBodyFromBlocks(editedBlocks))` 하나로 통일한다.
- 임베드 전용 경로(`onRemoveEmbed`/`insertEmbedAtLine`)도 같은 choke point를 지나게 하라(첫 텍스트 줄이 안 바뀌면 title은 동일하게 재계산되어 무해 — 단일 경로 유지가 목적).
- `file.recover`(초안 복구)는 `draft`의 필드들을 각각 `updateField`하는 별개 경로이므로 **그대로 둔다**(이미 title 포함). 억지로 commitBody로 바꾸지 마라.

### 핵심 불변식(반드시 준수)

- **본문을 바꾸는 모든 경로는 title을 본문 첫 줄로 재동기화**한다(단일 choke point 통과). `tab.fields.title`은 항상 `bodyTitle(body)`와 일치한다.
- 제목 파생은 `writerBody.bodyTitle` 단일 출처만 쓴다(재구현·중복 정의 금지).
- 매핑 모드에서 `commitBody`가 호출돼도 컨트롤러의 `updateField`가 title을 거부하므로 매핑 본문-only 불변식을 깨지 않는다.
- View는 transport 비의존을 유지한다(ADR-003) — `commitBody`는 `updateField`만 호출하고 `fetch`/`EventSource`/`model.*`를 직접 부르지 않는다.
- 임베드 위치/블록 순서/"(끝)" 마커 규칙은 기존과 동일하게 보존된다(직렬화 값은 각 경로가 만든 그대로 넘긴다 — 이 step은 title 동기화만 추가한다).

## Acceptance Criteria

```bash
npm run test:web   # 신규 제목 동기화 테스트 + 전체 회귀 통과 (vitest, web 루트)
npm run build      # vite 프로덕션 빌드 에러 없음
npm run lint       # ESLint 위반 없음
```

모든 신규/수정 텍스트는 UTF-8로 저장하라.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 제목 파생을 `writerBody.bodyTitle` 단일 출처로 재사용했는가(재구현 금지)?
   - 모든 본문변경 경로가 단일 choke point(`commitBody`)를 지나는가(누락 경로 없음)?
   - View에서 transport(`fetch`/`EventSource`/`model.*`)를 직접 호출하지 않았는가(ADR-003)?
   - 컨트롤러(`useWriteController`)·서버·DB 스키마를 바꾸지 않았는가?
3. 결과에 따라 `phases/28-audit-stabilization/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- 제목 파생 로직(첫 줄 추출)을 새로 작성하지 마라. 이유: `writerBody.bodyTitle`이 단일 출처다 — 중복 정의하면 파생 규칙(trim·텍스트 블록 기준) 변경 시 불일치가 생긴다.
- 일부 경로만 고치고 나머지를 남기지 마라. 이유: 한 경로라도 누락되면 그 경로로 제목 stale가 그대로 재발한다 — `updateField('body', ...)`를 **전수 교체**한다.
- `useWriteController.updateField`의 허용 필드 규칙(매핑=`['body']`만)을 바꾸지 마라. 이유: 매핑 본문-only 불변식을 지탱하는 계약이다 — 중앙 경로는 이 규칙 위에서 안전히 동작해야 한다(title은 매핑에서 자동 거부됨).
- 임베드 위치/블록 순서/"(끝)" 마커 직렬화를 바꾸지 마라. 이유: 이 step은 title 동기화만 추가한다 — 각 경로가 만든 직렬화 결과를 그대로 넘긴다(본문 구조 변경은 범위 밖).
- 서버/DB 스키마를 수정하지 마라. 이유: 순수 클라이언트 상태 동기화 결함이며 DB 비파괴 원칙을 지킨다.
- 새 npm 의존성을 추가하지 마라(zero-dep).
- 기존 테스트를 깨뜨리지 마라(특히 `onTextChange` 타이핑 title 테스트·줄삭제/바꾸기 테스트). 이유: 회귀 스위트가 하류 단계의 안전망이다.
