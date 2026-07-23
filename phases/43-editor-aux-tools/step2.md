# Step 2: company-code-shortcut

Ctrl+B(기업코드변환) 키 인식 predicate를 추가하고, 사용자 키보드약물 컴파일러가 그 예약 조합의 **느슨 변형까지** 죽은 항목으로 걸러내도록 동형 반영한다. 순수 모델 두 곳(editorShortcuts.js·editorGlyphKeymap.js)만 바꾼다 — WriterPage 결선은 step 3.

## 읽어야 할 파일

- `/docs/news.md` L178(우클릭 "기업코드변환 Ctrl+B").
- `web/src/view/editorShortcuts.js` — 키 predicate 형태. 특히 `isDeleteLine(e)`(`ctrl && !alt`, key `d`/code `KeyD`), `isInsertContinueMarker(e)`(`ctrl && !alt`, key `y`), `isFindReplace`(editorFind, `ctrl && !alt`)의 형태. **`isCompanyCode`는 이 family와 동형(shift/meta 무시)** 으로 만든다.
- `web/src/view/editorGlyphKeymap.js` — `RESERVED_COMBOS`(이미 `'Ctrl+B'` 포함, L61-64), `comboEquals`, `isSwallowedByReservedHandlers(combo)`(L79-84), `compileGlyphKeymap`. 특히 L80 `if (combo.ctrl && !combo.alt && (combo.key === 'f' || combo.key === 'y')) return true;` — Ctrl+F/Ctrl+Y의 느슨 변형(shift/meta 무시)을 걸러내는 줄. **여기에 `'b'`를 동형으로 추가**한다.
- (참고) phase 38 교훈: 상위 하드코딩 핸들러가 shift/meta를 무시하고 삼키는 조합은 keymap에서 발화 불가한 죽은 항목이 되므로, predicate와 **정확히 동형**으로 `isSwallowedByReservedHandlers`에 반영해야 한다.

## 작업

### 1. `web/src/view/editorShortcuts.js` — `isCompanyCode` 추가

- `export function isCompanyCode(e)` 추가. 형태는 `isInsertContinueMarker`(Ctrl+Y)와 동형:
  - `return !!(e && e.ctrlKey && !e.altKey && (e.key === 'b' || e.key === 'B' || e.code === 'KeyB'));`
  - 즉 **`ctrl && !alt`, shift/meta는 무시**(Ctrl+B·Ctrl+Shift+B·Ctrl+Meta+B 모두 인식). 레이아웃 무관하게 `code === 'KeyB'`도 본다(한글 입력 상태 대응 — editorShortcuts의 code 병행 관례).
- 주석으로 의미(Ctrl+B — 본문 기업코드 변환, 브라우저 contentEditable 기본 bold와 충돌하므로 결선부에서 preventDefault 필요)를 남긴다.

### 2. `web/src/view/editorGlyphKeymap.js` — 느슨 변형에 `'b'` 추가

- `isSwallowedByReservedHandlers(combo)`의 `ctrl && !alt` 분기(현재 `f`/`y`)에 `'b'`를 추가한다:
  - `if (combo.ctrl && !combo.alt && (combo.key === 'f' || combo.key === 'y' || combo.key === 'b')) return true;`
- 주석(L75 부근)의 predicate 열거에 `isCompanyCode(Ctrl+B): ctrl && !alt, shift/meta 무시`를 한 줄 추가해 근거를 남긴다.
- `RESERVED_COMBOS`에는 `'Ctrl+B'`가 이미 있으므로 그 배열은 건드리지 않는다(정확 일치는 이미 제외됨 — 이번엔 느슨 변형만 보강).

## 반드시 지킬 핵심 규칙

- **동형성**: `isCompanyCode`가 shift/meta를 무시하면(위 정의) `isSwallowedByReservedHandlers`의 `b` 분기도 정확히 `ctrl && !alt`(shift/meta 무시)여야 한다. 이유: predicate가 삼키는데 컴파일러가 살려두면 Ctrl+Shift+B 등록이 런타임에 발화 불가한 죽은 항목이 된다(phase 38 결함). 넓히지도(정상 조합 과차단) 좁히지도(죽은 항목 잔존) 마라.
- **Ctrl+Alt+B는 예약 아님**: `isCompanyCode`가 `!alt`이므로 Ctrl+Alt+B는 삼키지 않는다 → keymap 등록 가능해야 한다(느슨 변형에도 넣지 마라).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 테스트(작성/보강):
   - `editorShortcuts.test.js`(있으면 보강, 없으면 신규): `isCompanyCode`가 Ctrl+B(key 'b'/'B', code 'KeyB')·Ctrl+Shift+B에 true, Alt+B·Ctrl+Alt+B·일반 'b'에 false.
   - `editorGlyphKeymap.test.js`: `compileGlyphKeymap([{keys:'Ctrl+B', glyph:'★'}])`가 빈 배열(정확 일치 제외 — 기존 유지). `compileGlyphKeymap([{keys:'Ctrl+Shift+B', glyph:'★'}])`도 빈 배열(느슨 변형 제외 — 이번 추가). `compileGlyphKeymap([{keys:'Ctrl+Alt+B', glyph:'★'}])`는 1개 유지(예약 아님).
3. 아키텍처 체크: 두 파일 모두 순수 모델(React/DOM 비의존).
4. `phases/43-editor-aux-tools/index.json`의 step 2를 갱신한다.

## 금지사항

- WriterPage `onKeyDown`에 Ctrl+B 핸들러를 이 step에서 붙이지 마라. 이유: 결선은 step 3(view). 이 step은 순수 predicate/컴파일러만.
- `RESERVED_COMBOS` 배열을 수정하지 마라. 이유: `'Ctrl+B'`는 이미 있고, 느슨 변형 처리는 `isSwallowedByReservedHandlers`의 책임이다(단일 출처 혼선 방지).
- `isCompanyCode`를 `shift` 필수/금지로 좁히지 마라. 이유: family(Ctrl+F/Ctrl+Y)와 동형(shift 무시)이어야 컴파일러 동형 반영이 일관된다.
- 기존 테스트를 깨뜨리지 마라(web 1753 기준).
