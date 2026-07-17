# Step 0: keymap-match-model

환경설정 **'사용자 키보드약물'(glyphKeymap)**을 실제로 인터셉트하기 위한 **순수 키조합 매칭 모델**을 만든다. 저장된 keymap 항목(`{keys, glyph}`)의 자유입력 `keys` 문자열을 정규화 combo로 파싱하고, keydown 이벤트를 그 combo와 대조해 매칭된 약물(glyph)을 돌려주는 **순수 함수 집합**이다. 이 step은 **순수 로직만** — React/DOM/clipboard/transport/localStorage 미접촉(WriterPage 결선·onKeyDown 배치는 step1).

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도·저장 형식·기존 관례를 파악하라(라인 번호는 대략치 — **심볼명으로 grep**해 정확 위치를 확정하라):

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — view는 순수 함수/컴포넌트, transport 비의존; 철학: TDD·zero-dep·표준 기능 우선).
- `docs/news.md` L214~215(**사용자 키보드 약물 — "키조합을 통해 등록할 수 있는 메뉴"**, 스펙은 이 한 줄뿐 — 동작 세부는 미명세라 아래 §보수적 해석을 권위 계약으로 채택), L178(**우클릭 단축키 목록** — 기업코드변환 Ctrl+B·잘라내기 Ctrl+X·복사 Ctrl+C·붙여넣기 Ctrl+V·원본 붙여넣기 Alt+V·텍스트 붙여넣기 Ctrl+V·약물입력 Alt+O·찾기/바꾸기 Ctrl+F·전체 선택 Ctrl+A — **예약 조합의 권위 출처**), L182(편집 메뉴 — 되돌리기/다시실행 = Ctrl+Z/Ctrl+Shift+Z, (계속)삽입 Ctrl+Y).
- `web/src/view/editorPrefs.js` — **저장 형식(계약).** `DEFAULT_EDITOR_PREFS.glyphKeymap = { items: [] }`, items는 `{ keys, glyph }[]`. `loadEditorPrefs()`가 얕은 병합으로 노출한다. **이 step은 editorPrefs를 import하지 않는다**(items 배열은 step1이 주입 — 아래 §입력 계약).
- `web/src/view/EditorPrefsDialog.jsx` — **`keys`가 어떻게 저장되는지 확인(핵심).** `addGlyphKey`(L150 근처)는 `keys = keyInputKeys.trim()`, `glyph = keyInputGlyph.trim()`으로 **자유입력 텍스트**를 그대로 저장한다(키 이벤트 캡처 아님·정규화 없음). 즉 `keys`는 사용자가 손으로 타이핑한 임의 문자열("Ctrl+1", "ctrl+k", "Alt+2", "Ctrl+Shift+K" 등)이다. 표시는 어디서나 `` `${keys} → ${glyph}` ``.
- `web/src/view/editorShortcuts.js` — **기존 키 프레디킷 관례(반드시 모방).** `isUndo`/`isRedo`/`isDeleteLine`/`isGlyphInput` 등은 `!!(e && ...)` null-safe 형태이고 **레이아웃 무관하게 `e.key`(대소문자)와 `e.code`(`KeyZ`/`KeyD`)를 함께 본다**. 이 관례가 아래 §정규화의 근거다.
- `web/src/view/editorHistory.js` + `web/src/view/editorHistory.test.js`(phase 37) — 순수 모듈/테스트(vitest) 반환형·스타일 **참조용**(구조 참고만, 로직 복사 금지).

## 배경 (자기완결)

기사 에디터 환경설정에 '사용자 키보드약물' 탭이 있어(phase 16) 사용자가 `키조합 → 약물` 쌍을 등록·저장하지만, **effect는 미결선(defer)**이다(phase 17 note: "키조합 인터셉트 DEFER — Editor 키핸들러 변경 필요"). 현재는 약물입력 다이얼로그(GlyphInputDialog)에 `keys → glyph` **참조 표시만** 되고, 실제로 그 키를 눌러도 아무 일도 없다.

이 phase가 그 인터셉트를 완성한다: step1이 WriterPage `onKeyDown`에서 keydown을 이 모델로 대조해 매칭되면 **기존 약물 삽입 안전 경로(insertGlyphAtCaret → commitBody)**로 약물을 캐럿에 삽입한다. 이 step은 그 대조에 필요한 **순수 매칭 로직**만 정의한다(삽입·결선·DOM은 step1).

### §보수적 해석 (스펙 미명세 지점 — 이 계약을 권위로 채택)

news.md는 "키조합을 통해 등록"만 말하고 **매칭·정규화·충돌 규칙은 침묵**한다. `keys`가 자유입력 텍스트라는 저장 형식 조사 결과에 근거해 아래를 못박는다(step1·리뷰어가 이 규칙을 검토 기준으로 삼는다):

