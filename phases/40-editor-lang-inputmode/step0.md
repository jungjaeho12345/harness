# Step 0: euckr-byte-model

환경설정 편집 탭의 **입력모드(KSC-5601/Unicode)** 설정을 상태표시줄 Byte 표시에 반영하기 위한 **순수 모델**을 만든다. 이 step은 EUC-KR 기준 바이트 수를 **결정적 코드포인트 범위 근사**로 계산하는 zero-dep 순수 함수만 만든다. 상태표시줄 결선·UI는 이후 step(2·3)이다.

`TextEncoder`는 EUC-KR을 지원하지 않으므로(브라우저/Node 표준은 UTF-8 전용) **직접 범위 규칙으로 근사**한다. 정밀 KS X 1001 전수 테이블(완성형 한글 2350자·한자 4888자) 재현은 과잉이며, 아래에 못박은 블록 범위 근사를 **정확히 그대로** 구현한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md` — ADR 철학(외부 의존성 최소화·언어/런타임 표준 우선·TDD·zero-dep). 이 모듈은 그 철학의 직계다.
- `docs/news.md` L160(상태표시: 워드수·Byte·N단락N행N열·삽입/수정·언어), L198(환경설정 편집 탭 입력모드: KSC-5601 모드 / Unicode 모드).
- `web/src/view/editorStats.js` — 기존 `byteLength(text)`(UTF-8, `new TextEncoder().encode`)와 `charCount`(`[...String(text)]` 코드포인트 전개 — **surrogate-safe 순회 선례**). **이 파일은 이 phase에서 변경하지 않는다**(EUC-KR은 별도 모듈). Unicode 모드 바이트는 이후 step이 이 `byteLength`를 그대로 쓴다.
- `web/src/view/editorSpellHighlight.js` — phase 39가 만든 순수·zero-dep 모듈의 헤더 주석/테스트 스타일(계약을 주석과 테스트로 문서화). 이 step의 서술 톤을 맞춰라.

## 배경 (자기완결)

상태표시줄은 현재 `editorStats.byteLength`(UTF-8)만 표시한다. 입력모드 설정은 phase 16에서 `edit.inputMode`(`'unicode'` 기본, 허용값 `'unicode' | 'ksc5601'`)로 **저장만** 되어 있고 소비처가 없다. 이 phase는 KSC-5601 모드일 때 상태표시줄 바이트를 EUC-KR 기준으로 바꾸고, 인코딩 **비호환 문자 개수**를 병기한다. 이 step은 그 계산의 순수 함수만 만든다.

### 신규 파일: `web/src/view/editorEncoding.js`

zero-dep 순수 모듈. export는 아래 2개다.

```js
// 입력모드 정규화 — 미지원/구값/undefined는 'unicode'로 폴백. 허용값은 'ksc5601' | 'unicode'.
export function normalizeInputMode(mode) // → 'ksc5601' | 'unicode'

