# Step 1: find-endmarker-guard

찾기/바꾸기가 "(끝)" 종료 마커 텍스트 블록을 치환 대상에서 제외하지 않아, 바꾸기 실행 시 **송고 마커가 훼손**되는 결함을 고친다. 형제 텍스트 도구들(약어변환·간체번체·약물·날짜)과 동일한 `END_MARKER` 가드를 `editorFind.js`에 적용한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — 프로젝트 규칙(DB 비파괴·TDD·conventional commits).
- `/docs/ARCHITECTURE.md` — 프론트 MVC, 순수 view 로직 계층.
- `/docs/ADR.md` — zero-dep 철학, TDD.
- `/docs/news.md` — 기사 에디터 "(끝)" 마커 규칙(164~167행), 송고 조건(72행: 본문에 "(끝)"가 없으면 송고 차단).
- `/web/src/view/editorFind.js` — **수정 대상**. `replaceAll`(약 96~116행: 현재 `if(b.type!=='text')return b;`로 임베드만 제외)과 `replaceAtMatch`(약 55~66행)가 END_MARKER 가드 없이 텍스트 블록을 치환한다.
- `/web/src/view/editorFind.test.js` — **수정 대상**. 신규 마커 보존 테스트를 추가한다.
- `/web/src/view/editorContent.js` — `END_MARKER` 상수 출처(약 8행: `export const END_MARKER = '(끝)';`)와 `hasEndMarker`(약 73행). import는 여기서 한다.
- `/web/src/view/abbrevConvert.js` — 형제 도구의 동일 가드 선례(약 62행: `if (!isTextBlock(block) || String(block.text).trim() === END_MARKER) return block;`).
- `/web/src/view/simpTradConvert.js` — 동일 가드 선례(약 45행).
- `/web/src/view/editorDate.js`, `/web/src/view/editorGlyph.js` — 동일 가드 선례(`String(b.text).trim() !== END_MARKER` 비교). 이 규칙과 동형으로 맞춰라.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경(결함 상세)

- 본문이 "(끝)"로 끝나는 상태(`... 본문\n(끝)`, 마커는 자기 줄의 독립 텍스트 블록)에서 '끝'→'끗' 또는 '('→'[' 같은 바꾸기를 실행하면 "(끝)" 블록의 텍스트가 훼손된다.
- 결과: `hasEndMarker(blocks)`(editorContent.js)가 `false`가 되어 이후 송고가 차단된다('본문에 "(끝)" 표시가 없어 송고할 수 없습니다'). 사용자는 마커가 훼손된 사실을 인지하지 못한다.
- 형제 텍스트 변환 도구(abbrevConvert/simpTradConvert/editorGlyph/editorDate)는 모두 `String(block.text).trim() === END_MARKER`인 블록을 스킵해 마커를 보존한다. 찾기/바꾸기만 이 가드가 빠져 있다.
- **알려진 표시-동작 트레이드오프(정상 — tester 오탐 주의):** WriterPage의 matchCount 표시·다음찾기 하이라이트는 `findMatches`(마커 포함 전체 텍스트)로 계산되므로, 마커 블록 안의 매치는 **셈·하이라이트에는 계속 잡힐 수 있다**. 그러나 이 step 수정 후 그 매치는 `replaceAll`/`replaceOne`에서 **치환되지 않는 것이 정상**(마커 무결성 우선)이다. 즉 "마커 매치로 이동 후 바꾸기가 no-op"은 버그가 아니라 의도된 안전 동작이다. 이 표시(findMatches)와 치환(replace 가드) 경로의 카운트 정합화는 이 step 범위 밖이며, 필요하면 별도 phase로 다룬다. `editorFind.js`의 `replaceAll`이 반환하는 `count`는 실제 치환한 매치만 세야 하고(마커 매치 제외), `findMatches`(표시용)는 이 step에서 바꾸지 않는다.

## 작업 (TDD — 테스트 먼저)

### 1) 테스트 먼저 작성 — `editorFind.test.js`

기존 테스트(약 71행 "keeps '(끝)' block intact" 등)는 매치가 마커 **밖**에 있어 우연히 통과한다. **매치가 마커 블록 안에 있는** 케이스를 추가한다:

- `replaceAll`: 입력 `[textBlock('한국은 끝났다'), textBlock('(끝)')]`, query `'끝'`, replacement `'끗'` 실행 시 → 마커 블록 `textBlock('(끝)')`은 **보존**되고(훼손 금지), 본문 블록의 '끝'만 치환됨을 단언한다. `count`는 마커 안 매치를 **세지 않음**을 단언한다(마커 밖 매치만 카운트).
- `replaceAll`: query `'('`, replacement `'['` 실행 시에도 `(끝)` 블록이 그대로 유지됨을 단언한다.
- `replaceOne`/`replaceAtMatch`: fromOffset을 마커 블록 위치로 두고 실행해도 "(끝)" 블록이 치환되지 않음(`replaced:false` 또는 마커 밖 다른 매치로 진행)을 단언한다.
- 기존 마커 밖 매치 테스트(약 71~90행, 124~157행)는 **그대로 유지되어 계속 통과**해야 한다.

### 2) 구현 — `editorFind.js`

- `END_MARKER`를 `editorContent.js`에서 import한다(형제 도구와 동일 출처·동일 비교).
- `replaceAll`의 `list.map` 콜백에서 임베드 제외(`b.type !== 'text'`)에 더해 **`String(b.text).trim() === END_MARKER`인 텍스트 블록도 치환 없이 그대로 반환**한다(형제 도구와 동일 규칙). 이 블록의 매치는 `count`에 포함하지 않는다.
- `replaceAtMatch`(및 이를 쓰는 `replaceOne`)에서도 대상 텍스트 블록이 END_MARKER면 치환하지 않는다. 구현 방법은 재량이다(예: `replaceAtMatch`에서 `blockIndex` 확정 후 `String(list[blockIndex].text).trim() === END_MARKER`면 `null` 반환, 또는 매치 선택 단계에서 마커 블록에 속한 매치를 후보에서 제외). 어떤 방식이든 아래 불변식을 만족해야 한다.

### 핵심 불변식(반드시 준수)

- `String(text).trim() === END_MARKER`인 텍스트 블록은 `replaceAll`·`replaceOne` 어느 경로로도 **절대 수정되지 않는다**.
- 마커 밖 텍스트 블록의 매치 동작(치환 결과·offset·caretOffset·count·블록 순서/개수 불변·입력 불변)은 **기존과 동일**하게 유지된다.
- `editorFind.js`는 순수 함수·DOM/transport 비의존을 유지한다(이 모듈에 부수효과를 추가하지 마라).

## Acceptance Criteria

```bash
npm run test:web   # 신규 마커 보존 테스트 + 전체 회귀 통과 (vitest, web 루트)
npm run build      # vite 프로덕션 빌드 에러 없음
npm run lint       # ESLint 위반 없음
```

모든 신규/수정 텍스트는 UTF-8로 저장하라(마커 문자 "(끝)" 포함).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `editorFind.js`가 순수 함수(DOM/transport 비의존)를 유지하는가?
   - `END_MARKER`를 `editorContent.js` 단일 출처에서 import했는가(형제 도구와 동일)?
   - CLAUDE.md 규칙(DB 비파괴·zero-dep)을 위반하지 않았는가?
3. 결과에 따라 `phases/27-editor-critical-fixes/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- `editorFind.js` 외 파일(WriterPage.jsx·FindReplaceDialog.jsx 등)을 수정하지 마라. 이유: 이 결함은 순수 엔진 계층의 가드 누락이며, UI 결선은 이미 이 엔진을 호출하므로 엔진만 고치면 된다. 파일 겹침을 만들면 step2·step3와 격리가 어려워진다.
- `END_MARKER` 문자열을 이 파일에 하드코딩하지 마라(`'(끝)'` 리터럴 재정의 금지). 이유: 형제 도구/`editorContent.js`와 출처가 갈라지면 마커 정의 변경 시 불일치가 생긴다 — 반드시 import한다.
- 마커 밖 매치의 count/offset/치환 결과 계산을 바꾸지 마라. 이유: 기존 회귀 테스트와 WriterPage 결선(matchCount 표시·caretOffset 진행 루프)이 이 동작에 의존한다.
- 서버/DB 스키마를 수정하지 마라. 이유: 순수 클라이언트 로직 결함이며 DB 비파괴 원칙을 지킨다.
- 새 npm 의존성을 추가하지 마라(zero-dep).
- 기존 테스트를 깨뜨리지 마라. 이유: 회귀 스위트가 하류 단계의 안전망이다.
