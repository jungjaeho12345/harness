# Step 1: lifecycle-des

기사 생애주기 전이표(`src/services/lifecycle.js`)에 **DES(엠바고 배부 전 대기)** 상태를 신설한다.
이 step은 **전이표와 문서 1줄만** 바꾼다. DES를 실제로 만들어내는 송고 후처리는 step2, 시점 배부는 step3·step4다.

## 배경

- 사용자 확정 스펙(2026-07-28) A: 엠바고 기사 생애주기는 **데스크 송고 → DES → (첫 배부) → EPS → (배부 완결) → DPS**.
  `docs/news.md` "기사 생애주기": `엠바고 기사는 RDS->DES->EPS 가 기본 생애주기가 된다`.
- **DES 허용 액션은 EPS와 동일하다** — D/Z의 KILL → `EEK`, 보류 → `EEH`. 재송고(send)·삭제승인(approveDelete)은 미정의(거부), R은 전부 불가.
- 기존 `EPS` 행은 **그대로 둔다**. 이미 EPS로 저장된 기존 행(레거시)이 계속 KILL/보류될 수 있어야 한다(DB 비파괴 — 데이터 마이그레이션 없음).
- 이 step만 적용된 시점에는 DES 상태인 기사가 아직 생기지 않는다(생산자는 step2). **의도된 중간 상태**이며 회귀가 아니다.

## 읽어야 할 파일

- `docs/news.md` — "기사 생애주기" 절 전문(EPS 두 행 `권한 D 사용자가 EPS 기사를 KILL 시에는 EEK`, `... 보류시에는 EEH`와 `RDS->DES->EPS` 행).
- `docs/SCHEMA.md` — Contents 절 50행(상태값 목록 문장). 이 step에서 **DES를 추가**한다.
- `src/services/lifecycle.js` — 전체(51행). `DESK_TABLE`(12-17행), `REPORTER_TABLE`(20-22행), `transition()`(38-50행).
- `test/lifecycle.test.js` — 전체. 허용 전이 표(29-33행에 EPS 4행), 거부 조합 목록(63-69행에 EPS 6행).
- `phases/48-distribution-tick/step0.md` — 같은 phase의 판정 규칙(참고용, 코드 의존은 없음).

## 작업

**TDD: `test/lifecycle.test.js`에 DES 행을 먼저 추가해 red를 확인한 뒤 `lifecycle.js`를 고친다.**

### 1) `test/lifecycle.test.js` — 행 추가 (기존 행은 한 줄도 지우지 않는다)

- 허용 전이 표(현재 29-33행 EPS 블록 바로 아래)에 추가:
  `['DES','D','kill','EEK']`, `['DES','D','hold','EEH']`, `['DES','Z','kill','EEK']`, `['DES','Z','hold','EEH']`
- 거부 조합 목록(현재 63-69행 EPS 블록 바로 아래)에 추가:
  `['DES','D','send']`, `['DES','Z','send']`, `['DES','D','approveDelete']`, `['DES','Z','approveDelete']`,
  `['DES','R','kill']`, `['DES','R','hold']`, `['DES','R','send']`
- **기존 EPS 12행(29-33, 63-69)은 전부 유지한다** — 레거시 EPS 행의 전이 계약이 변하지 않는다는 증거다.

### 2) `src/services/lifecycle.js` — DESK_TABLE에 DES 행 추가

```js
DES: { kill: 'EEK', hold: 'EEH' },   // 엠바고 배부 전 대기 — send 없음(재송고 미정의), EPS와 동일 계약
```
- `REPORTER_TABLE`은 손대지 않는다(R은 DES에 어떤 액션도 불가).
- `initialStatus`/`transition`의 구조는 바꾸지 않는다 — 표 한 행 추가로 끝나야 한다.
- 주석에 근거(news.md `RDS->DES->EPS`, "DES 허용 액션은 EPS와 동일")를 1-2줄로 남긴다.

### 3) `docs/SCHEMA.md` — 50행 상태값 문장에 DES 추가 (additive 문서화)

- 상태값 나열에 `DES`를 추가하고, 한 문장으로 정의한다:
  "DES는 엠바고가 설정된 기사를 데스크가 송고했을 때의 배부 전 대기 상태이고, 첫 배부가 실행되면 EPS, 모든 엠바고 배부가 완결되면 DPS가 된다."
