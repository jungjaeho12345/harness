# Step 1: autocode-title-sync

## 목표

**자동 기업코드 변환(환경설정 `edit.companyCode === 'auto'`)** 저장/송고 시, 본문 첫 줄(=헤드라인=제목)이 종목코드로 태깅되면 그 변환된 제목이 **이번 저장 1회에 한해 DB에 반영되지 않는** 결함을 수정한다. 원인은 컨트롤러의 `toSaveDto(tab, bodyOverride)`가 `bodyOverride`로 **본문(markupVersion)만** 최신화하고 `title`은 stale한 `tab.fields.title`에서 취하기 때문이다. 수정 = `bodyOverride`가 있을 때 **제목도 그 오버라이드 본문에서 재파생**한다(`dto.title = bodyTitle(bodyOverride)`).

변경 대상은 **컨트롤러 단일 모듈**(`web/src/controller/useWriteController.js`)의 `toSaveDto` + 그 테스트뿐이다. 뷰/DOM/서버/DB 무접촉.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`, `docs/ADR.md` — ADR-004(role은 DTO에 안 싣는다), 계층: controller→model. `toSaveDto`는 컨트롤러 내부 순수 함수.
- `web/src/controller/useWriteController.js`:
  - **`toSaveDto(tab, bodyOverride)`(L57~67)**. L63 `const { body, ...rest } = tab.fields;` L64 `const dto = { ...rest, markupVersion: bodyOverride ?? body };`. **여기서 title은 `...rest`(=`tab.fields.title`)에서 온다 — bodyOverride와 무관하게 stale.** L59~61 주석이 bodyOverride 도입 배경(commitBody의 setState가 같은 tick에 tabsRef 미반영)을 설명한다.
  - `save`(L279~287)·`submit`(L316~334)이 `toSaveDto(tab, bodyOverride)`로 저장. `saveMapping`(L303~312)·`saveAsNew`(L293~298)은 `toSaveDto(tab)`(**bodyOverride 없음**) — 이 경로는 영향받지 않아야 한다.
  - import 블록(L8~10) — `bodyTitle` import를 여기 추가한다.
- `web/src/view/writerBody.js` — **`bodyTitle(body)`(L11~14)**: `blocksToText(deserialize(body)).split('\n')[0]`의 trim. **순수·transport 비의존**(DOM/React 무관). 제목=본문 첫 줄 규칙의 **단일 출처**(뷰의 `commitBody`도 이걸 쓴다).
- `web/src/view/WriterPage.jsx` `autoCompanyCodeBody`(L585~593) — 자동 변환 경로. L588 `convertCompanyCodeInBlocks(blocks)` → L590 `serialize(r.blocks)` → L591 `commitBody(nextBody)` → L592 `return nextBody`. 이 반환값이 `save`/`submit`의 bodyOverride가 된다(WriterPage의 saveDocument/onAction 결선부). **이 파일은 수정하지 않는다 — 확인만**(수정은 컨트롤러에서 완결).
- `web/src/controller/useWriteController.test.jsx` — `renderHook(useWriteController)`·`setup(...)`·`vi.spyOn(model,'saveArticle')`·`result.current.save(...)`/`submit(...)`·dto 단언 관례(L235·L293·L373 참고). **L235**("markupVersion 키로 본문 전송")이 dto shape 단언의 직접 템플릿.

## 배경 (자기완결) — 왜 실재 버그인가

`edit.companyCode === 'auto'`면 저장/송고 직전에 `autoCompanyCodeBody()`가 본문을 변환한다. 종목명이 **본문 첫 줄(헤드라인)**에 있으면 변환 후 첫 줄이 `삼성전자` → `삼성전자(005930)`처럼 바뀐다. 제목은 본문 첫 줄에서 파생되므로(`bodyTitle`), 변환된 본문의 제목도 코드가 붙어야 한다.

그런데 `commitBody(nextBody)`가 `updateField('title', bodyTitle(nextBody))`로 제목 state를 갱신해도 **같은 tick에 `tabsRef`(save가 읽는 소스)에 반영되지 않는다**(effect 지연 — bodyOverride가 애초에 이 이유로 도입됨). `save(bodyOverride)`가 즉시 `toSaveDto(tab, bodyOverride)`를 호출하는데, `markupVersion`은 오버라이드로 최신이지만 `title`은 `tab.fields.title`(변환 前 stale). 결과: **DB에 본문은 코드 태깅, 제목은 코드 미태깅**으로 저장(이번 1회). 다음 저장은 state가 따라잡아 self-heal되지만, **이번 저장이 `submit('send')`/`submit('hold')`면 잘못된 제목이 그대로 송고/보류로 영속**된다.

수정: `toSaveDto`가 `bodyOverride`를 markupVersion 소스로 쓰는 것과 **같은 소스에서 제목도 파생**한다. `bodyTitle`은 순수 함수이자 제목-파생 규칙의 단일 출처라, 컨트롤러가 이를 재사용하면 로직 중복 없이 뷰(`commitBody`)와 동일한 제목이 나온다.

## 설계 결정 (플랜 리뷰어 확인 요망 — 계층 트레이드오프)

두 안이 있다. **Design A를 채택**하되, 리뷰어가 계층 우려로 반대하면 Design B로 전환한다.

- **Design A (채택 — 컨트롤러 로컬, 단일 모듈)**: `toSaveDto`가 `web/src/view/writerBody.js`의 순수 `bodyTitle`을 import해, `bodyOverride != null`일 때 `dto.title = bodyTitle(bodyOverride)`. 변경이 **컨트롤러 1파일 + 테스트**로 최소이고, 제목-파생 단일 출처(`bodyTitle`)를 재사용해 로직 중복이 없다. 유일한 스멜: controller가 `view/`의 순수 헬퍼를 import(디렉토리 경계). 그러나 `bodyTitle`은 DOM/React 무의존 순수 함수라 실질 결합은 낮다.
- **Design B (대안 — 오버라이드 계약 확장)**: `save`/`submit`의 `bodyOverride`(문자열)를 `{ markupVersion, title }` 객체로 바꾸고, WriterPage `autoCompanyCodeBody`가 `{ markupVersion: nextBody, title: bodyTitle(nextBody) }`를 반환. 제목 파생을 전적으로 뷰에 유지하나, **뷰+컨트롤러 2계층 + 양쪽 테스트**를 건드려 표면이 넓다.

후보 원문("bodyOverride 경로(useWriteController)에서 title도 재파생")이 **Design A**를 지시한다. 아래 작업은 Design A 기준.

## TDD — 테스트 먼저 (`web/src/controller/useWriteController.test.jsx`)

L235 dto-shape 테스트 동형으로 추가한다. 핵심: **stale title이 있는 탭 + 오버라이드 본문(첫 줄이 다름)** → dto.title이 오버라이드에서 재파생됨.

- **오버라이드 시 title 재파생**: 편집 탭을 열어(또는 setup으로) `fields.title='삼성전자'`·`fields.body='삼성전자\n본문\n(끝)'` 상태를 만든 뒤, `await result.current.save('삼성전자(005930)\n본문\n(끝)')` 호출 → `saveArticle`의 dto가 `markupVersion: '삼성전자(005930)\n본문\n(끝)'` **그리고 `title: '삼성전자(005930)'`**(=`bodyTitle(오버라이드)`, stale '삼성전자' 아님)로 불렸는지 단언.
- **submit 경로 동형**: `await result.current.submit('send', '삼성전자(005930)\n본문\n(끝)')` → 편집 탭 PUT dto의 `title`이 재파생값.
- **오버라이드 없으면 불변(하위호환)**: `await result.current.save()`(인자 없음) → dto.title === `tab.fields.title`(재파생 안 함). 기존 L235 등 무회귀 확인.
- **매핑/다른이름 저장 불변**: `saveMapping`·`saveAsNew`는 `toSaveDto(tab)`(오버라이드 없음)이라 title 재파생 미발생 — 기존 매핑 테스트(L373·L383) 그린 유지.

> `bodyTitle`은 평문 문자열을 그대로 첫 줄 파싱한다(JSON 아니면 평문). 위 테스트의 오버라이드는 평문 `'...\n...'`로 충분하다(deserialize가 평문 역호환 로드).

## 작업 (구현 상세 — 시그니처 최소 변경)

`web/src/controller/useWriteController.js`:
1. import 추가(L8~10 근처): `import { bodyTitle } from '../view/writerBody.js';`
2. `toSaveDto`(L62~67) — `bodyOverride`가 주어졌을 때만 title 재파생:
   ```js
   function toSaveDto(tab, bodyOverride) {
     const { body, ...rest } = tab.fields;
     const dto = { ...rest, markupVersion: bodyOverride ?? body };
     if (bodyOverride != null) dto.title = bodyTitle(bodyOverride); // 오버라이드 본문에서 제목 재파생(자동 기업코드 태깅된 헤드라인 반영 — stale title 방지).
     if (tab.articleId) dto.articleId = tab.articleId;
     return dto;
   }
   ```
   - `bodyOverride != null` 게이트가 **핵심**: 오버라이드 없는 경로(mapping/saveAsNew/일반 save)는 기존대로 `tab.fields.title` 유지 — 하위호환·범위 최소.
   - L59~61 주석에 "title도 오버라이드 본문에서 재파생한다" 한 줄 보강.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(컨트롤러/뷰 순수 테스트 — `npm test`(node --test/서버)는 서버 파일 미변경이라 불필요. 단 전체 무회귀는 test:web으로 확인.)

## 회귀 가드 / 불변식

- **오버라이드 있을 때만 재파생**: `bodyOverride == null`이면 dto.title은 `tab.fields.title` 그대로(기존 동작 100% 보존). 매핑/다른이름 저장/일반 저장 무영향.
- **단일 출처**: 제목 파생은 `bodyTitle`만 쓴다(컨트롤러에 first-line 파싱 로직을 새로 구현하지 마라 — 뷰 `commitBody`와 이원화 금지).
- **markupVersion 키 불변**: 본문은 여전히 `markupVersion`으로 싣는다(`body` 키 미전송 — 서버 ARTICLE_FIELDS 일치).
- **ADR-004**: role 등 신뢰경계 필드를 dto에 추가하지 마라(title만 재파생).
- 기존 useWriteController 테스트 전부 그린 유지(기준: web 1871·backend 427·lint/build clean).

## 커밋 계획

- **fix**: `fix(45-editor-backlog-cleanup): step1 — auto 기업코드 변환 저장/송고 시 title 1회 지연 수정(toSaveDto가 bodyOverride 본문에서 bodyTitle 재파생)` — `useWriteController.js` + `useWriteController.test.jsx`.
- **chore**: `chore(45-editor-backlog-cleanup): step1 status — completed` — index.json step1.

## 금지사항

- 컨트롤러에 first-line/제목 파싱 로직을 새로 구현하지 마라. 이유: `bodyTitle`이 단일 출처다 — 재구현하면 뷰(commitBody)와 규칙이 갈라져 또 다른 stale을 만든다.
- `bodyOverride`가 없는 경로에서 title을 재파생하지 마라. 이유: 일반 저장/매핑/다른이름 저장은 `tab.fields.title`이 이미 최신(사용자가 직접 편집한 값 포함) — 무조건 재파생하면 사용자가 제목만 수정한 케이스를 덮어쓴다.
- `WriterPage.jsx`·`autoCompanyCodeBody`·서버/모델을 건드리지 마라. 이유: 결함은 컨트롤러 `toSaveDto`의 title 누락뿐 — 수정을 뷰/서버로 번지게 하면 실패 격리가 불가능하다(Design B로 확장하려면 리뷰어 승인 후 별도 재설계).
- 기존 테스트를 깨뜨리지 마라.
