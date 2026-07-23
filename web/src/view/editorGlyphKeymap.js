// 사용자 키보드약물(glyphKeymap) 키조합 매칭 — 순수 모델 (news.md "사용자 키보드 약물").
// 환경설정에 자유입력 텍스트로 저장된 keys("Ctrl+1", "ctrl+k" 등 — EditorPrefsDialog가 trim만 하고 그대로 저장)를
// 정규화 combo로 파싱하고, keydown 이벤트를 그 combo와 대조해 매칭된 약물(glyph)을 돌려준다.
// 순수 함수만 — React/DOM/localStorage/editorPrefs 비의존. WriterPage 결선(삽입은 insertGlyphAtCaret 재사용)은 step1.
//
// 보수적 해석(스펙 미명세 지점 — 이 계약이 권위):
//  1. 실수식어 필수 — Ctrl/Alt/Meta 중 하나는 있어야 매칭 대상(바 키·Shift-only는 파싱 null).
//     수식어 없는 항목을 인터셉트하면 일반 타이핑이 파괴된다.
//  2. 예약 조합 무시 — RESERVED_COMBOS와 정확히 일치하는 항목, 그리고 상위 하드코딩 핸들러가 shift/meta를
//     무시하고(또는 Ctrl/Cmd를 동일 취급해) 삼키는 '느슨 변형'(아래 isSwallowedByReservedHandlers)은 컴파일에서
//     버린다 — 등록돼도 절대 발화할 수 없는 죽은 항목이 되므로 예약과 동일하게 무시한다.
//  3. a–z/0–9 키는 e.key(대소문자 무관)와 e.code(KeyK/Digit1) 병행 매칭 — 한글 입력 상태에서도 인식
//     (editorShortcuts의 code 병행 관례와 동일).
//  4. 수식어(Ctrl/Alt/Shift/Meta)는 정확 일치 — 문자열에 Shift를 쓰면 Shift 필수, 안 쓰면 Shift 없어야 매칭.
// 알려진 한계: 리터럴 '+' 키는 분리자와 구분 불가라 미지원(파싱 실패로 안전하게 제외된다).
// 수식어+Backspace/Delete 같은 명명 키 조합은 등록 시 keymap이 이긴다(명시 등록 우선) — 빈 줄의
// Ctrl+Backspace/Ctrl+Delete 삭제 별칭보다 keymap 분기가 앞서므로 그 별칭은 약물 삽입으로 대체된다.

// 수식어 토큰 별칭(소문자 비교) → 플래그 이름.
const MODIFIER_ALIASES = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
};

// 자유입력 'keys' 문자열 → 정규화 combo { ctrl, alt, shift, meta, key(소문자) }. 매칭 불가면 null.
export function parseKeyCombo(keys) {
  const s = String(keys ?? '').trim();
  if (s === '') return null;
  const tokens = s.split('+').map((t) => t.trim()).filter((t) => t !== '');
  const flags = {
    ctrl: false, alt: false, shift: false, meta: false,
  };
  const keyTokens = [];
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier) flags[modifier] = true;
    else keyTokens.push(token);
  }
  if (keyTokens.length !== 1) return null; // 키 토큰은 정확히 1개.
  if (!(flags.ctrl || flags.alt || flags.meta)) return null; // 실수식어 필수(Shift-only 불가).
  return {
    ctrl: !!flags.ctrl,
    alt: !!flags.alt,
    shift: !!flags.shift,
    meta: !!flags.meta,
    key: keyTokens[0].toLowerCase(),
  };
}

// 예약 조합(단일 출처) — news.md L178 우클릭 단축키(기업코드변환 Ctrl+B·잘라내기 Ctrl+X·복사 Ctrl+C·붙여넣기 Ctrl+V·
// 원본 붙여넣기 Alt+V·약물입력 Alt+O·찾기/바꾸기 Ctrl+F·전체 선택 Ctrl+A) + 편집 메뉴 하드코딩 단축키
// ((계속)삽입 Ctrl+Y·되돌리기 Ctrl+Z·다시실행 Ctrl+Shift+Z·한줄 지우기 Ctrl+D·(끝)삽입 Alt+Y — editorShortcuts.js).
// 사용자 keymap이 이들을 가리면 표준 편집이 조용히 죽으므로 compile 단계에서 정확히 일치하는 항목을 버린다.
export const RESERVED_COMBOS = Object.freeze([
  'Ctrl+B', 'Ctrl+X', 'Ctrl+C', 'Ctrl+V', 'Alt+V', 'Alt+O', 'Ctrl+F',
  'Ctrl+A', 'Ctrl+Y', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+D', 'Alt+Y',
].map((s) => Object.freeze(parseKeyCombo(s))));

