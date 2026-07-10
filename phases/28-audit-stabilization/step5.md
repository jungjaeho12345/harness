# Step 5: editor-prefs-autosave-validation

(선별 minor) `editorPrefs.js`의 `loadEditorPrefs`는 저장된 값을 기본값 위에 **얕게 병합**만 하고 타입/범위를 검증하지 않는다. localStorage가 손상돼 `autosave.intervalSec`가 `0`·음수·문자열(NaN)이면, `WriterPage`의 자동저장 effect가 `setInterval(fn, 0)`(또는 NaN)로 **타이트 루프**를 돌며 매 tick마다 localStorage에 초안을 써 성능/저장소를 파괴할 수 있다. 병합 시점에 autosave 필드를 **안전 범위로 정규화**한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — 프로젝트 규칙(DB 비파괴·TDD·conventional commits).
- `/docs/ARCHITECTURE.md` — 프론트 MVC, 클라이언트 로컬 상태(localStorage), 견고성(graceful).
- `/docs/ADR.md` — zero-dep·TDD.
- `/docs/news.md` — 자동저장 설정(195~197행: 저장 간격 30초~5분, 보존 기한 1~7일).
- `/web/src/view/editorPrefs.js` — **수정 대상**. `DEFAULT_EDITOR_PREFS.autosave`(약 10행: `{ enabled:false, intervalSec:60, retentionDays:1 }`), `readAll`(31~38행: JSON 파싱, 실패 시 `{}`), `loadEditorPrefs`(40~53행: **얕은 한 단계 병합** — `autosave: { ...DEFAULT.autosave, ...(saved.autosave||{}) }`로 손상값이 그대로 통과). `dateFormat`은 이미 `typeof === 'string'` 검증이 있음(51행) — **부분 검증 선례**로 참고.
- `/web/src/view/WriterPage.jsx` — **참고(수정 금지)**. 자동저장 effect(약 225~237행): `if (!autosaveCfg.enabled) return; const ms = autosaveCfg.intervalSec * 1000; setInterval(..., ms)`. `autosaveCfg`는 `useState(() => loadEditorPrefs().autosave)`(약 158행)로 주입된다 → **loadEditorPrefs에서 정규화하면 소비자(WriterPage)를 손대지 않고 근본에서 차단**된다.
- `/web/src/view/editorPrefs.test.js`(또는 동일 디렉토리 테스트) — **수정/신규 대상**. `dateFormat` 검증·부분 병합 테스트 스타일을 따른다. 파일이 없으면 신규 작성. localStorage 스텁이 필요하면 기존 테스트의 방식을 재사용하라.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경(결함 상세)

- `loadEditorPrefs`의 autosave 병합은 `saved.autosave`의 값을 무검증 통과시킨다. 손상 예: `intervalSec:0`(→ `setInterval(fn,0)` 타이트 루프), `intervalSec:-5`(음수), `intervalSec:'x'`(→ `NaN*1000=NaN` → 즉시/불규칙 실행), `enabled:'yes'`(문자열 truthy), `retentionDays:0`/음수(→ `expireDrafts`가 방금 저장한 초안을 즉시 만료).
- 소비자(WriterPage 자동저장 effect)는 이 값을 그대로 `setInterval`/`expireDrafts`에 넘긴다. 근본 방어 위치는 **단일 출처인 loadEditorPrefs**다(소비자마다 방어하면 중복·누락).
- news.md 195~197행이 유효 범위를 정의한다(간격 30초~5분, 보존 1~7일). 손상값은 이 범위/타입으로 클램프/폴백한다.

## 작업 (TDD — 테스트 먼저)

### 1) 테스트 먼저 작성 — `editorPrefs.test.js`

localStorage에 손상된 prefs를 심고 `loadEditorPrefs()`가 안전값을 돌려줌을 단언한다(테스트는 `saveEditorPrefs` 또는 localStorage 직접 주입으로 seed):

- `autosave.intervalSec: 0` → 결과 `intervalSec`가 **양수(0 초과)**임을 단언(기본값 60 또는 최소 허용값으로 폴백).
- `autosave.intervalSec: -5` → 양수로 폴백.
- `autosave.intervalSec: 'abc'`(비수치) → 양수 기본값으로 폴백(NaN 아님).
- `autosave.retentionDays: 0`/`-1`/비수치 → **양수**(기본 1 또는 최소 1)로 폴백.
- `autosave.enabled: 'yes'`(비불리언) → 결과가 **boolean**임을 단언(정규화).
- **정상값 보존**: `autosave: { enabled:true, intervalSec:120, retentionDays:3 }`는 그대로 유지됨을 단언(정상 설정을 훼손하지 않음).
- **회귀 가드**: 저장값이 아예 없을 때(`{}`) 기존처럼 `DEFAULT_EDITOR_PREFS.autosave`가 나오고, `dateFormat` 등 다른 필드의 기존 병합/검증이 그대로 통과함을 단언한다.

