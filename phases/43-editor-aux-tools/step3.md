# Step 3: company-code-manual

수동 기업코드 변환을 WriterPage에 결선한다: 우클릭 컨텍스트 메뉴 `ctx.companyCode` 활성화 + `Ctrl+B` 키 인터셉트 → 본문 전체를 `convertCompanyCodeInBlocks`로 변환(commitBody 안전 경로). 비활성 placeholder를 검증하던 기존 테스트를 활성 시나리오로 갱신한다.

## 읽어야 할 파일

- step 1 산출물: `web/src/view/companyCodeConvert.js`(`convertCompanyCodeInBlocks`), `web/src/view/companyCodeTable.js`.
- step 2 산출물: `web/src/view/editorShortcuts.js`(`isCompanyCode`).
- `web/src/view/WriterPage.jsx`:
  - `convertAbbrev`(~510행) — **동형 참고 대상**. `const r = expandAbbrevInBlocks(blocks, ...); if (!r.changed) return; commitBody(serialize(r.blocks));`. `convertCompanyCode` 핸들러를 이 형태로 만든다.
  - `onMenuSelect`의 `tools.abbrConvert`(~863행) — 매핑 가드 정책 참고(본문 변경 액션은 매핑에서 no-op).
  - `ctxEnabledIds`(~972행) 및 상단 주석(~964-971행): `...(isMapping ? [] : ['ctx.cut', ..., 'ctx.symbolInput'])`. `ctx.companyCode`는 **비매핑일 때만** 이 배열에 넣는다(본문 변경 액션 관례 — 약물입력과 동일 가드). L971 주석 "aux-tools 의존(기업코드변환): 항상 비활성 placeholder(미구현)"을 결선 상태로 고친다.
  - `onCtxSelect`(~1002행) switch — `case 'ctx.companyCode': if (!isMapping) convertCompanyCode(); break;` 추가. L1025 "aux 항목(ctx.companyCode)은 비활성이라 호출되지 않는다" 주석을 갱신.
  - `onKeyDown`(~1032행) 체인: `isFindReplace`(~1038행, Ctrl+F — `e.preventDefault(); if (!isMapping) openFind();`)가 **직접적 형태 선례**. Ctrl+B도 동형으로: `if (isCompanyCode(e)) { e.preventDefault(); if (!isMapping) convertCompanyCode(); return; }`. **matchGlyphKeymap(~1084행)보다 앞**(예약 조합 조기 return 구역)에 둔다.
  - import 구역(~36·55행): editorFind/editorShortcuts에서 predicate를 가져오는 형태. `isCompanyCode`, `convertCompanyCodeInBlocks` import 추가.
- `web/src/view/EditorContextMenu.jsx` — `ctx.companyCode`는 이미 `EDITOR_CONTEXT_ITEMS`에 정의됨(L12, label '기업코드변환', shortcut 'Ctrl+B'). **이 파일은 손대지 않는다**(항목·라우팅은 enabledIds로만 결정).

## 작업

### 1. `convertCompanyCode` 핸들러(WriterPage.jsx, `convertAbbrev` 인근에 신설)

- `convertAbbrev`와 동형: `const r = convertCompanyCodeInBlocks(blocks); if (!r.changed) return; commitBody(serialize(r.blocks));`
- 전체 본문 transform이라 `setPendingCaretLine`은 호출하지 않는다(convertAbbrev와 동일 정책 — 오프셋 대량 변동).
- 매핑 이중 방어: 호출부(ctx/onKeyDown)에서 `!isMapping` 가드를 두므로 핸들러 자체는 convertAbbrev와 동일 수준(별도 가드 불필요, 단 원한다면 `if (isMapping) return;` 이중 방어 허용 — applySimpTrad 선례).

### 2. `ctxEnabledIds` — 비매핑에서 `ctx.companyCode` 활성

- `...(isMapping ? [] : [..., 'ctx.symbolInput', 'ctx.companyCode'])` 형태로 비매핑 분기에 추가. 매핑에서는 미포함(본문 변경 액션 → 텍스트 잠금에서 비활성).

### 3. `onCtxSelect` — `ctx.companyCode` 라우팅

- `case 'ctx.companyCode': if (!isMapping) convertCompanyCode(); break;` (약물입력 case와 동형 이중 방어).

### 4. `onKeyDown` — Ctrl+B 인터셉트

- `isCompanyCode(e)` 분기를 예약 단축키 구역(Ctrl+F 근처, matchGlyphKeymap 앞)에 둔다: `e.preventDefault()`는 **항상**(매핑이어도), 실행은 `!isMapping`일 때만.
- **preventDefault 필수**: 이유는 아래 핵심 규칙 참조.

### 5. 기존 테스트 갱신(전수 — 아래 라인 목록을 그대로 처리)

전수 grep으로 확인된 `기업코드변환/ctx.companyCode/aux 비활성` 단언은 아래가 전부다. **모두 처리하라**:

- `web/src/view/WriterPage.test.jsx:2867-2875` — `it('aux 항목(기업코드변환)만 비활성으로 보인다 ...')` + 본문 `for (const label of ['기업코드변환']) expect(ctxItem(label)).toBeDisabled();`. **갱신 필수**: 비매핑에서 기업코드변환은 이제 **활성**이다. 이 테스트를 "비매핑에서 기업코드변환이 활성이고, 매핑에서는 비활성" 시나리오로 바꾼다(또는 아래 :2877 활성 목록에 '기업코드변환'을 넣고 이 케이스는 매핑-비활성 단언으로 전환).
- `web/src/view/WriterPage.test.jsx:2774` — 주석 "aux-tools 의존(기업코드변환)은 여전히 비활성 placeholder". **주석 갱신**(결선 완료로 문구 수정).
- `web/src/view/WriterPage.test.jsx:2877-2885` — `it('편집(비매핑) 모드: ... 활성이다')` 활성 라벨 목록. 여기에 `'기업코드변환'`을 추가하는 것을 권장(비매핑 활성 검증 일원화).
- `web/src/view/EditorContextMenu.test.jsx:65-66, 79` — **변경 금지(유지)**. 이유: 이 케이스는 `enabledIds=['ctx.findReplace']`를 컴포넌트에 직접 주입한 순수 컴포넌트 테스트라 `ctx.companyCode`가 enabledIds에 없어 비활성이 정상이다(WriterPage 결선과 무관). 확인만 하고 그대로 둔다.

### 6. 신규 테스트(작성)

- WriterPage 통합: 비매핑 에디터에서 본문에 '삼성전자'가 있을 때 (a) 우클릭 → 기업코드변환 클릭, (b) Ctrl+B 키 → 본문이 '삼성전자(005930)'로 바뀐다(commitBody 반영). 매핑 모드에서는 ctx 항목이 비활성이고 Ctrl+B가 본문을 바꾸지 않는다(updateField('body') 미호출).
- 멱등: 이미 변환된 본문에서 다시 Ctrl+B → 변화 없음(no-op).

## 반드시 지킬 핵심 규칙

- **Ctrl+B preventDefault 필수**: contentEditable에서 Ctrl+B는 브라우저 기본 bold(<b> 주입)로 발화 중이다. 인터셉트 시 반드시 `e.preventDefault()`해야 DOM `<b>`가 본문 블록 모델을 오염시키지 않는다. 매핑이어도 preventDefault는 한다(실행만 `!isMapping` — Ctrl+F 패턴과 동일).
- **본문 반영은 commitBody(serialize(...)) 단일 경로**: DOM/Editor 직접 조작 금지(제목 재동기화·마커 무결성 — convertAbbrev/applySimpTrad와 동일).
- **매핑에서 비활성/no-op**: 기업코드변환은 본문 텍스트를 바꾸므로 매핑(본문-only 불변식)에서 ctx 비활성 + onKeyDown no-op.
- **컨텍스트 메뉴 파일 불변**: `EditorContextMenu.jsx`의 항목·라우팅을 바꾸지 마라(활성은 enabledIds로만). 이유: 라벨 라우팅 금지·단일 출처.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 위 5·6의 테스트 갱신/신규가 통과하는지 확인한다. 특히 갱신 대상(WriterPage.test.jsx:2867)이 새 동작(활성)과 일치하는지.
3. i18n 확인: 새 UI 텍스트를 추가하지 않았는가? `기업코드변환` 라벨은 `EDITOR_CONTEXT_ITEMS`에 이미 있고, 도구 메뉴에 새 항목을 넣지 않는다(수동 변환은 ctx+Ctrl+B 전용). 따라서 i18n 카탈로그·ko 바이트 불변식 변경 없음.
4. 아키텍처 체크: 변경은 WriterPage.jsx(핸들러/ctx/onKeyDown/import)와 테스트에 국한. 순수 엔진(step1)·predicate(step2)만 소비.
5. `phases/43-editor-aux-tools/index.json`의 step 3을 갱신한다.

## 금지사항

- Ctrl+B 인터셉트에서 `e.preventDefault()`를 생략하지 마라. 이유: 브라우저 기본 bold가 발화해 `<b>` DOM이 블록 모델을 오염시킨다.
- 매핑 모드에서 기업코드변환을 실행하지 마라. 이유: 본문-only 불변식 위반.
- 도구 메뉴에 기업코드변환 항목을 추가하지 마라. 이유: 스펙(news.md L178·L186)상 수동 변환은 우클릭+Ctrl+B 전용이며 도구 메뉴에는 없다.
- 자동 모드(edit.companyCode==='auto') 로직을 이 step에 넣지 마라. 이유: 저장·송고 게이트 결선은 step 4·5.
- 기존 테스트를 깨뜨리지 마라(web 1753 기준 — 갱신 대상 :2867은 예외로 새 동작에 맞춰 수정).