// EUC-KR(KS X 1001) 기준 바이트 수 근사 + 인코딩 비호환 문자 개수를 한 번의 순회로 계산.
export function euckrStats(text) // → { bytes: number, incompatible: number }
```

### `euckrStats` 계약 (못박음 — 이 규칙을 정확히 그대로 구현)

`String(text ?? '')`를 **코드포인트 단위로 순회**한다(`for (const ch of str)` 또는 `[...str]` — surrogate pair를 한 코드포인트로 다뤄 이모지/비BMP가 두 번 세지지 않게). 각 코드포인트 `cp = ch.codePointAt(0)`를 아래 3분류로 판정한다:

1. **ASCII (1바이트)** — `cp <= 0x7F`. 제어문자·개행(`\n`, cp `0x0A`)·공백·출력 가능 ASCII 전부 포함. `bytes += 1`.
   - 근거: UTF-8 `byteLength`도 ASCII·`\n`을 1B로 센다(상태표시줄 text는 `blocksToText`가 줄을 `\n`으로 이은 문자열이라 개행이 바이트에 포함됨). 두 모드의 ASCII 파트를 정합시킨다.
2. **EUC-KR 표현 가능 근사 (2바이트)** — `cp`가 아래 **포함 범위(경계 포함)** 중 하나면 `bytes += 2`:
   - `0x0370`–`0x03FF` (그리스 문자)
   - `0x0400`–`0x04FF` (키릴 — 러시아어 등)
   - `0x1100`–`0x11FF` (한글 자모)
   - `0x3000`–`0x303F` (CJK 기호·구두점 = 전각 기호)
   - `0x3040`–`0x30FF` (히라가나·가타카나)
   - `0x3130`–`0x318F` (한글 호환 자모)
   - `0x4E00`–`0x9FFF` (CJK 통합 한자)
   - `0xAC00`–`0xD7A3` (한글 음절 = 완성형)
   - `0xF900`–`0xFAFF` (CJK 호환 한자)
   - `0xFF00`–`0xFFEF` (반각·전각 형태)
3. **비호환 (0바이트 + 카운트)** — 위 어디에도 안 들면 `incompatible += 1`(바이트는 더하지 않음). 이모지·비BMP(`cp > 0xFFFF`)·라틴 확장(스페인 é/ñ·프랑스 ç·베트남 성조 결합)·아랍/태국 등 — EUC-KR로 인코딩 불가한 문자.

**바이트 총합의 의미(못박음)**: `bytes`는 EUC-KR로 **인코딩 가능한 문자의 바이트 합**이다. 비호환 문자는 바이트에 **0을 기여**하고 `incompatible` 카운트만 올린다. 이유: 바이트 총합은 "실제로 인코딩되는 페이로드 크기", 카운트는 "손실될 문자 신호"로 역할을 분리한다 — 사용자가 KSC-5601 저장 시 잘려나갈 문자를 바로 인지하게 한다. (비호환을 대체문자 1~2B로 세지 마라 — 데이터 손실을 숨긴다.)

**근사임을 문서화**: 모듈 헤더 주석에 "KS X 1001 전수 테이블이 아니라 블록 범위 기반 실용 근사"임과 위 범위 목록을 명시하고, 테스트가 이 근사를 대표 문자로 잠근다. 완성형 한글 전 범위(`0xAC00`–`0xD7A3`)를 2B로 보는 것은 EUC-KR 실제 수록분(2350자)보다 넓은 과대근사이며 **의도된 것**이다.

**언어 설정과의 독립(혼동 방지)**: 환경설정 '언어'(9종, step1)는 라벨/lang 속성 전용이며 이 바이트 판정과 **완전 독립**이다 — 언어를 스페인/프랑스/아랍/베트남으로 설정한 문서를 KSC-5601 모드로 보면 해당 문자가 비호환 카운트로 뜨는 것이 **정상 동작**(EUC-KR 인코딩 불가 사실의 반영)이다. 언어 설정에 따라 판정 범위를 바꾸지 마라.

`normalizeInputMode`: `mode === 'ksc5601'`이면 `'ksc5601'`, 그 외 전부(`'unicode'`·`undefined`·`''`·미지원 문자열) `'unicode'`.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

1. `web/src/view/editorEncoding.test.js`(vitest)를 먼저 작성한다. 최소 아래 케이스를 포함하라(값은 위 계약에서 결정적으로 도출):
   - `euckrStats('')` → `{ bytes: 0, incompatible: 0 }`.
   - `euckrStats('abc')` → `{ bytes: 3, incompatible: 0 }`(ASCII).
   - `euckrStats('한글')` → `{ bytes: 4, incompatible: 0 }`(음절 2 × 2B).
   - `euckrStats('가A나')` → `{ bytes: 5, incompatible: 0 }`(2+1+2).
   - `euckrStats('日本語')` → `{ bytes: 6, incompatible: 0 }`(CJK 한자).
   - `euckrStats('あ')` → `{ bytes: 2, incompatible: 0 }`(히라가나).
   - `euckrStats('한\n글')` → `{ bytes: 5, incompatible: 0 }`(2 + `\n` 1 + 2 — 개행은 ASCII 1B).
   - `euckrStats('a😀')` → `{ bytes: 1, incompatible: 1 }`(😀 U+1F600 비BMP → 비호환 0B, surrogate pair를 한 번만 카운트).
   - `euckrStats('café')` → `{ bytes: 3, incompatible: 1 }`(c,a,f ASCII; é U+00E9 비호환).
   - `euckrStats('Ру')` → `{ bytes: 4, incompatible: 0 }`(키릴 2 × 2B — 러시아어).
   - `normalizeInputMode('ksc5601')` → `'ksc5601'`; `normalizeInputMode('unicode')`/`normalizeInputMode(undefined)`/`normalizeInputMode('xxx')` → `'unicode'`.
2. `web/src/view/editorEncoding.js`를 구현해 테스트를 통과시킨다. 입력을 mutate하지 말고(순수), 외부 의존성 0(다른 모듈 import 금지 — `editorStats`도 import하지 마라, 이 모듈은 EUC-KR 전용).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(client 전용 — 백엔드 `npm test`는 실행 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다(전부 green).
2. 아키텍처 체크리스트:
   - `editorEncoding.js`가 zero-dep 순수 함수인가?(다른 모듈 import 0·DOM 비의존·입력 비파괴)
   - `editorStats.js`·`StatusBar.jsx`·`Editor.jsx`가 diff에 **없는가**?(이 step은 신규 모듈 + 신규 테스트뿐)
   - ADR 철학(표준 기능·zero-dep·TDD)·CLAUDE.md(client 전용·DB 무관·UTF-8 인코딩) 준수?
3. 결과에 따라 `phases/40-editor-lang-inputmode/index.json`의 step0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (신규 `editorEncoding.js`·export 2개·EUC-KR 근사 범위 규칙·비호환=0B+카운트·테스트 케이스 수)를 한 줄 요약.
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 40 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- `web/src/view/editorStats.js`의 `byteLength`(UTF-8)를 바꾸지 마라. 이유: Unicode 모드 상태표시줄과 도구>파일 정보 다이얼로그('UTF-8 바이트' 라벨 항목)가 이 함수를 공유한다 — EUC-KR은 별도 모듈이어야 두 소비처가 불변으로 남는다.
- 비호환 문자를 대체문자 1~2바이트로 세지 마라. 이유: 계약상 바이트 총합은 인코딩 가능분만이고, 손실 문자는 별도 카운트로 노출해 데이터 손실을 숨기지 않는다.
- `for...of`/스프레드 대신 `for (i; ...) str[i]`(UTF-16 코드유닛 인덱싱)로 순회하지 마라. 이유: surrogate pair(이모지·비BMP)가 두 코드유닛으로 쪼개져 비호환 카운트가 2배가 되고 바이트 판정이 깨진다 — `editorStats.charCount`와 동일한 코드포인트 순회를 쓴다.
- 위에 못박은 2바이트 범위 목록을 임의로 늘리거나 줄이지 마라(특히 라틴 확장 é/ñ/ç·아랍·태국을 2B로 넣지 마라). 이유: 규칙이 결정적이어야 테스트가 계약을 잠글 수 있고, 라틴 확장을 인코딩 가능으로 보면 실제 EUC-KR 손실을 감춘다.
- 기존 테스트를 깨뜨리지 마라.
