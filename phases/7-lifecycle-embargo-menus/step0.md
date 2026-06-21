# Step 0: lifecycle-firstauthor-generalize — 최초 작성 보류 규칙 일반화

## 배경 / 요구사항

`docs/news.md` "기사 생애주기" 절이 최초 작성 보류 규칙을 **일반화**했다:

> - 권한 Z,D 사용자가 최초 작성시에 보류는 RDS가 아닌 DDH가 된다.
> - 권한 R 사용자가 최초 작성시에 보류는 RRH가 된다.

**현재 코드(이전 phase 6 결과)**: `src/services/lifecycle.js`의 순수 함수 `initialStatus(role, action)`는 `role==='Z' && action==='hold' → 'DDH', 그 외 → 'RDS'`만 구현돼 있다(Z만 특례). 서버 `POST /api/articles`는 세션 role + body.action을 `create(dto, { role, action })`로 넘기고, 프론트는 신규 저장 시 action을 전송한다(배관은 이미 완성).

**이 step의 목표**: `initialStatus`를 **(Z|D)+hold→DDH, R+hold→RRH, 그 외(모든 role의 send, 미지정 등)→RDS** 로 일반화한다. 이로써 phase 6의 'Z만' 특례를 흡수·대체한다. 배관(create 시그니처·라우트·프론트)은 그대로 두고 **규칙 함수만** 바꾼다. EPS/엠바고는 이 step에서 다루지 않는다(Step 1).

**핵심 단순화 기회(반드시 검토)**: 일반화하면 `initialStatus(role,'hold')`의 결과가 편집-컨텍스트 전이 `transition('RDS', role, 'hold')`와 **정확히 동일**해진다(Z/D는 DESK_TABLE의 RDS.hold='DDH', R은 REPORTER_TABLE의 RDS.hold='RRH'). 따라서 `initialStatus`는 hold일 때 `transition('RDS', role, 'hold')`의 결과를 재사용하고 그 외(send·미지정·거부조합)는 'RDS'로 흡수하는 **얇은 래퍼**로 수렴시키는 것을 우선 검토하라(중복 전이표 제거 = 단일 진실).

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라(프로젝트 루트 기준):

