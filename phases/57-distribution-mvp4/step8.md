# Step 8: distmgmt-page

## 목표

배부 대상 관리페이지(`distMgmt.do`, Z 전용)에 운영 화면 2종을 얹는다.

1. **미해소 배부 실패 목록** + 행별 **재전송** 버튼.
2. **수동 tick 실행** 버튼 + 실행 결과 요약(스캔/배부/실패 건수).

View 계층 1파일만 다룬다.

## 읽어야 할 파일

- `docs/ADR.md` **ADR-008 (3)**(시점 배부는 외부 cron의 tick pull — 앱 내 타이머 금지)·**ADR-004**(프론트 가드는 UX, 인가는 서버). **읽기 전용(무접촉)**.
- `docs/UI_GUIDE.md` — `yh-` 디자인 시스템 클래스 사용 규약(새 CSS 도입 전에 기존 클래스를 먼저 찾는다).
- `web/src/view/DistMgmtPage.jsx` 전체(147줄) — 폼·표 구조, `KIND_LABEL`(미지의 값은 원문 그대로), `reasonMessage`(모듈 스코프 1회 생성), 진입 조회 effect의 `alive` 가드, `submitting` in-flight 가드, "확인 대화상자를 두지 않는다"(되돌릴 수 있는 조작) 판단 근거.
- `web/src/view/mgmtMessages.js` 전체 — `createReasonMessage(extra)`의 판정 순서(비문자열 → extra → 공통 → 미지 토큰 노출).
- `web/src/controller/useDistMgmtController.js`(step7 결과) — `failures`/`refreshFailures`/`retryTarget`/`runTick`.
- `web/src/view/DistMgmtPage.test.jsx` — 테스트 하네스(`setup(seed, identity, prepare)` + `AppContext` + `createFakeModel`).
- `web/src/view/listFormat.js` — `formatDateTime(iso)`(실패 시각 표시에 재사용).
- `src/services/distributionRetryService.js`(step3) — 실패 항목 필드와 거부 사유 토큰 전체(문구 매핑의 입력).
- `src/services/distributionTickService.js` L91~95 — tick 응답 shape와 `skipped:'in-progress'`.

## 배경 (자기완결)

실패 항목 shape: `{ articleId, targetId, kind, reason, failedAt, historyId, targetName, targetActive, targetKind, kindDistributed }`.

- `targetKind`는 수신처의 **현재** 분류다. `kind`(실패 당시 분류)와 다르면 서버가 `kind-changed`로 재전송을 거부한다(엠바고 파기 차단 — step3).
- `kindDistributed === false`는 "그 기사의 그 kind에 배부 이력이 아직 없다"는 뜻이다 → 다음 tick이 **전 활성 수신처**에 배부할 수 있어, 지금 재전송하면 이 수신처만 두 번 받는다.

tick 응답 shape: `{ ok:true, at, scanned, distributed:[{articleId,kinds,status}], failed:[{articleId,targetId,kind,reason}], invalid:[{articleId,field}] }` (겹침 시 `skipped:'in-progress'`), 실패 시 `{ ok:false, reason:'spool-disabled'|'tick-failed'|'forbidden'|… }`.

**재전송은 되돌릴 수 없다**(스풀 파일이 나가면 회수 수단이 없다) — 기존 '비활성' 버튼과 달리 **확인 대화상자(`confirm`)를 둔다**. 이 화면의 기존 판단 근거("비활성은 되돌릴 수 있는 조작이라 확인창을 두지 않는다")의 대칭이다. 수동 tick도 실제 배부를 유발하므로 확인창을 둔다.

**표시 규율**: `spoolDir`·파일 경로는 서버가 주지 않는다 — 화면에서도 만들어 내지 마라. 수신처는 `targetName`(없으면 `targetId`)으로 표시한다.

## TDD — 테스트 먼저

`web/src/view/DistMgmtPage.test.jsx`에 케이스를 **추가**한다(기존 케이스 수정 금지 — 기존 폼/표 케이스는 무수정 green이어야 한다).