// combo 정확 일치(ctrl/alt/shift/meta/key 모두 동일).
function comboEquals(a, b) {
  return a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift
    && a.meta === b.meta && a.key === b.key;
}

// 상위 하드코딩 핸들러(onKeyDown에서 keymap 분기보다 먼저 실행)가 shift/meta를 무시하거나 Ctrl/Cmd를 동일
// 취급해 삼키는 느슨 변형 — RESERVED 정확 일치는 통과해도 런타임에 발화 불가한 죽은 항목이 되므로 컴파일에서
// 함께 버린다. 조건은 editorShortcuts/editorFind predicate와 정확히 동형이어야 한다(넓히면 정상 조합 과차단):
//  - isFindReplace(Ctrl+F)·isInsertContinueMarker(Ctrl+Y)·isCompanyCode(Ctrl+B): ctrl && !alt, shift/meta 무시
//  - isInsertEndMarker(Alt+Y)·isGlyphInput(Alt+O)·isPasteOriginal(Alt+V): alt && !ctrl, shift/meta 무시
//  - isUndo/isRedo(Z): (ctrl||meta) && !alt, shift는 undo/redo가 양분 — 어느 쪽이든 삼킴
// (Ctrl+Alt+Y 같은 조합은 양쪽 predicate가 모두 배제하므로 예약이 아니다 — 정상 등록 가능.)
function isSwallowedByReservedHandlers(combo) {
  if (combo.ctrl && !combo.alt && (combo.key === 'f' || combo.key === 'y' || combo.key === 'b')) return true;
  if (combo.alt && !combo.ctrl && (combo.key === 'y' || combo.key === 'o' || combo.key === 'v')) return true;
  if ((combo.ctrl || combo.meta) && !combo.alt && combo.key === 'z') return true;
  return false;
}

// keymap items({keys, glyph}[]) → 컴파일된 매칭 항목 { combo, glyph }[] (등록 순서 보존 — 같은 combo면 먼저 등록이 우선).
// 제외: glyph 빈/공백, 파싱 실패(수식어 없음 포함), RESERVED_COMBOS 정확 일치, 예약 핸들러 느슨 변형.
export function compileGlyphKeymap(items) {
  if (!Array.isArray(items)) return [];
  const compiled = [];
  for (const item of items) {
    const glyph = String(item?.glyph ?? '').trim();
    if (glyph !== '') {
      const combo = parseKeyCombo(item?.keys);
      if (combo && !RESERVED_COMBOS.some((r) => comboEquals(r, combo))
        && !isSwallowedByReservedHandlers(combo)) {
        compiled.push({ combo, glyph });
      }
    }
  }
  return compiled;
}

// keydown 이벤트가 combo와 일치하는가 — 수식어 정확 일치 + 키 일치(a–z/0–9는 e.key·e.code 병행).
function comboMatchesEvent(combo, e) {
  if (!!e.ctrlKey !== combo.ctrl || !!e.altKey !== combo.alt
    || !!e.shiftKey !== combo.shift || !!e.metaKey !== combo.meta) {
    return false;
  }
  const k = combo.key; // 이미 소문자.
  if (/^[a-z]$/.test(k)) {
    return String(e.key).toLowerCase() === k || e.code === `Key${k.toUpperCase()}`;
  }
  if (/^[0-9]$/.test(k)) {
    return e.key === k || e.code === `Digit${k}` || e.code === `Numpad${k}`;
  }
  // 명명 키('f2'/'enter' 등) — e.key 소문자 비교 베스트에포트(code 매핑은 만들지 않는다).
  return String(e.key).toLowerCase() === k;
}

// keydown 이벤트 e를 컴파일 항목과 대조 → 첫 매칭 항목의 glyph 또는 null.
// 빠른 탈출: Ctrl/Alt/Meta가 하나도 없으면(수식어 없는 일반 타이핑) 스캔 없이 즉시 null.
export function matchGlyphKeymap(compiled, e) {
  if (!e || !(e.ctrlKey || e.altKey || e.metaKey)) return null;
  if (!Array.isArray(compiled)) return null;
  for (const entry of compiled) {
    if (comboMatchesEvent(entry.combo, e)) return entry.glyph;
  }
  return null;
}