- `/CLAUDE.md` — CRITICAL(DB 비파괴, TDD)
- `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 레이어, ADR-004(role/status는 세션·서버에서만 도출), ADR-006(얇은 transport)
- `/docs/news.md` — "기사 생애주기" 절(특히 최초보류 일반화 두 줄과 권한별 전이표)
- `src/services/lifecycle.js` — `initialStatus`(현재 Z-only), `transition`, `DESK_TABLE`(Z/D 공유, RDS.hold='DDH'), `REPORTER_TABLE`(R, RDS.hold='RRH'), `ACTIONS` Set. 상단 주석(최초 송고=RDS는 create가 실현)도 정독.
- `src/services/articleService.js` — `create(dto, { role, action } = {})`가 `status: initialStatus(role, action)` 사용(약 66~78줄). `deriveArticle`이 `create(dto)`로 호출(2번째 인자 없음 → RDS)하는 부분(약 175줄)도 확인 — **건드리지 마라**.
- `test/lifecycle.test.js` — `initialStatus` 테스트와 `INITIAL_RDS` 데이터 주도 배열(약 L90~100). 이 배열은 `['D','hold']`·`['R','hold']`를 RDS로, `[undefined,'hold']`(미지정 role+hold)도 RDS로 단언한다. **D/R의 hold→RDS는 새 스펙과 충돌(갱신 대상)이나, `[undefined,'hold']→RDS`(거부 role 폴백)는 보존해야 한다.** (파일에 `ALLOWED`라는 심볼은 없다 — INITIAL_RDS 배열만 가리킨다.)
- `test/articleService.test.js` — `create`의 'Z 보류→DDH' 테스트(약 L37~41)와 'D 보류·R 보류·옵션없음→RDS' 회귀 가드(약 L44~54). **둘 다 갱신 대상.** create() 초기 status 설명 주석(약 L66~67, 'Z+hold만 DDH')도 동작 무변경으로 문구만 일반화.
- `test/server.test.js` — `POST /api/articles` 최초 상태 통합 테스트. **두 곳이 충돌(갱신 대상)**: ① L302~322 테스트(제목이 'Z+hold→DDH, 그 외 RDS', L314 주석 'D + action:hold → RDS (예외는 Z만)')의 **D+hold 기대값 + 제목 + 주석**, ② L324~333 'body.role/body.status는 초기 상태 결정에 쓰이지 않는다(ADR-004)' 테스트의 **R 세션+action:hold 기대값(L331 RDS)**.

## 작업

TDD로 진행한다. 충돌하는 회귀 가드를 **새 스펙 기대값으로 먼저 갱신**(red)한 뒤 구현(green).

### 1. `initialStatus` 일반화 (`src/services/lifecycle.js`)

```js
// 최초 작성(create) 시 초기 상태. 기본 RDS.
// 보류: (Z|D)→DDH, R→RRH. 송고/미지정 등은 RDS. (news.md "기사 생애주기")
// 편집-컨텍스트 transition('RDS',role,'hold')와 결과가 동일하므로 그 결과를 재사용해 한 표로 수렴한다.
export function initialStatus(role, action) // → 'RDS' | 'DDH' | 'RRH'
```

- 규칙: `action==='hold'`면 `transition('RDS', role, 'hold')`의 `status`를 반환(Z/D→DDH, R→RRH). transition이 거부({ok:false})하는 role(미지정/알 수 없는 role)·그 외 모든 action은 `'RDS'`.
- **거부하지 않는다** — 항상 유효한 상태 문자열을 반환한다(최초 저장은 항상 성공).
- `transition`/`DESK_TABLE`/`REPORTER_TABLE`은 **수정하지 마라**(이 step에선 규칙 함수만 바꾼다). EPS row 추가는 Step 1.

### 2. 충돌 테스트 갱신 (TDD-first)

- `test/lifecycle.test.js`: `initialStatus` 기대를 'Z+hold→DDH'에서 '(Z,D)+hold→DDH, R+hold→RRH'로 확장. `INITIAL_RDS` 배열(L90~100)에서 **D/R의 hold만** 제거/이동하고, **`[undefined,'hold']→RDS`(거부 role 폴백)는 보존**하라(무분별 삭제 금지 — 폴백 가드가 사라지면 회귀).
- `test/articleService.test.js`: `create(dto,{role:'D',action:'hold'})`→DDH, `{role:'R',action:'hold'}`→RRH로 갱신. `{role:'Z',action:'send'}`·`create(dto)`(인자없음)→RDS는 유지. create() 주석(L66~67)의 'Z+hold만 DDH' 문구를 '(Z|D)+hold→DDH, R+hold→RRH'로 갱신(주석만, 동작은 함수가 결정).
- `test/server.test.js`:
  - L302~322 테스트: 세션 D + `{action:'hold'}`→**DDH**, 세션 R + `{action:'hold'}`→**RRH**로 갱신. Z+send→RDS 유지. **테스트 제목과 L314 'D 케이스 (예외는 Z만)' 주석도 일반화 스펙에 맞게 정정**(예: '(Z|D)+hold→DDH, R+hold→RRH, send/그 외 RDS'). R+hold→RRH 통합 케이스를 추가하라.
  - L324~333 'body.role/body.status 무시(ADR-004)' 테스트: 현재 R 세션이 body로 `role:Z·status:DDH`를 보내고 `action:hold`로 RDS를 단언한다. R+hold→RRH 일반화로 **기대값을 RRH로 갱신**하되, **테스트의 ADR-004 의도(클라가 보낸 role:Z·status:DDH가 무시되고 세션 role R 기준으로 결정됨)는 보존**하라(제목/주석도 그에 맞게). 즉 'body.role:Z를 보냈는데도 세션 R 기준 RRH가 나온다'로 의미를 유지한다 — 일반화를 되돌리는 잘못된 수정을 하지 마라.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **CRITICAL(ADR-004)**: 초기 status는 세션 role + 의도 action으로 서버가 계산한다. `req.body.status`/`req.body.role`을 status 결정에 쓰지 마라. (라우트·create 배관은 이미 그러함 — 깨지 말 것.)
2. **회귀 금지**: 모든 role의 최초 **송고**(send)→RDS, `deriveArticle`(후속/계속)→RDS 유지. 바뀌는 것은 최초 **보류** 결과뿐이다(D/R).
3. **단일 진실**: 같은 규칙(RDS+role+hold)을 `initialStatus`와 `transition` 두 곳에 중복 구현하지 마라. 이유: 둘이 어긋나면 최초보류와 편집보류가 달라진다.
4. **DB 비파괴**: insert status 값만 분기. DROP/DELETE 없음.

## Acceptance Criteria

```bash
npm test        # 전체 통과 (initialStatus 일반화·갱신된 회귀 가드 포함)
npm run lint    # ESLint 0
```

추가 단언:
- `initialStatus('D','hold')==='DDH'`, `initialStatus('R','hold')==='RRH'`, `initialStatus('Z','hold')==='DDH'`
- `initialStatus('Z','send')==='RDS'`, `initialStatus('R','send')==='RDS'`, `initialStatus(undefined,undefined)==='RDS'`
- `create(dto,{role:'D',action:'hold'})` 저장 status `'DDH'`; `{role:'R',action:'hold'}` 저장 status `'RRH'`; `create(dto)` 저장 status `'RDS'`
- `POST /api/articles` 세션 D+`{action:'hold'}`→DDH, R+`{action:'hold'}`→RRH

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: ARCHITECTURE.md 구조(순수 함수=services), ADR-004 신뢰 경계, CLAUDE.md CRITICAL(TDD·DB 비파괴) 준수 여부.
3. 결과에 따라 `phases/7-lifecycle-embargo-menus/index.json`의 step 0을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "한 줄 요약(일반화 규칙·수렴 방식·갱신 테스트)"`
   - 3회 시도 후 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- `transition`/`DESK_TABLE`/`REPORTER_TABLE`을 이 step에서 수정하지 마라. 이유: EPS row 추가는 Step 1 범위이고, 편집 전이 회귀를 유발한다.
- `deriveArticle`을 수정하지 마라. 이유: 파생 기사는 항상 RDS(인자 없는 create 호출로 보장).
- `create`/라우트/프론트의 action 전달 배관을 바꾸지 마라. 이유: 이미 동작하며 이 step은 규칙 함수만 일반화한다.
- 기존 테스트를 무분별하게 지우지 마라 — **충돌하는 회귀 가드만** 새 스펙 기대값으로 갱신하고, 무관한 테스트는 보존하라.