1. 진입 시 배부 대상 목록과 **실패 목록을 함께 조회**한다(두 스파이 각각 1회 이상).
2. 실패 항목이 표에 렌더된다: 기사아이디·수신처명·유형 한글 라벨(언론사/비언론사)·사유·실패시각(`formatDateTime` 형식). 항목 행에 `data-testid`를 부여해 스코프 단언이 가능하게 한다(예: `dist-fail-row-<historyId>`).
3. 실패 0건이면 "배부 실패가 없습니다" 계열 안내가 보이고 표가 렌더되지 않는다.
4. 실패 조회가 `forbidden`이면 오류 문구가 보인다(`reasonMessage` 경유, `role="alert"`).
5. 재전송 버튼 클릭 → `confirm` 승인 시 `retryDistribution`이 `(articleId, targetId)`로 호출된다.
6. `confirm` 취소 시 **호출 0회**다.
7. 재전송 성공 후 그 행이 목록에서 사라진다(컨트롤러 재조회 경유).
8. 재전송 실패(`status-changed`)면 그 사유의 **한글 문구**가 보이고 행은 남는다.
9. `targetActive === 'N'`인 항목의 재전송 버튼은 `disabled`이고, 비활성 안내가 함께 보인다(서버도 `inactive`로 거부한다 — 이중 방어).
9-1. `targetKind !== kind`인 항목의 재전송 버튼도 `disabled`이고 "수신처 유형이 바뀌었습니다" 계열 안내가 보인다(서버도 `kind-changed`로 거부 — 이중 방어).
9-2. 재전송 실패 응답이 `kind-changed`면 그 사유의 한글 문구가 보인다(서버가 진실이므로 화면 가드를 우회한 경우에도 안내가 나온다).
9-3. `kindDistributed === false`인 항목의 확인창 문구에 **중복 배부 경고**가 포함된다: 이 kind는 아직 미배부로 기록돼 있어 다음 tick이 전 대상에 배부할 수 있다는 취지. `confirm`에 넘긴 문자열을 스파이로 단언하라.
9-4. `kindDistributed === true`인 항목의 확인창에는 그 경고가 없다(경고 남발 금지).
10. in-flight 가드: 재전송 버튼 연타로 `retryDistribution`이 2회 호출되지 않는다.
11. tick 버튼 클릭 → `confirm` 승인 시 `runDistributionTick`이 **인자 없이** 1회 호출된다. 취소하면 0회.
12. tick 성공 후 결과 요약이 보인다: 스캔·배부·실패 건수가 응답 값과 일치한다(`scanned`/`distributed.length`/`failed.length`).
13. tick이 `{ ok:false, reason:'spool-disabled' }`면 "배부 스풀이 설정되지 않았습니다" 계열 문구가 보인다.
14. tick 응답에 `skipped:'in-progress'`가 있으면 "이미 실행 중" 안내가 보인다(무음 금지).
15. tick 실행 중에는 버튼이 `disabled`다(연타로 2회 호출되지 않는다).
16. tick 실행 후 실패 목록이 재조회된다(스파이 호출 증가).
17. **실패 표 서브트리**(`[data-testid^="dist-fail-row-"]` 행들, 또는 실패 섹션 컨테이너)의 `textContent`에 스풀 경로·폴더 슬러그가 없다. 스코프를 페이지 전체로 잡지 마라 — **배부 대상 표는 `spoolDir` 슬러그를 그대로 표시하는 것이 기존 Z 전용 계약**(`DistMgmtPage`의 '스풀 폴더' 컬럼·입력란)이며 이 phase에서 바꾸지 않는다. 이 단언이 지키는 것은 "실패 목록 응답에는 경로가 실리지 않는다"는 백엔드 위생이 화면까지 유지되는지다.

## 작업

`web/src/view/DistMgmtPage.jsx`만 수정한다.

1. 컨트롤러에서 `failures`/`refreshFailures`/`retryTarget`/`runTick`을 받는다.
2. 진입 effect에서 배부 대상 조회와 함께 실패 목록도 조회한다(기존 `alive` 가드 패턴 유지 — 언마운트 후 setState 금지).
3. 실패 섹션(제목·표·안내 문구)과 tick 섹션(버튼·결과 요약)을 렌더한다. 기존 `yh-card`/`yh-table`/`yh-btn` 클래스를 재사용하고 **새 CSS 파일·새 클래스 정의를 추가하지 마라**(불가피하면 인라인 style — 기존 파일 선례).
4. 사유 문구는 모듈 스코프의 `reasonMessage`에 키를 **추가**해 처리한다(새 인스턴스 만들지 말고 기존 `createReasonMessage(...)` 호출에 키 추가):

```js
'no-failure': '이미 처리된 실패입니다. 목록을 새로 조회해 주세요.',
'kind-changed': '수신처 유형이 실패 당시와 달라졌습니다. 유형을 되돌린 뒤 재전송하거나 새로 배부해 주세요.',
'status-changed': '기사 상태가 배부할 수 없는 상태로 바뀌었습니다(KILL·보류·삭제 승인).',
'spool-write-failed': '스풀 기록에 실패했습니다. 서버 스풀 설정을 확인해 주세요.',
'spool-disabled': '배부 스풀이 설정되지 않았습니다(DIST_SPOOL_DIR).',
'tick-failed': '배부 실행 중 서버 오류가 발생했습니다.',
'inactive': '비활성 수신처입니다. 먼저 활성화한 뒤 재전송해 주세요.',
```