1. **실수식어 필수(안전 불변식)** — combo는 **Ctrl·Alt·Meta 중 최소 하나**를 요구할 때만 매칭 대상이다. 수식어 없는 단일 키("a", "1")나 **Shift만** 있는 조합("Shift+1")은 **절대 매칭하지 않는다**(파싱이 `null` 반환). 이유: 그런 항목을 인터셉트하면 일반 타이핑("a"를 칠 때마다 약물로 치환)이 파괴된다.
2. **예약 조합 무시(섀도잉 금지)** — news.md L178 우클릭 단축키 + 편집 메뉴 하드코딩 단축키와 **충돌하는 keymap 항목은 컴파일 단계에서 버린다**(매칭 후보에서 제외). 표준 편집이 사용자 설정으로 조용히 죽는 것을 막는다.
3. **레터/디짓 우선 + `e.code` 병행** — 현실적으로 사용자는 "Ctrl+K"/"Ctrl+1"처럼 **영문자/숫자**를 등록한다. a–z/0–9 키는 `e.key`(대소문자 무관)와 `e.code`(`KeyK`/`Digit1`) **둘 다로** 매칭한다 — 한글 입력 상태(한영 on)에서 `e.key`가 자모여도 `e.code`는 라틴 키를 유지하므로 인식이 견고해진다(기존 프레디킷의 code 병행 관례와 동일).
4. **수식어 정확 일치** — Ctrl/Alt/Shift/Meta는 **정확히** 일치해야 한다(isUndo가 Ctrl+Z와 Ctrl+Shift+Z를 shift로 가르는 것과 동형). 사용자가 문자열에 Shift를 쓰면 Shift 필수, 안 쓰면 Shift 없어야 매칭.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### 신규 `web/src/view/editorGlyphKeymap.js` — 키조합 매칭(순수)

아래 시그니처·반환 계약·불변식을 만족하는 순수 함수 집합을 구현하라. **내부 자료구조와 세부 구현은 재량**이되, 시그니처·정규화 규칙·불변식은 반드시 지켜라(step1이 이 계약에 결선한다).

```js
// 예약 조합(단일 출처) — news.md L178 우클릭 단축키 + 편집 메뉴 하드코딩 단축키. 사용자 keymap이 이들을 가리면
// 표준 편집이 조용히 죽으므로 compile 단계에서 이 조합과 '정확히 일치'하는 항목을 버린다.
// 정규화 combo 배열(parseKeyCombo로 만들거나 리터럴). 최소 포함: Ctrl+B, Ctrl+X, Ctrl+C, Ctrl+V, Alt+V,
// Alt+O, Ctrl+F, Ctrl+A, Ctrl+Y, Ctrl+Z, Ctrl+Shift+Z, Ctrl+D, Alt+Y.
export const RESERVED_COMBOS = [ /* {ctrl,alt,shift,meta,key}[] */ ];

// 자유입력 'keys' 문자열 → 정규화 combo. 매칭 불가면 null.
//   { ctrl:boolean, alt:boolean, shift:boolean, meta:boolean, key:string(소문자) }
// 규칙: '+'로 분리·각 토큰 trim, 수식어 토큰(대소문자 무관 ctrl/control·alt/option·shift·meta/cmd/command/win)은
//   플래그로, 나머지 비수식어 토큰이 정확히 1개면 그것이 key(소문자화), 0개거나 2개 이상이면 파싱 실패(null).
//   Ctrl/Alt/Meta 중 하나도 없으면 null(§보수적 해석 1 — 실수식어 필수).
export function parseKeyCombo(keys) { /* → combo | null */ }

// keymap items({keys,glyph}[]) → 컴파일된 매칭 항목 배열: { combo, glyph }[].
//   제외 대상: parseKeyCombo === null(파싱 실패/수식어 없음), glyph 빈/공백(trim 후 ''), RESERVED_COMBOS와 정확히 일치.
//   등록 순서 보존(같은 combo가 여럿이면 먼저 등록된 항목이 매칭 우선).
export function compileGlyphKeymap(items) { /* → {combo, glyph}[] */ }

// keydown 이벤트 e를 컴파일 항목과 대조 → 첫 매칭 항목의 glyph(문자열) 또는 null.
//   빠른 탈출: e에 Ctrl/Alt/Meta가 하나도 없으면(수식어 없는 일반 타이핑) 스캔 없이 즉시 null.
export function matchGlyphKeymap(compiled, e) { /* → string | null */ }
```

구현 지침(순수):

