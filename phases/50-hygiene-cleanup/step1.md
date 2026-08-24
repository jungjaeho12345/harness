# Step 1: status-guard-read

## 목표

배부 실행의 **TOCTOU 상태 가드가 수신처마다 기사 전체 행을 재조회**하는 비용을 없앤다.

`src/services/distributionService.js`의 쓰기 직전 가드는 `articleModel.getById(articleId)`를 호출하는데, `getById`는 `SELECT * FROM Article`(본문 `markupVersion` 블록 JSON 전체 포함) + `SELECT * FROM Contents` 두 번을 돌린다. 가드가 실제로 쓰는 값은 **`contents.status` 문자열 하나**다. 수신처가 N곳이고 kind가 2개면 본문 전체를 최대 2N회 다시 읽는다(언론사 수신처는 수십~수백 곳이 될 수 있다).

수정: `articleModel`에 **additive 읽기 전용 메서드** `getStatus(articleId)`를 추가하고 가드가 그것만 쓰게 한다. **가드의 판정 의미론은 1비트도 바뀌지 않는다** — 회수 불가능한 KILL/보류/삭제 기사 유출을 막는 유일한 방어선이라, 이 step의 성공 기준은 "더 싸게, 정확히 같은 판정"이다.

> **선행**: step0(`dist-reason-token`)이 완료돼 `src/services/distributionService.js`가 `STATUS_CHANGED_REASON`을 `embargoPolicy.js`에서 import하는 상태를 전제한다(같은 파일을 수정하므로 순서 고정). 시작 기준선은 `npm test` 636 + step0 신규 케이스, 실패 0.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ADR.md` — ADR-002(`node:sqlite` 직접 SQL, ORM 없음 / 스키마는 멱등·additive만), ADR-006(controllers → services → models 계층, 의존성 주입), ADR-008(배부).
- `docs/SCHEMA.md` — Contents 테이블 정의(L42~53). 특히 **L50~51**: `status`는 CHECK 제약 없는 VARCHAR이고 DES/EPS/DPS/EEK/EEH/DPD 등을 가진다.
- `docs/ARCHITECTURE.md` — 백엔드 계층·DB 비파괴 원칙(L70).
- `src/models/articleModel.js` — 파일 전체(163줄). **L45~52 `getById`**(Article·Contents 각각 `SELECT *`), **L73~140 `query`**, **L162 `return { getById, insert, update, query, searchByText, setLock, clearLock };`**. 파일 상단 주석 L4: "행 삭제 코드는 두지 않는다(DB 비파괴)".
- `src/services/distributionService.js` — **L25~28 `isDistributable(row)`**, **L52~56**의 반환 계약/비용 인식 주석, **L57~151 `distribute`**: L64 최초 `getById`(페이로드 스냅샷 — **유지**), L92~110 수신처 루프와 **L98 가드 호출**, L100~108 중단 처리.
- `src/services/embargoPolicy.js` — L18 `EMBARGO_DISTRIBUTABLE_STATUSES`(단일 출처 — 복제 금지).
- `test/articleModel.test.js` — 모델 테스트 스타일(in-memory DB + `createSchema` 주입).
- `test/distributionService.test.js` — L30~60 `setup()` 하네스(**실제** `createArticleModel(db)`를 주입한다 — 가짜 모델이 아니다), L342~470 phase 49 step2의 상태 가드 테스트 4케이스(`spoolWriter.write` 부수효과로 status를 EEK/DPD로 바꿔 TOCTOU를 재현한다).
- 참고(수정 금지): `src/services/distributionTickService.js` L146~159 — tick의 fresh read는 status뿐 아니라 엠바고 필드까지 재판정하므로 `getById`가 계속 필요하다.

## 배경 (자기완결)

현재 가드:

```js
function isDistributable(row) {
  return Boolean(row && row.contents && EMBARGO_DISTRIBUTABLE_STATUSES.includes(row.contents.status));
}
...
if (!isDistributable(articleModel.getById(articleId))) { aborted = true; ... break; }
```

판정에 필요한 것은 `status` 한 칸이다. 다음 성질을 **그대로** 보존해야 한다.

| 상황 | 현재 판정 | 변경 후에도 |
|---|---|---|
| 행 없음(`getById` → `null`) | 배부 불가(중단) | 배부 불가 |
| Contents 행 없음 | 배부 불가 | 배부 불가 |
| status가 `DES`/`EPS`/`DPS` | 배부 가능 | 동일 |
| status가 `EEK`/`EEH`/`DPD`/`RDS`/`RRH`/`RRK`/`DDH`/`DDK` | 배부 불가 | 동일 |
| status가 `null`/`undefined`/비문자열 | 배부 불가(`includes` 미스) | 배부 불가(명시 판정) |

`test/distributionService.test.js`가 주입하는 `articleModel`은 **실제 모델**이므로, 메서드를 추가해도 갱신할 가짜 구현이 없다(ripple 없음).

## TDD — 테스트 먼저

1. `test/articleModel.test.js`에 `getStatus` 계약을 red→green으로 추가한다.
   - 기사를 insert한 뒤 `getStatus(articleId)`가 그 status 문자열을 돌려준다.
   - `update`로 status를 바꾸면 최신 값을 돌려준다(캐시 없음).
   - 존재하지 않는 articleId면 `null`(throw 금지).
   - Contents 없이 Article만 있는 행이면 `null`(방어적 — 배부 가드가 이 경우 중단해야 한다).
2. `test/distributionService.test.js`에 재조회 비용 잠금을 추가한다.
   - `setup()`이 만든 실제 `articleModel`을 얇게 감싼 계수 프록시(`{ ...articleModel, getById: (...a) => { byId += 1; return articleModel.getById(...a); }, getStatus: (...a) => { byStatus += 1; return articleModel.getStatus(...a); } }`)를 주입하고, 활성 수신처 2곳 × `kinds:['press','nonpress']`로 배부한다.
   - 단언: `byId === 1`(페이로드 스냅샷 1회뿐), `byStatus === 4`(수신처마다 1회). 숫자는 실제 수신처 구성에 맞춰 계산하되 **"getById는 배부당 1회"** 는 반드시 단언한다.
   - `getStatus`가 `null`을 돌려주는 경우(행이 사라진 상황을 스텁으로 재현)에도 기존과 동일하게 중단되고 `failed`에 `status-changed`가 남는지 단언한다.
3. phase 49 step2가 남긴 가드 4케이스는 **수정하지 않는다**. 리팩터 후에도 그대로 green이어야 한다.

## 작업

1. `src/models/articleModel.js` — additive 읽기 전용 메서드를 추가하고 반환 객체에 넣는다.

   ```js
   // 배부 TOCTOU 가드 전용 경량 조회 — 상태 한 칸만 필요할 때 본문(markupVersion) 재조회를 피한다.
   // 행이 없거나 status가 비어 있으면 null(호출자는 '배부 불가'로 해석한다).
   function getStatus(articleId) { /* SELECT status FROM Contents WHERE articleId = ? */ }
   ```

   - 반환은 `string | null`.
   - 쓰기·삭제 SQL을 추가하지 마라(DB 비파괴). 스키마도 건드리지 않는다(컬럼은 이미 있다).
   - `getById`는 **그대로 둔다**(다른 소비자 다수).

2. `src/services/distributionService.js`
   - `isDistributable(row)`를 status 문자열을 받는 판정으로 바꾼다: `typeof status === 'string' && EMBARGO_DISTRIBUTABLE_STATUSES.includes(status)`. 이름은 의미가 드러나게(예: `isDistributableStatus`).
   - L98 가드: `if (!isDistributableStatus(articleModel.getStatus(articleId))) { ... }` — 중단 분기(`aborted`, `abortEntry`, `break`, targetId:null / 남은 수신처 항목)는 **한 줄도 바꾸지 않는다**.
   - L64의 최초 `getById`(페이로드 스냅샷)는 유지한다 — 스풀에 나가는 본문은 최초 스냅샷이라는 정책(L96~97 주석)이 불변이다.
   - L55~56 비용 인식 주석을 실제에 맞게 갱신한다(전체 행 재조회 → status-only 조회, N+1은 여전히 존재하나 본문은 다시 읽지 않는다). 주석 전면 재작성 금지.
   - `articleModel.getStatus`가 없을 때의 폴백 분기를 만들지 마라(아래 금지사항 참조).

## Acceptance Criteria

```bash
npm test        # 636 + step0 신규 + 이번 신규, 실패 0
npm run lint
```

`git diff --name-only`는 `src/models/articleModel.js`, `src/services/distributionService.js`, `test/articleModel.test.js`, `test/distributionService.test.js` **4개뿐**이어야 한다(server/·web/·docs/ 변경 0, 스키마 파일 변경 0).

## 검증 절차

1. 위 AC 커맨드를 실행한다. phase 49 step2의 가드 4케이스가 **무수정 green**이어야 한다(의미론 보존의 1차 증거).
2. 변이 검증: 가드 조건을 임시로 `true`로 고정하면 가드 4케이스가 red가 되는지 확인 후 되돌린다. 또 `getStatus`가 항상 `'EEK'`를 돌려주게 하면 정상 경로 테스트가 red가 되는지 확인한다.
3. 비용 확인: 새 계수 테스트가 `getById === 1`을 단언하는지, 수신처 수를 늘려도 `getById`가 늘지 않는지 확인한다.
4. DB 비파괴 확인: `git diff src/models/articleModel.js`에 `DELETE`/`DROP`/`TRUNCATE`가 없고, 추가된 SQL이 `SELECT` 하나뿐인지 확인한다.
5. 아키텍처 체크리스트:
   - 모델은 비즈니스 규칙 없이 SQL만 하는가(allowlist 판정은 서비스/`embargoPolicy`에 남았는가)?
   - `EMBARGO_DISTRIBUTABLE_STATUSES`를 복제하지 않고 계속 import하는가?
   - 서비스가 `db`를 직접 잡지 않고 주입된 모델만 쓰는가?
6. `phases/50-hygiene-cleanup/index.json`의 step1을 `completed` + `summary`로 갱신한다. **backend 패스 완료**를 summary에 명시하라(다음은 web 패스).

## 금지사항

- `articleModel.getStatus`가 없을 때 `getById`로 되돌아가는 폴백 분기를 만들지 마라. 이유: 보안 게이트에 두 경로가 생기면 어느 쪽이 실행됐는지 테스트가 보장하지 못한다. 주입은 항상 실제 모델이며(프로덕션은 `src/controllers/index.js`, 테스트는 `createArticleModel(db)`), 메서드가 없으면 예외로 배부 자체가 중단되는 편이 안전한 방향이다.
- 가드를 "행이 없으면 통과"로 완화하지 마라. 이유: 한 번 스풀로 나간 기사는 회수 수단이 없다 — 판정 불가는 항상 배부 불가여야 한다.
- L64의 최초 `getById`를 없애거나 kind/수신처마다 페이로드를 새로 읽게 바꾸지 마라. 이유: 한 배부 배치는 같은 본문을 내보내야 정정 추적이 가능하다(phase 49 step2 확정 정책).
- `distributionTickService.js`의 fresh read(L150)를 `getStatus`로 바꾸지 마라. 이유: 거기서는 fresh `contents`로 `dueKinds`를 재판정해야 해서 status만으로는 부족하고, 기사당 1회라 절감 효과도 없다.
- `articleModel`에 삭제/보관/정리 메서드를 추가하지 마라. 이유: DB 비파괴 원칙(CLAUDE.md·ADR-002) — 이 모델에는 행 삭제 코드를 두지 않는다.
- 스키마(`src/db/`)를 수정하지 마라. 이유: `status` 컬럼은 이미 존재하며 이번 변경은 조회 방식일 뿐이다.
- `.claude/skills/claude-code-review-harness/SKILL.md`를 읽거나 수정하거나 커밋에 포함하지 마라. 이유: 사용자가 편집 중인 파일이다.
