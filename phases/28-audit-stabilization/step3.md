# Step 3: date-insert-kst

에디터 도구>날짜 삽입(`tools.insertDate`)이 **UTC 기준 시각**을 삽입해 한국 표준시(KST, UTC+9)와 어긋난다. `WriterPage.insertDate`가 `new Date().toISOString()`(UTC)을 `applyDateFormat`에 넘기고, `applyDateFormat`은 문자열에서 시/분 숫자를 **그대로 추출**하므로 UTC 시각이 그대로 삽입된다. 날짜 삽입 입력을 **KST 벽시계 시각**으로 바꾼다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — 프로젝트 규칙(DB 비파괴·TDD·conventional commits).
- `/docs/ARCHITECTURE.md` — 프론트 MVC, 순수 view 로직 계층(ADR-003), 계층 분리.
- `/docs/ADR.md` — zero-dep·TDD. 비결정성(시각)과 순수 포맷팅의 분리 원칙(`editorDate.js` 주석에 명문화됨).
- `/docs/news.md` — 도구>날짜 삽입(182행), 환경설정 날짜형식 9종(206~207행), 시간 컬럼은 ISO-8601 UTC 저장(SCHEMA.md 48행).
- `/web/src/view/listFormat.js` — **수정 대상(순수 헬퍼 추가)**. `applyDateFormat(iso, format)`(약 25~36행): ISO 문자열을 정규식(`^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})`)으로 파싱해 `YYYY/MM/DD/HH/mm` 토큰을 **문자열 그대로** 치환한다 — 즉 넘어온 ISO의 시각이 곧 표시 시각이다. `DATE_FORMATS`(상단)·`formatCell`/`formatDateTime`(약 43~51행)도 확인하라.
- `/web/src/view/WriterPage.jsx` — **수정 대상(1줄 배선)**. `insertDate`(약 274~282행): `const dateString = applyDateFormat(new Date().toISOString(), fmt);`. 반드시 **현재 파일을 처음부터 정독**하라(step1/step2가 이미 이 파일을 손댔을 수 있다). `import { applyDateFormat } from './listFormat.js';`(약 49행)가 이미 있다.
- `/web/src/view/editorDate.js` — 참고(**수정 금지**). 상단 CRITICAL 주석: "비결정 시각(new Date)/포맷팅(applyDateFormat)은 이 모듈에서 호출하지 않는다 — 호출자(WriterPage)가 완성된 평문 dateString을 주입한다". 즉 비결정성은 WriterPage에, 순수 계산은 헬퍼에 둔다.
- `/web/src/view/listFormat.test.js`(있으면) 또는 동일 디렉토리 테스트 — **수정/신규 대상**. `applyDateFormat`의 기존 테스트 스타일을 따라 신규 순수 헬퍼 테스트를 추가한다. 파일이 없으면 `web/src/view/listFormat.test.js`로 신규 작성.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경(결함 상세)

- `new Date().toISOString()`은 항상 **UTC**를 돌려준다(예: KST 2026-07-10 15:30 → `2026-07-10T06:30:00.000Z`). `applyDateFormat`은 이 문자열의 `06:30`을 그대로 표시하므로 삽입 결과가 UTC(06:30)가 되어 KST(15:30)와 9시간 어긋난다.
- 한국은 DST가 없어 KST = UTC+9 **고정**이다. 따라서 타임존 오프셋 +9시간을 적용한 벽시계 문자열을 만들면 된다.
- **범위 한정**: 이 결함은 `insertDate`(에디터 삽입)에만 해당한다. `applyDateFormat` 자체와 목록 표시(`formatCell`/`formatDateTime`으로 `createdAt`/`editedAt`/`sentAt` 컬럼 표시)는 **건드리지 않는다** — 그 경로는 저장된 UTC ISO를 표시하는 별개 관심사이고, `applyDateFormat`을 강제 KST로 바꾸면 모든 목록 시각이 이동해 기존 표시 계약/테스트가 깨진다.

## 작업 (TDD — 테스트 먼저)

### 1) 테스트 먼저 작성 — `listFormat.test.js`

비결정성을 배제하기 위해 **epoch ms를 인자로 받는 순수 헬퍼**를 테스트한다(고정 입력 → 고정 출력):

- KST 경계 케이스: UTC `2026-07-10T00:00:00.000Z`(= `Date.parse('2026-07-10T00:00:00Z')`)를 입력하면 헬퍼가 KST 벽시계 `2026-07-10T09:00:00`(+9h)에 해당하는 ISO 문자열을 돌려줌을 단언한다.
- 날짜 넘김 케이스: UTC `2026-07-09T20:00:00.000Z`(KST로는 다음 날 05:00) 입력 → KST 날짜가 `2026-07-10`, 시각 `05:00`으로 나옴을 단언한다.
- `applyDateFormat(헬퍼(ms), 'YYYY-MM-DD HH:mm')`이 KST 문자열(예: `2026-07-10 09:00`)을 만듦을 단언해 **삽입 파이프라인 전체**를 검증한다.
- 기존 `applyDateFormat` 테스트가 있으면 **그대로 통과**해야 한다(순수 포맷 함수는 불변).