1. **`parseKeyCombo(keys)`**
   - `s = String(keys ?? '').trim()`; `s === ''` → `null`.
   - `s.split('+')` → 각 토큰 `trim()` → 빈 토큰 제거. (알려진 한계: 리터럴 `'+'` 키는 분리자와 구분 불가라 미지원 — §금지사항 아래 주석으로 명시.)
   - 각 토큰을 소문자로 분류: `ctrl`/`control`→ctrl, `alt`/`option`→alt, `shift`→shift, `meta`/`cmd`/`command`/`win`→meta. 그 외는 "키 토큰".
   - 키 토큰이 정확히 1개가 아니면 → `null`. 1개면 `key = 키토큰.toLowerCase()`.
   - `ctrl || alt || meta`가 아니면 → `null`(실수식어 필수).
   - 반환 `{ ctrl, alt, shift, meta, key }`(불리언은 명시적 `!!`).

2. **`compileGlyphKeymap(items)`** — `Array.isArray(items)` 아니면 `[]`. 각 항목에 대해:
   - `glyph`가 `String(item.glyph ?? '').trim() === ''`면 제외.
   - `combo = parseKeyCombo(item.keys)`; `null`이면 제외.
   - `RESERVED_COMBOS`에 `combo`와 **정확히 일치**(ctrl/alt/shift/meta/key 모두 동일)하는 것이 있으면 제외.
   - 남으면 `{ combo, glyph: String(item.glyph).trim() }`를 결과에 push(등록 순서 보존).

3. **`matchGlyphKeymap(compiled, e)`**
   - `e`가 없거나 `!(e.ctrlKey || e.altKey || e.metaKey)`면 → `null`(빠른 탈출 — 수식어 없는 이벤트는 어떤 항목과도 매칭 불가).
   - `compiled`를 순서대로 스캔: `comboMatchesEvent(entry.combo, e)`가 true면 `entry.glyph` 반환. 없으면 `null`.
   - **`comboMatchesEvent(combo, e)`**(내부 헬퍼):
     - 수식어 정확 일치: `!!e.ctrlKey===combo.ctrl && !!e.altKey===combo.alt && !!e.shiftKey===combo.shift && !!e.metaKey===combo.meta`. 하나라도 불일치면 false.
     - 키 일치(`k = combo.key`, 이미 소문자):
       - a–z 단일 문자: `String(e.key).toLowerCase() === k` **또는** `e.code === 'Key' + k.toUpperCase()`.
       - 0–9 단일 문자: `e.key === k` **또는** `e.code === 'Digit' + k` **또는** `e.code === 'Numpad' + k`.
       - 그 외(명명 키 'f2'/'enter' 등): `String(e.key).toLowerCase() === k`(베스트에포트 — code 매핑은 만들지 않는다, 범위 최소화).

**못박음(불변식 — 어기면 step1 결선이 표준 편집을 죽이거나 타이핑을 파괴한다)**:
- **실수식어 필수**: `parseKeyCombo`는 Ctrl/Alt/Meta가 없는 조합(바 키·Shift-only)에 대해 반드시 `null`을 반환한다. 이 가드를 빼면 "a"·"1"·"Shift+1" 같은 항목이 일반 타이핑을 인터셉트해 본문 입력이 파괴된다.
- **예약 조합 제외**: `compileGlyphKeymap`은 `RESERVED_COMBOS`와 정확히 일치하는 항목을 반드시 버린다. 근거: Ctrl+Z/Ctrl+Y/Ctrl+D/Ctrl+F/Alt+Y/Alt+O/Alt+V(하드코딩 처리)와 Ctrl+A/C/X/V/B(브라우저·기업코드 예약)가 사용자 keymap에 조용히 가려지면 표준 편집이 죽는다.
- **순수·결정성**: React/DOM/window/document/localStorage/Date/타이머 미사용. 입력 `items`/`e`를 mutate하지 않는다. 동일 입력 → 동일 출력(단위 테스트가 결정적).
- **불투명 glyph**: glyph 문자열의 내용을 해석·변형하지 않는다(trim 외). 삽입 계산은 step1이 재사용하는 `insertGlyphAtCaret`가 담당.

### 테스트 — `web/src/view/editorGlyphKeymap.test.js`