5. 재전송·tick 각각 in-flight 상태(`retryingId`, `ticking`)를 두고 버튼을 `disabled` 처리한다. 재전송 버튼은 `targetActive !== 'Y'` 또는 `targetKind !== kind`일 때도 `disabled`이며, 그 사유를 행에 텍스트로 표시한다(왜 못 누르는지 알 수 없는 버튼 금지).
6. 재전송·tick 모두 `globalThis.confirm` 승인 시에만 실행한다(취소는 아무것도 하지 않는다). 재전송 확인 문구는 `kindDistributed === false`일 때만 중복 배부 경고 문장을 덧붙인다(서버 파생 플래그만 근거로 쓴다 — 화면이 배부 여부를 스스로 계산하지 마라).
7. tick 결과는 로컬 state에 담아 요약만 표시한다 — 실패 항목 배열의 원소(파일 경로 없음이지만)를 통째로 덤프하지 말고 **건수 중심**으로 표시한다.
8. 표시 라벨은 기존 `KIND_LABEL`을 재사용한다(미지의 kind는 원문 그대로).

## Acceptance Criteria

```bash
npm run test:web  # 실패 0 — step7 종료 시점 개수 + 신규 케이스
npm run lint      # 통과
npm run build     # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `web/src/view/DistMgmtPage.jsx`, `web/src/view/DistMgmtPage.test.jsx` **2개뿐**(CSS 파일 무변경).

## 검증 절차

1. 위 AC 커맨드를 실행한다. 같은 커맨드를 **연속 2회** 실행해 개수가 동일한지 확인하라(모달/비동기 flake 방지 — phase 56 규약).
2. 변이 검증 5종(확인 후 원복):
   - `confirm` 가드를 제거하면 케이스 6·11이 red.
   - `targetActive` 비활성 판정을 제거하면 케이스 9가 red.
   - `targetKind !== kind` 판정을 제거하면 케이스 9-1이 red.
   - 중복 배부 경고를 항상/절대 붙이지 않게 바꾸면 케이스 9-3 또는 9-4가 red.
   - in-flight 가드를 제거하면 케이스 10·15가 red.
3. 아키텍처 체크리스트:
   - `fetch`·URL 문자열이 View에 없는가(ADR-003 — 전부 컨트롤러 경유)?
   - 타이머·자동 폴링이 없는가(ADR-008)?
   - 사유 토큰을 화면이 임의로 해석해 인가를 흉내내지 않는가(서버가 진실)?
4. `phases/57-distribution-mvp4/index.json`의 step8을 `completed` + `summary`로 갱신한다. summary에 추가 섹션 2종·확인창 정책(중복 배부 경고 조건 포함)·재전송 버튼 비활성 조건 2종·in-flight 가드·추가한 사유 문구 키 목록·testid 규칙·경로 위생 단언의 스코프를 명시하라.

## 금지사항

- 실패 목록·tick을 주기적으로 자동 실행하지 마라(`setInterval`·`setTimeout` 재귀·`useEffect` 폴링 금지). 이유: ADR-008 (3)이 금지하는 앱 내 타이머다 — 여러 탭이 열려 있으면 중복 tick이 실제 중복 배부로 이어진다.
- 재전송·tick을 확인창 없이 즉시 실행하지 마라. 이유: 스풀에 나간 파일은 회수 수단이 없다(이 화면의 '비활성'과 달리 되돌릴 수 없는 조작이다).
- 실패 목록을 화면에서 필터·중복 제거·해소 판정하지 마라. 이유: 미해소 판정의 단일 출처는 서버 파생(`distributionFailureLog`)이다 — 두 곳이 갈라지면 화면이 미발송을 숨긴다.
- 스풀 폴더명·파일 경로를 실패 표에 표시하려고 서버 응답에 필드를 추가하지 마라. 이유: 응답 위생(경로 비노출)이 백엔드 전 계층에서 지켜지고 있고, 이 화면 하나를 위해 뚫으면 그 규율이 무너진다.
- 재전송 버튼을 "전체 재전송"·"기사 단위 재배부"로 확장하지 마라. 이유: 기존 '재송'(정정본 새 사이클)과 의미가 겹치고 사이클 경계·tick 멱등 판정을 오염시킨다 — MVP-4 재전송은 실패분 복구 전용이다.
- 새 CSS 클래스·스타일시트를 추가하지 마라. 이유: 이 phase는 디자인 시스템 변경을 포함하지 않으며, 기존 `yh-` 클래스로 충분하다.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