### 2) 구현

**listFormat.js (순수 헬퍼 추가):**
- KST 벽시계 ISO 문자열을 만드는 **순수 함수**를 export한다. 시그니처 예:
  ```js
  export const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // 한국 표준시 UTC+9(DST 없음)
  // epoch ms를 KST 벽시계 ISO 유사 문자열로 변환(순수·결정적). applyDateFormat이 이 문자열의 시각 숫자를 그대로 쓴다.
  export function kstIsoString(epochMs) {
    return new Date(epochMs + KST_OFFSET_MS).toISOString(); // +9h한 시각을 UTC로 읽으면 자릿수가 곧 KST 벽시계
  }
  ```
  - 원리: `epochMs + 9h`를 `toISOString()`(UTC 표기)로 읽으면 결과 문자열의 `YYYY-MM-DDTHH:mm`가 정확히 KST 벽시계다. `applyDateFormat`의 정규식과 호환된다.
  - 이 함수는 **결정적**(같은 `epochMs` → 같은 출력)이며 `new Date()`/`Date.now()`를 내부에서 부르지 않는다(비결정성은 호출자 몫).

**WriterPage.jsx (`insertDate` 1줄 배선):**
- `import { applyDateFormat, kstIsoString } from './listFormat.js';`(기존 import에 병합).
- `applyDateFormat(new Date().toISOString(), fmt)` → `applyDateFormat(kstIsoString(Date.now()), fmt)`로 교체한다. 비결정성(`Date.now()`)은 WriterPage에 남기고, KST 변환은 순수 헬퍼로 위임한다.
- `insertDate`의 나머지(캐럿·`insertDateAtCaret`·`commitBody`/`updateField('body', ...)`·`setPendingCaretLine`·`isMapping` 가드)는 **그대로 둔다**.

### 핵심 불변식(반드시 준수)

- 날짜 삽입 결과는 **KST 벽시계 시각**이다(UTC 아님). KST=UTC+9 고정.
- `kstIsoString`은 순수·결정적 함수다(내부에서 시각을 읽지 않음) — 단위 테스트가 고정 입력으로 검증 가능.
- `applyDateFormat`·`formatCell`·`formatDateTime`(목록 시간 컬럼 표시)은 **변경하지 않는다** — 이 step은 삽입 입력만 KST로 바꾼다.
- View/헬퍼는 transport 비의존을 유지한다(ADR-003).

## Acceptance Criteria

```bash
npm run test:web   # 신규 KST 헬퍼/삽입 파이프라인 테스트 + 전체 회귀 통과 (vitest, web 루트)
npm run build      # vite 프로덕션 빌드 에러 없음
npm run lint       # ESLint 위반 없음
```

모든 신규/수정 텍스트는 UTF-8로 저장하라.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - KST 변환이 **순수·결정적 헬퍼**로 분리됐는가(비결정성은 WriterPage `Date.now()`에만)?
   - `applyDateFormat`/목록 표시(`formatCell`/`formatDateTime`)를 바꾸지 않았는가(목록 시각 무회귀)?
   - `editorDate.js`(순수 삽입 계산)를 건드리지 않았는가?
3. 결과에 따라 `phases/28-audit-stabilization/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- `applyDateFormat`을 KST로 강제 변환하도록 바꾸지 마라. 이유: 이 함수는 목록의 `createdAt`/`editedAt`/`sentAt` 컬럼 표시(`formatCell`)에 공유된다 — 여기를 바꾸면 저장된 UTC를 표시하던 모든 목록 시각이 이동해 표시 계약/테스트가 깨진다. 삽입 **입력**만 KST로 만든다.
- `editorDate.js`(순수 삽입 계산)에 `new Date()`/타임존 로직을 넣지 마라. 이유: 그 모듈은 "완성된 dateString만 받는다"는 계층 분리를 명문화한다 — 비결정성/타임존은 호출자(WriterPage)·순수 헬퍼가 담당한다.
- `Intl`/외부 타임존 라이브러리에 의존해 복잡도를 키우지 마라. 이유: 한국은 DST가 없어 +9h 고정 오프셋이면 충분하고 zero-dep·결정적이다(테스트 용이).
- 서버/DB 스키마나 저장 포맷(시간 컬럼 UTC ISO)을 바꾸지 마라. 이유: 저장은 UTC ISO 유지가 맞다(SCHEMA.md 48행) — 이 결함은 **삽입 표시**만의 문제이며 DB 비파괴 원칙을 지킨다.
- 새 npm 의존성을 추가하지 마라(zero-dep).
- 기존 테스트를 깨뜨리지 마라(특히 `applyDateFormat`·목록 포맷 테스트). 이유: 회귀 스위트가 하류 단계의 안전망이다.