최소 아래를 커버하라(vitest):
- **parseKeyCombo 정상**: `'Ctrl+1'` → `{ctrl:true,alt:false,shift:false,meta:false,key:'1'}`; `'ctrl+k'`(소문자) → key `'k'`, ctrl true; `'Ctrl+Shift+K'` → shift true·key `'k'`; `'Alt+2'` → alt true.
- **parseKeyCombo null**: `''`·공백·`'K'`(수식어 없음)·`'Shift+1'`(Shift-only)·`'Ctrl'`(키 없음)·`'Ctrl+A+B'`(키 2개) → 모두 `null`.
- **compile 제외**: 빈/공백 glyph 항목 제외; 파싱 실패 항목 제외; **예약 충돌** `{keys:'Ctrl+Z',glyph:'x'}`·`{keys:'Ctrl+F',glyph:'y'}`·`{keys:'Ctrl+D',glyph:'z'}`·`{keys:'Ctrl+A',glyph:'w'}`·`{keys:'Alt+O',glyph:'q'}` 전부 컴파일 결과에서 제외; 정상 `{keys:'Ctrl+1',glyph:'★'}`는 포함. **Ctrl+Shift+Z**(redo 예약)는 제외되나 **Ctrl+Shift+F**(비예약)는 포함되는지(shift 차이로 충돌 판정 정확).
- **matchGlyphKeymap 매칭**: compile(`[{keys:'Ctrl+1',glyph:'★'}]`) 후 `{ctrlKey:true,key:'1'}`·`{ctrlKey:true,code:'Digit1'}` → `'★'`; `{ctrlKey:true,shiftKey:true,key:'1'}`(shift 불일치) → `null`; 수식어 없는 `{key:'1'}` → `null`(빠른 탈출).
- **한영/레이아웃 견고성**: compile(`[{keys:'Ctrl+K',glyph:'§'}]`) 후 `{ctrlKey:true,code:'KeyK',key:'ㅏ'}`(한글 자모 e.key + 라틴 code) → `'§'`(code 경로로 매칭).
- **등록 순서 우선**: 같은 combo 2항목 → 먼저 등록된 glyph 반환.
- **입력 불변**: parse/compile/match 호출이 원본 items 배열·이벤트 객체를 바꾸지 않음.
- **RESERVED_COMBOS 잠금**: 최소 13개 예약 조합이 존재하고 각각 `compileGlyphKeymap([{keys:<그 조합 문자열>, glyph:'x'}])`가 빈 배열을 반환(스펙 L178 열거 회귀 방지).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(순수 클라이언트 로직 — 백엔드 무관. `npm test`(node --test)는 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `editorGlyphKeymap.js`가 순수 함수만 담고 React/DOM/window/localStorage/Date에 의존하지 않는가?(ADR-003, zero-dep)
   - `parseKeyCombo`가 수식어 없는/Shift-only 조합에 `null`을 반환하는가(실수식어 필수 — 타이핑 파괴 방지)?
   - `compileGlyphKeymap`이 `RESERVED_COMBOS` 충돌 항목과 빈 glyph를 제외하는가?
   - a–z/0–9 키가 `e.key`와 `e.code` 양쪽으로 매칭되는가(한영/레이아웃 견고성)?
   - 입력 mutate 없음·결정성이 테스트로 잠겨 있는가?
   - CLAUDE.md(DB 무관·client 전용·UTF-8 저장)?
3. 결과에 따라 `phases/38-editor-glyph-keymap/index.json`의 step0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (모듈 경로 `web/src/view/editorGlyphKeymap.js` · export `parseKeyCombo`/`compileGlyphKeymap`/`matchGlyphKeymap`/`RESERVED_COMBOS` · combo shape `{ctrl,alt,shift,meta,key}` · 실수식어 필수·예약 제외·e.key+e.code 매칭·빠른 탈출 규칙 · 테스트 수)를 한 줄 요약. **step1이 import 경로·시그니처·반환 shape·예약 정책을 알 수 있게 담아라.**
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 38 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- 수식어(Ctrl/Alt/Meta) 없는 조합이나 Shift-only 조합을 매칭 대상으로 만들지 마라. 이유: "a"/"1"/"Shift+1" 같은 항목이 일반 타이핑을 인터셉트해 본문 입력이 파괴된다(복구 불가 — 사용자가 글자를 못 침).
- `RESERVED_COMBOS` 충돌 항목을 컴파일 결과에 남기지 마라. 이유: 사용자 keymap이 Ctrl+Z/Ctrl+F/Ctrl+D/Ctrl+A/Ctrl+C 등 표준 편집을 조용히 가려 죽인다(섀도잉 금지 — 이 phase의 핵심 제약).
- 이 모듈에서 `insertGlyphAtCaret`/`editorContent`/`editorPrefs`를 import하거나 약물 삽입(블록/캐럿 계산)을 하지 마라. 이유: 이 step은 **매칭만** — 삽입은 step1이 기존 안전 경로(insertGlyphAtCaret → commitBody)를 재사용한다.
- React state/ref/effect·DOM·Date.now·타이머·localStorage를 이 모듈에 넣지 마라. 이유: 순수 매칭 모델이어야 단위 테스트가 결정적이고, keydown마다 재파싱하지 않고 step1이 컴파일 결과를 재사용할 수 있다.
- `WriterPage.jsx`·`Editor.jsx`·`editorShortcuts.js`·`EditorPrefsDialog.jsx`를 이 step에서 수정하지 마라. 이유: 이 step은 순수 모델 신설만 — 결선·onKeyDown 배치·useMemo는 step1이다.
- 기존 테스트를 깨뜨리지 마라.