### 2) 구현 — `/web/src/view/editorPrefs.js` (`loadEditorPrefs`)

- autosave 병합 결과를 정규화하는 로직을 추가한다(별도 순수 헬퍼 `normalizeAutosave(saved)`로 빼면 테스트·재사용이 쉽다). 규칙:
  - `enabled` → `=== true`로 강제(boolean). 비불리언/undefined는 기본값(`false`).
  - `intervalSec` → 유한 양수(`Number.isFinite(n) && n > 0`)일 때만 채택, 아니면 `DEFAULT_EDITOR_PREFS.autosave.intervalSec`(60)로 폴백. (원하면 news.md 범위로 클램프해도 되나 **최소 요구는 "양수 보장"**이다.)
  - `retentionDays` → 유한 양수일 때만 채택, 아니면 기본값(1)로 폴백.
- `dateFormat`의 기존 검증(51행)처럼 **부분 검증 선례**와 동형으로 둔다. 다른 카테고리(colors/edit/spellcheck 등)의 병합은 이 step에서 바꾸지 않는다(scope 최소화).
- `saveEditorPrefs`/`setEditorPref`의 시그니처·동작은 바꾸지 않는다.

### 핵심 불변식(반드시 준수)

- `loadEditorPrefs().autosave.intervalSec`는 **항상 유한 양수**다(어떤 손상 입력에도 `0`·음수·NaN·문자열이 아님).
- `loadEditorPrefs().autosave.retentionDays`는 **항상 유한 양수**다.
- `loadEditorPrefs().autosave.enabled`는 **항상 boolean**이다.
- 정상 범위의 저장값은 훼손 없이 그대로 유지된다.
- autosave 외 카테고리(colors/byline/edit/spellcheck/glyph*/dateFormat)의 기존 병합·검증 동작은 **불변**이다.
- `editorPrefs.js`는 순수·localStorage graceful(접근 불가 시 `{}`)를 유지한다.

## Acceptance Criteria

```bash
npm run test:web   # 신규 autosave 정규화 테스트 + 전체 회귀 통과 (vitest, web 루트)
npm run build      # vite 프로덕션 빌드 에러 없음
npm run lint       # ESLint 위반 없음
```

모든 신규/수정 텍스트는 UTF-8로 저장하라.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 정규화를 **단일 출처(loadEditorPrefs)**에 두어 소비자(WriterPage)를 손대지 않았는가?
   - autosave 외 카테고리의 기존 병합을 바꾸지 않았는가(무회귀)?
   - localStorage graceful·순수성을 유지했는가?
3. 결과에 따라 `phases/28-audit-stabilization/index.json`의 step 5를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- WriterPage 자동저장 effect에 방어 코드를 넣어 해결하지 마라. 이유: 근본 방어 위치는 단일 출처 `loadEditorPrefs`다 — 소비자마다 방어하면 중복·누락되고 다른 step과 파일이 겹친다.
- autosave 외 카테고리(colors/edit/spellcheck 등)의 병합·검증을 바꾸지 마라. 이유: scope 최소화 — 이 결함은 autosave 수치 손상뿐이다.
- 정상 범위의 저장값을 임의로 덮어쓰지 마라. 이유: 사용자가 설정한 유효값(예: 간격 120초)을 훼손하면 안 된다 — 손상·비수치만 폴백한다.
- 손상 시 사용자 저장값을 localStorage에서 삭제/재기록하지 마라. 이유: 읽기 시 정규화만 하면 충분하고, 저장 데이터를 파괴하지 않는다(DB 비파괴 정신과 동형).
- 서버/DB 스키마를 수정하지 마라. 이유: 순수 클라이언트 localStorage 설정 결함이다.
- 새 npm 의존성을 추가하지 마라(zero-dep).
- 기존 테스트를 깨뜨리지 마라(특히 dateFormat 검증·부분 병합 테스트). 이유: 회귀 스위트가 하류 단계의 안전망이다.
