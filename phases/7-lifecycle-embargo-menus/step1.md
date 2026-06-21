# Step 1: eps-embargo-transition — EPS 엠바고 상태 전이 (송고 진입 + EEK/EEH)

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라(프로젝트 루트 기준):

- `/CLAUDE.md` — CRITICAL(DB 비파괴, TDD)
- `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — ADR-004(role/status 서버 도출), ADR-006(얇은 transport)
- `/docs/news.md` — "기사 생애주기" + "## 엠바고 규칙" 절. 특히:
  - "권한 D 사용자가 EPS 기사를 KILL 시에는 EEK가 된다."
  - "권한 D 사용자가 EPS 기사를 보류시에는 EEH가 된다."
  - "1차 엠바고 또는 2차 엠바고 기사의 시간이 설정되어있으면 해당 기사는 데스크 미송고에서 송고시 EPS가 된다."
- `src/services/lifecycle.js` — `transition`, `DESK_TABLE`(Z/D 공유), `REPORTER_TABLE`. **Step 0에서 `initialStatus`가 이미 일반화됨** — 그 위에서 작업한다.
- `src/services/articleService.js` — `applyAction(articleId, role, action, { userId })`(약 108~137줄). 현재: `transition(status, role, action)`으로 다음 status를 구하고, `action==='send'`면 `hasEndMarker` 가드 + sender/sentAt 기록 후 update + 이력 기록. `getById`가 돌려주는 `row.contents`에 `status`, `embargoAt`, `secondEmbargoAt`가 있다(CONTENTS_FIELDS 포함).
- `test/lifecycle.test.js`, `test/articleService.test.js`, `test/server.test.js` — 전이 데이터 주도 표와 통합 테스트(여기에 EPS 케이스를 추가).

이전 step(0)에서 일반화된 `initialStatus`와 전이표를 정독한 뒤 작업하라.

## 배경 / 설계 결정

새 스펙은 **EPS**(엠바고 송고 대기)와 그 후속 상태 **EEK/EEH**를 추가한다:
- 데스크 미송고(RDS) 기사를 **D/Z**가 **송고**할 때, **엠바고 시간이 설정**돼 있으면(1차 또는 2차) 결과가 DPS가 아니라 **EPS**가 된다.
- **EPS** 기사를 **D/Z**가 **KILL→EEK**, **보류→EEH**.

**설계 결정(확정)**:
1. EPS 후속 전이(EEK/EEH)는 순수 전이표로 표현 가능 → `DESK_TABLE`에 `EPS: { kill: 'EEK', hold: 'EEH' }` row 추가(Z는 DESK_TABLE 공유로 자동 적용). R에는 EPS row가 없어 EPS+R은 거부된다(정의 외 전이 거부 원칙 유지). EPS에 `send` 키를 넣지 마라 → EPS 재송고는 정의되지 않아 거부된다.
2. **EPS 진입(RDS→EPS)은 순수 `transition`으로 표현 불가**하다(엠바고 설정 여부를 `(status,role,action)`만으로 알 수 없음). → **`applyAction`에서 후처리**한다: `transition`은 순수하게 유지(RDS+D/Z+send는 여전히 DPS를 반환)하고, `applyAction`이 `status==='RDS' && (role==='D'||role==='Z') && action==='send' && 엠바고시간설정` 일 때 결과 status를 **DPS 대신 EPS**로 바꾼다. 엠바고 미설정이면 DPS 그대로(회귀 방지).
3. 엠바고 "시간 설정" 판정: `row.contents.embargoAt` 또는 `row.contents.secondEmbargoAt` 중 하나라도 **비어있지 않으면** 설정된 것으로 본다(빈 문자열/null/undefined = 미설정). 1차/2차/1+2차 유형은 두 컬럼의 set/unset 조합으로 도출되며 **별도 컬럼을 추가하지 마라**(DB 비파괴).

## 작업

TDD로 진행한다(테스트 먼저).

### 1. 전이표에 EPS 후속 전이 (`src/services/lifecycle.js`)

- `DESK_TABLE`에 `EPS: { kill: 'EEK', hold: 'EEH' }` 추가. (`send` 키 없음 — 재송고 미정의.)
- `REPORTER_TABLE`·`initialStatus`·`transition` 시그니처는 변경하지 마라. (`transition`은 여전히 순수 `(status,role,action)`.)

### 2. EPS 진입 후처리 (`src/services/articleService.js`의 `applyAction`)

- `transition` 호출 결과가 `ok` 이고 `action==='send'`인 경로에서, **RDS→DPS 결과를 엠바고 설정 시 EPS로 치환**한다:
  - 조건: `row.contents.status === 'RDS'` && `role ∈ {D,Z}` && `action==='send'` && `(embargoAt||secondEmbargoAt 설정)`.
  - 이 조건이면 저장·이력의 `toStatus`를 `'EPS'`로 한다. `hasEndMarker` 가드와 sender/sentAt 기록은 그대로 적용(EPS도 송고 결과이므로 송고자/송고시각 기록).
- 그 외(엠바고 미설정, R 등)는 기존 동작 보존(DPS 등).
- 이력(`record`)의 `toStatus`가 실제 저장된 최종 status(EPS 포함)와 일치하게 하라.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **`transition` 순수성 보존**: 엠바고 여부를 `transition`에 4번째 인자로 욱여넣지 마라(이 step의 결정은 applyAction 후처리). 이유: `transition`은 HTTP/DB 비의존 순수 함수이며 lifecycle.test.js가 그 계약에 의존한다.
2. **회귀 금지**: 엠바고 미설정 RDS 기사를 D/Z가 송고하면 여전히 **DPS**. R의 송고는 RDS. 기존 송고/보류/KILL 전이는 불변.
3. **정의 외 거부 유지**: EPS+send, EPS+R, EPS+approveDelete 등 정의하지 않은 조합은 `transition`이 `forbidden-transition`으로 거부해야 한다(EPS row에 kill/hold만 둔다).
4. **DB 비파괴(CLAUDE.md)**: 신규 컬럼 없이 `embargoAt`/`secondEmbargoAt` 재사용. status는 자유 텍스트(SQLite)라 스키마 마이그레이션 불필요. DROP/DELETE 없음.
5. **(끝) 마커 가드 유지**: EPS 진입도 send 경로이므로 `hasEndMarker` 미충족 시 `no-end-marker` 거부를 그대로 적용. **테스트 fixture 주의**: send 시나리오는 본문 `markupVersion`에 "(끝)" 마커가 있어야 가드를 통과해 전이 후처리에 도달한다 — `test/articleService.test.js` 상단의 `markup()`(또는 동등) 헬퍼로 마커 포함 본문을 만들어라(없으면 `no-end-marker`로 막혀 DPS/EPS에 도달 못 함).
6. **EPS 진입은 RDS 송고 한정**: `news.md`는 "데스크 미송고에서 송고시" EPS라고 한정한다 → 치환 대상은 `status==='RDS'`인 송고뿐이다. `DDH→send`(데스크 보류 후 송고)는 엠바고 설정 여부와 무관하게 **DPS 유지**(EPS로 바꾸지 마라 — 과확장 금지). DPS 재송고도 DPS 유지.

## Acceptance Criteria

```bash
npm test        # 전체 통과 (EPS 진입·EEK/EEH·거부조합·회귀보존 포함)
npm run lint    # ESLint 0
```

추가 단언:
- `transition('EPS','D','kill').status==='EEK'`, `transition('EPS','D','hold').status==='EEH'`, `transition('EPS','Z','kill').status==='EEK'`
- `transition('EPS','D','send').ok===false`, `transition('EPS','R','kill').ok===false`, `transition('EPS','D','approveDelete').ok===false` (정의 외 거부) — 가능하면 `lifecycle.test.js`의 DENIED(거부) 표에 행으로 추가해 표 기반 회귀 가드로 고정하라(ad-hoc 단언보다 우선).
- `applyAction`: 엠바고시간 설정된 RDS 기사를 D가 send → 저장 status `'EPS'`(이력 toStatus도 EPS, sender/sentAt 기록); 엠바고 **미설정** RDS 기사를 D가 send → `'DPS'`(회귀 보존)
- `applyAction`: **DDH** 기사를 D가 send(엠바고 설정돼 있어도) → `'DPS'` 유지(EPS 아님 — RDS 송고 한정)
- `applyAction`: EPS 기사 D kill → `'EEK'`, EPS 기사 D hold → `'EEH'`
- (가능하면) `test/server.test.js`에 동일 시나리오 통합 케이스 추가

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: 전이는 lifecycle, 엠바고 판정은 services(applyAction), transport 무변경(ADR-006). ADR-004·DB 비파괴 준수.
3. 결과에 따라 `phases/7-lifecycle-embargo-menus/index.json`의 step 1을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "EPS row·EEK/EEH·엠바고 송고 EPS 진입(applyAction 후처리)·판정조건 요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- `transition`에 엠바고 인자를 추가하지 마라. 이유: 순수성·기존 계약 위반. 엠바고 판정은 applyAction 후처리로 한다.
- 신규 status 컬럼/테이블을 추가하지 마라. 이유: status는 자유 텍스트라 불필요하고, 엠바고 유형은 두 시간 컬럼 조합으로 도출된다(DB 비파괴).
- 엠바고 **배부**(언론사/비언론사 실제 전송)는 이 step에서 구현하지 마라. 이유: 배부는 out-of-scope 시스템이다(CLAUDE.md). 이 step은 status 전이(EPS/EEK/EEH 진입)까지만.
- 엠바고 미설정 기사의 송고 결과(DPS)를 바꾸지 마라. 이유: 기존 데스크 송고 전이 회귀.
- 기존 테스트를 깨뜨리지 마라(엠바고 미설정 경로의 DPS 단언 등 보존).
