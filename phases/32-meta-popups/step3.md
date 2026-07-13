# Step 3: commoninfo-wiring — 내용 필드 신설 + 지역/내용/속성 팝업 결선

## 배경 / 요구사항

step 0(택소노미·헬퍼)·step 1(백엔드 category)·step 2(MetaSelectDialog)를 조립한다. 공통정보에서:
1. **내용(category) 필드 신설** — 클라 편집 필드에 `category` 추가(blank 시드·편집 로드·저장 dto 자동 포함).
2. **지역/내용/속성 입력란 → 팝업 트리거로 전환** — 직접 타이핑 제거, 클릭 시 MetaSelectDialog 오픈(readOnly 표시용 input). 매핑(readOnly) 모드에선 팝업 미오픈.
3. 다른 공통정보 필드(작성자/공동작성/키워드/코멘트/파일/엠바고)는 **불변**.

프론트 write 경로(controller + view + 팝업 결선)만 만진다. 백엔드·상세보기·본문/에디터는 접촉 금지(각각 step 1·4·범위 밖).

### ⚠️ 이 step은 기존 테스트를 깨뜨린다 — 반드시 함께 수정
`WriterPage.test.jsx`에 구스펙 전제 테스트가 있다. 이 step에서 **명시적으로 갱신**한다(방치하면 회귀 실패):
- **L942~945** `'내용(content) 별도 입력란은 추가하지 않는다'` — 이제 **정반대**다('내용' 필드가 **있어야** 함). 이 테스트를 **뒤집는다**(내용 라벨 존재 단언). 남겨 두면 새 필드와 모순돼 실패.
- **L947~976** `'입력 변경이 dto에 반영된다'` — 지역/속성을 `userEvent.type(getByLabelText('지역'), '서울')`로 **직접 타이핑**한다. 지역/속성이 팝업 트리거(readOnly)가 되면 타이핑 불가 → **팝업 플로우로 재작성**(트리거 클릭 → MetaSelectDialog 체크 → 적용 → dto 반영). coAuthor/keyword/comments는 직접 타이핑 유지, region/attribute/**category**는 팝업 경유.
- **L991~992** `getByLabelText('지역')).toHaveValue('대전')` — 편집 로드 단언. 트리거 input이 값 표시를 유지하면 `toHaveValue`는 계속 통과(readOnly여도 value 속성 유지). category 로드 단언 추가.
- **L998~1008** 매핑 readonly 테스트 — 지역/속성이 항상 readOnly 표시라도 매핑 모드 단언은 유지된다(내용도 매핑에서 잠금 확인 추가).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(프론트 MVC), `/docs/ADR.md`(ADR-003), `/docs/news.md` L49(공통정보 '내용' 포함)·L63~65(팝업·한도)·L250(편집 로드 시 '내용' 포함).
- `web/src/view/metaTaxonomy.js`(step 0) — `metaFieldConfig(field)`(→ `{title,groups,limit}`), `joinTokens`. **부모(WriterPage)가 여기서 title/groups/limit을 뽑아 MetaSelectDialog에 주입한다.**
- `web/src/view/MetaSelectDialog.jsx`(step 2) — props `open/title/groups/limit/value/onSubmit/onClose`. `onSubmit(joined)`이 조인 문자열을 준다.
- `web/src/controller/useWriteController.js` — **편집 필드 단일 출처** `EDITABLE_FIELDS`(L21~25). 여기에 `'category'`를 추가하면 `blankFields`(L67~72)·`fieldsFromArticle`(L75~83)·`toSaveDto`(L58~63, body 제외 전 필드 spread)가 **자동으로** category를 시드/로드/저장한다. `updateField`(L260~267)는 `EDITABLE_FIELDS` 포함 필드만 갱신(매핑 모드는 body만) — category도 이 게이트를 자동으로 탄다.
- `web/src/view/WriterPage.jsx`:
  - 임포트 블록(L6~67) — `metaTaxonomy`·`MetaSelectDialog` import 추가 지점.
  - `isMapping`(L202), **탭 전환 렌더-조정 블록(L213~225)** — `caretTabId !== activeTabId`일 때 문서-로컬 상태를 비우는 곳. `setTableDialog(null)`(L224)과 **동일하게 `setMetaDialog(null)` 추가**(아래 '핵심 규칙 2').
  - `tableDialog` 상태·렌더(L1144~1149) — **metaDialog 상태/렌더의 형태 템플릿**.
  - `CommonInfo` 렌더(L1071, `readOnly={isMapping}` 주입) 및 컴포넌트 정의(L1233~1340) — 지역 input(L1267~1268 `f.region`), 속성 input(L1271~1272 `f.attribute`). **여기에 내용(category) 필드 신설 + 세 필드를 팝업 트리거로 전환.**
- `web/src/view/WriterPage.test.jsx` — `'공통정보 확장 입력'` describe(L929~1009). 위 '깨지는 테스트' 4곳. `setup()`/`actionBtn()`/`screen`/`userEvent` 하니스와 편집 로드 seed 패턴(L978~996).
- `web/src/view/TableEditDialog` 결선 선례(WriterPage L1141~1149, `onTableSubmit` → 본문 반영) — 팝업 제출을 필드로 반영하는 결선의 형태 참고(단 우리는 본문이 아니라 `updateField(field, joined)`).

## 작업

TDD로 진행한다(vitest). **필드 신설 → 트리거 전환 → 팝업 결선 → 탭전환 닫기 → 기존 테스트 갱신** 순으로 진행한다.

### (1) 편집 필드에 category 추가 (useWriteController.js)

- `EDITABLE_FIELDS`(L21~25)에 `'category'` 추가. 이것만으로 blank 시드·편집 로드·저장 dto·updateField 게이트가 category를 포함한다(단일 출처 설계). **다른 로직 변경 불필요.**
- 회귀 확인: `useWriteController.test.jsx`에 category 시드/로드/저장 단언이 없으면 1건 추가(신규 탭 `category:''`, 편집 로드 시 article.category 반영, toSaveDto에 category 포함).

### (2) 지역/내용/속성 = 팝업 트리거로 전환 (WriterPage.jsx CommonInfo)

CommonInfo에 부모 콜백 `onOpenMeta`를 prop으로 추가하고(부모가 주입), 세 필드를 **readOnly 표시 input + 클릭=팝업 오픈**으로 바꾼다:

- **내용(category) 신설**: 라벨 `내용`, `id="meta-category"`, `value={f.category}`. news.md L49 순서상 **공동작성과 지역 사이**에 배치.
- **지역**(기존 L1267~1268)·**속성**(기존 L1271~1272)·**내용**(신설) input:
  - `readOnly`(항상 — 직접 타이핑 제거), `value`는 해당 필드값 표시.
  - `onClick={() => { if (!readOnly && onOpenMeta) onOpenMeta('region'|'category'|'attribute'); }}` — **매핑(readOnly) 모드에선 no-op**(팝업 미오픈).
  - 접근성: `aria-haspopup="dialog"`, `aria-readonly` 유지. 라벨(`htmlFor`)은 `지역`/`내용`/`속성` 그대로 — `getByLabelText`가 계속 찾도록.
  - **직접 `onChange`(타이핑) 제거** — 값 변경은 오직 팝업 제출로만.
- 다른 필드(작성자/공동작성/키워드/내부·외부코멘트/첨부·자료파일/엠바고/2차엠바고)는 **그대로**(불변).
- 구스펙 주석(L1230 "본문(내용)은 좌측 에디터가 담당")은 신스펙에 맞게 갱신(내용=분류 필드).

### (3) 팝업 상태·결선 (WriterPage.jsx 본체)

- 상태 `const [metaDialog, setMetaDialog] = useState(null)` — 값은 열린 필드 키(`'region'|'category'|'attribute'`) 또는 `null`. (tableDialog 패턴과 동형.)
- `onOpenMeta = (field) => setMetaDialog(field)` 를 CommonInfo에 주입(단, CommonInfo가 readOnly면 내부에서 no-op — (2)에서 처리).
- 렌더(다른 다이얼로그들 곁, L1144 TableEditDialog 인근):
  ```jsx
  <MetaSelectDialog
    open={metaDialog !== null}
    title={metaDialog ? metaFieldConfig(metaDialog).title : ''}
    groups={metaDialog ? metaFieldConfig(metaDialog).groups : []}
    limit={metaDialog ? metaFieldConfig(metaDialog).limit : 0}
    value={metaDialog ? (activeTab.fields[metaDialog] || '') : ''}
    onSubmit={(joined) => { updateField(metaDialog, joined); setMetaDialog(null); }}
    onClose={() => setMetaDialog(null)}
  />
  ```
  - `value`는 **활성 탭의 해당 필드**에서 읽는다(현재 값 → 팝업 초기 체크). `onSubmit`은 `updateField(metaDialog, joined)`로 **활성 탭에 반영** 후 닫는다.

### (4) 탭 전환 시 팝업 닫기 (렌더-조정 블록)

- **탭 전환 렌더-조정 블록(L213~225)** 안, `setTableDialog(null)`(L224) 곁에 **`setMetaDialog(null)` 추가**.
- 이유(주석에 명시): metaDialog가 열려 있고 `value`/`onSubmit`이 **활성 탭-로컬**이다. 비모달이라 열린 채 탭 전환이 가능한데, 그러면 `onSubmit`이 **다른 탭**의 필드를 덮어쓴다(phase 29 lastCaretRef·30 spellIssues·31 tableDialog와 **동일 계열의 문서-로컬 좌표 이월 버그**). 전환 시 반드시 닫는다.
- effect가 아니라 렌더-조정 패턴인 이유는 기존 블록 주석(L211~212)과 동일(마운트 wipe·flush 레이스 회피) — 기존 블록에 한 줄 더하는 것이므로 자동 준수.

### (5) 기존 테스트 갱신 (WriterPage.test.jsx) — '깨지는 테스트' 처리

위 '⚠️ 이 step은 기존 테스트를 깨뜨린다'의 4곳을 갱신하고 신규 팝업 플로우 테스트를 추가한다:
- L942 뒤집기: 내용(category) 필드가 라벨 `내용`으로 존재.
- L947 재작성: 지역/내용/속성은 팝업 경유로 값 설정 후 dto에 `region`/`category`/`attribute` 반영 단언. coAuthor/keyword/comments는 직접 타이핑 유지.
- L991 편집 로드에 category 단언 추가(seed에 `category` 넣고 `getByLabelText('내용')`이 값 로드).
- L998 매핑 readonly에 내용 포함 + 지역/속성/내용 트리거가 매핑에서 팝업을 **열지 않음** 단언(클릭해도 `meta-dialog` 미출현).
- 신규: 매핑 아닌 모드에서 지역 트리거 클릭 → `meta-dialog` 출현 → 항목 체크 → 적용 → 지역 input 값/후속 저장 dto 반영. 탭 전환 시 열린 팝업이 닫히는 회귀 1건(가능하면).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **팝업만이 값 변경 경로**: 지역/내용/속성은 직접 타이핑 불가(readOnly), 값은 MetaSelectDialog 제출(`updateField(field, joined)`)로만 바뀐다. 이유: news.md "누르면 팝업창이 열리고" — 자유 타이핑 제거.
2. **탭 전환 시 metaDialog 닫기**: 렌더-조정 블록(L213~225)에 `setMetaDialog(null)` 추가. 이유: 팝업 value/onSubmit이 활성 탭-로컬 — 열린 채 전환하면 다른 탭 필드를 덮어쓴다(phase 29/30/31 반복 게이트 이슈).
3. **매핑 모드 잠금**: `readOnly`(isMapping)이면 트리거 클릭이 팝업을 열지 않는다. 이유: 매핑은 임베드 전용 편집 — 공통정보 잠금(기존 CommonInfo readOnly 계약).
4. **category 단일 출처**: 클라 편집 필드 추가는 `EDITABLE_FIELDS`에 `'category'` 한 줄만. blank/load/save 로직을 개별 수정하지 마라(단일 출처가 파생). 이유: 시드/로드/저장 일관성(기존 설계 존중).
5. **본문/에디터 미접촉**: `Editor.jsx`·`editorContent.js`·본문 변경 경로(commitBody 등)를 건드리지 마라. 이 step은 **우측 메타 패널 + 팝업 결선**만. 이유: 입력/키 경로 회귀 위험(범위 밖).
6. **다른 공통정보 필드 불변**: 작성자/공동작성/키워드/코멘트/파일/엠바고 입력을 바꾸지 마라. 이유: 회귀 방지 — 이 phase는 지역/내용/속성 + category 신설만.

## Acceptance Criteria

```bash
npm run test:web -- WriterPage        # 공통정보 팝업 결선 + 갱신된 기존 테스트 통과
npm run test:web -- useWriteController # category 시드/로드/저장 통과
npm run test:web                      # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest):
- `WriterPage.test.jsx`: 내용(category) 라벨 존재; 지역/내용/속성 트리거 클릭 → `meta-dialog` 출현(비매핑) / 미출현(매핑); 팝업에서 항목 선택·적용 → 해당 input 값 + 저장 dto(`region`/`category`/`attribute`) 반영; 편집 로드 시 지역/내용/속성 값 표시; 매핑 모드에서 세 필드 readonly + 팝업 미오픈; (가능하면) 탭 전환 시 열린 팝업 닫힘.
- `useWriteController.test.jsx`: 신규 탭 `category:''`; 편집 로드 `category` 반영; `toSaveDto`에 `category` 포함.

## 검증 절차

1. 위 AC 커맨드 실행(한글 깨지면 UTF-8 로케일 확인).
2. 아키텍처 체크리스트:
   - `EDITABLE_FIELDS`에 `'category'` 존재(단일 출처).
   - 렌더-조정 블록에 `setMetaDialog(null)` 존재(탭 전환 닫기).
   - 지역/내용/속성 input이 readOnly + onClick 트리거(직접 onChange 없음), 매핑에서 no-op.
   - `Editor.jsx`·`editorContent.js`·`src/`(백엔드)·`articleDetail.js` 무변경(`git status` 확인).
   - 깨지던 4개 테스트가 신스펙으로 갱신되어 green.
3. 결과에 따라 `phases/32-meta-popups/index.json`의 step 3을 갱신.

## 금지사항

- 지역/내용/속성을 자유 타이핑(직접 onChange) 가능하게 두지 마라. 이유: 스펙은 팝업 선택 — 자유입력 제거.
- 렌더-조정 블록에서 `setMetaDialog(null)`을 빠뜨리지 마라. 이유: 탭 전환 시 다른 탭 필드 오손(phase 29/30/31 동일 계열 버그).
- 매핑 모드에서 팝업이 열리게 두지 마라. 이유: 공통정보 잠금 계약 위반.
- blank/load/save 로직을 개별 손대 category를 넣지 마라(EDITABLE_FIELDS 단일 출처만). 이유: 시드/로드/저장 불일치 유발.
- `Editor.jsx`/본문 변경 경로/`editorContent.js`를 건드리지 마라. 이유: 입력·키 경로 회귀(범위 밖).
- 백엔드(`src/`)나 상세보기(`articleDetail.js`)를 이 step에서 바꾸지 마라. 이유: step 1·4 담당(Scope 최소화).
- 깨지는 기존 테스트를 `skip`/삭제로 회피하지 마라 — 신스펙으로 갱신하라. 이유: 계약 회귀 은폐 금지.