- **기존 EPS 설명 문장은 지우지 말고** 레거시 의미(기존 행 보존)를 유지한 채 DES 설명을 덧붙인다.
- 스키마 DDL은 **건드리지 않는다**. `status`는 VARCHAR이고 CHECK 제약이 없다(`src/db/schema.js:43`) — 마이그레이션 불필요.

## Acceptance Criteria

```bash
node --test test/lifecycle.test.js
npm test
npm run lint
```

- `test/lifecycle.test.js` green(신규 11행 포함).
- `npm test` 기준선: **총 527 / pass 523 / fail 4**(아래 4건은 phase 47 머지본의 기존 실패 — Windows 경로 구분자 `\` vs `/` 단언, phase 48 범위 밖):
  1. `createControllers: DIST_SPOOL_DIR 설정 시 송고가 활성 수신처 스풀에 배부된다` (`test/controllers.test.js`)
  2. `레거시 행의 잘못된 spoolDir는 실제 writer가 거부해 failed로 격리된다(경로 조작 방어)` (`test/distributionService.test.js:265`)
  3. `spoolWriter: 수신처 폴더를 recursive mkdir 후 임시 파일에 쓰고 rename으로 게시한다` (`test/spoolWriter.test.js`)
  4. `spoolWriter: 파일명은 <articleId>_<timestamp>.json 이며 재배부해도 덮어쓰지 않는다` (`test/spoolWriter.test.js`)
  → 합격 조건은 **"fail이 위 4건 그대로, 신규 실패 0"**. 특히 `test/articleService.test.js`·`test/server.test.js`의 기존 EPS 단언이 이 step에서 깨지면 안 된다(아직 DES를 만들어내는 코드가 없으므로 깨질 이유도 없다).
- `npm run lint` clean.
- web 무접촉이므로 `npm run test:web`/`npm run build`는 이 step의 AC가 아니다.

## 검증 절차

1. 테스트 행 추가 → `node --test test/lifecycle.test.js` red 확인(DES 전이가 `forbidden-transition`으로 거부됨).
2. `lifecycle.js` 수정 → green.
3. `npm test` 후 fail 목록을 위 4건과 이름으로 대조(신규 실패 0).
4. `git diff --stat`이 `src/services/lifecycle.js` + `test/lifecycle.test.js` + `docs/SCHEMA.md` **3개 파일뿐**인지 확인.
5. `git diff docs/SCHEMA.md`가 **추가만**(삭제 라인 0)인지 확인.

## 금지사항

- `EPS` 행을 지우거나 DES로 이름만 바꾸지 마라. 이유: 이미 EPS로 저장된 기존 행이 KILL/보류 불가가 되어 운영 중 기사가 잠긴다(DB 비파괴 원칙).
- 기존 DB 행을 DES로 일괄 UPDATE하는 스크립트/마이그레이션을 만들지 마라. 이유: 사용자 확정 스펙 A.5 "기존 EPS 행은 그대로 EPS 유지, DES는 신규 송고부터 적용".
- `DES: { send: ... }`를 넣지 마라. 이유: EPS와 동일 계약이며 재송고는 news.md에 정의가 없다(정의 외 조합은 전부 거부가 원칙).
- `REPORTER_TABLE`에 DES를 추가하지 마라. 이유: 엠바고 송고 기사에 대한 R의 액션은 정의돼 있지 않다.
- `articleService.js`·`web/**`를 이 step에서 건드리지 마라. 이유: 송고 치환은 step2, 배지/메뉴 노출은 step5다 — 레이어를 섞으면 실패 격리가 불가능하다.
- `src/db/schema.js`에 status CHECK 제약이나 신규 컬럼을 추가하지 마라. 이유: 상태값은 애플리케이션 규칙이며, 제약 추가는 기존 행을 거부할 위험이 있다(DB 비파괴).
- `docs/news.md`·`docs/ADR.md`를 수정하지 마라. 이유: 스펙은 사용자 소유이며 phase 48 착수 전 커밋(ab3cbef)으로 확정됐다.
