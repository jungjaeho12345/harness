# Step 6: model-contract

## 목표

프론트 Model 계약 3면(계약 정의 · HTTP 배선 · fake)을 새 백엔드 엔드포인트에 맞춰 **동기화**한다.

추가 키 3개: `queryDistributionFailures` · `retryDistribution` · `runDistributionTick`.

이 step은 Model 계층만 다룬다. 컨트롤러·화면은 step7~8 소관이다.

## 읽어야 할 파일

- `docs/ADR.md` **ADR-003**(주입형 Model 계약 — View/Controller는 transport-agnostic). **읽기 전용(무접촉)**.
- `web/src/model/contract.js` 전체(56줄) — `MODEL_KEYS`(frozen) + `assertModel`.
- `web/src/model/httpModel.js` — `request(path, { method, body, query })` 헬퍼와 배부 대상 메서드 4종(L269~285). `credentials:'include'`·`x-session-id` 처리 규약을 그대로 따른다.
- `web/src/test/fakeModel.js` — 배부 대상 in-memory 모사(L255~296)와 seed 처리(L17~27).
- `web/src/model/contract.test.js` — `expect(MODEL_KEYS).toHaveLength(32)`(**35로 갱신 필요**), 배부 대상 키 단언, `assertModel(fake)` 통과 단언.
- `web/src/model/httpModel.test.js` — fetch mock으로 경로·메서드·body를 잠그는 스타일.
- `server/index.js`(step5 결과) — `GET /api/distribution/failures`·`POST /api/distribution/retry`·`POST /api/distribution/tick`의 실제 요청/응답 shape.
- `src/services/distributionRetryService.js`(step3) — 실패 항목 필드와 거부 사유 토큰.
- `src/services/distributionTickService.js` L91~95 — tick 응답 shape(`{ ok, at, scanned, distributed, failed, invalid }`, 겹침 시 `skipped:'in-progress'`).

## 배경 (자기완결)

`web/src/main.jsx`가 부팅 시 `assertModel(createHttpModel())`을 부르므로 **`MODEL_KEYS`에 키를 추가하면 httpModel과 fakeModel 양쪽에 함수가 있어야** 앱과 테스트가 뜬다. 세 파일은 항상 같은 step에서 함께 움직인다.

계약(백엔드와 1:1):

```js
queryDistributionFailures(filters = {})  // GET  /api/distribution/failures     → { ok, items:[{ articleId, targetId, kind, reason, failedAt, historyId,
                                         //                                                  targetName, targetActive, targetKind, kindDistributed }] }
retryDistribution(articleId, targetId)   // POST /api/distribution/retry         → { ok, articleId, targetId, kind, at }
                                         //   | { ok:false, reason:'no-failure'|'kind-changed'|'status-changed'|'inactive'|'not-found'|'spool-disabled'|'spool-write-failed' }
runDistributionTick()                    // POST /api/distribution/tick          → { ok, at, scanned, distributed:[], failed:[], invalid:[] } | { ok:false, reason }
```

`runDistributionTick`은 **body를 보내지 않는다**(서버가 body를 읽지 않는다 — 파라미터를 클라이언트가 정하면 엠바고가 무력화된다).

## TDD — 테스트 먼저

### `web/src/model/contract.test.js`

1. `MODEL_KEYS`에 새 키 3개가 있고 길이가 **35**다(기존 32 단언 갱신).
2. `MODEL_KEYS`는 여전히 frozen이고 중복 키가 없다.
3. `assertModel(createFakeModel())`이 throw하지 않는다(기존 케이스가 자동으로 3면 동기화를 잠근다 — green 유지 확인).
4. fakeModel `queryDistributionFailures`가 seed 항목을 shape 그대로 돌려준다(원본 불변 — 반환 배열을 변형해도 seed가 안 바뀐다).
5. fakeModel `retryDistribution(articleId, targetId)` 성공 시 그 항목이 이후 `queryDistributionFailures`에서 사라진다.
6. fakeModel `retryDistribution`이 없는 쌍이면 `{ ok:false, reason:'no-failure' }`다(서버 어휘 동형).
6-1. fake 항목은 서버 shape의 **전 필드를 그대로 통과**시킨다 — `targetKind`·`kindDistributed`를 seed에 담으면 그대로 나온다(fake가 기본값을 지어내지 않는다. 이 두 필드는 step8 화면 테스트의 입력이다).
7. fakeModel `runDistributionTick()`이 `{ ok:true, at, scanned, distributed, failed, invalid }` shape를 돌려준다(seed로 주입 가능).

### `web/src/model/httpModel.test.js`

8. `queryDistributionFailures({ limit: 5 })` → `GET /api/distribution/failures?limit=5`(쿼리 직렬화 확인), body 없음.
9. `retryDistribution('AKR1', 12)` → `POST /api/distribution/retry`, body `{"articleId":"AKR1","targetId":12}`(그 외 키 없음 — `role` 등 미포함 단언).
10. `runDistributionTick()` → `POST /api/distribution/tick`, **body 미전송**.
11. 세 요청 모두 기존 규약(`credentials:'include'`, 세션 헤더 처리)을 따른다(기존 헬퍼 재사용이므로 한 케이스로 충분).

## 작업

### `web/src/model/contract.js`

`MODEL_KEYS`에 3개를 추가한다(배부 대상 키 묶음 아래, 주석과 함께).

```js
// 배부 실패 복구/실행(phase 57, MVP-4) — Z 전용. /api/distribution/{failures,retry,tick} 라우트와 1:1.
'queryDistributionFailures',
'retryDistribution',
'runDistributionTick',
```

### `web/src/model/httpModel.js`

기존 `request` 헬퍼로 3개 메서드를 추가한다. 배부 대상 메서드 바로 아래에 두고, 주석에 "검증·인가의 진실은 서버"를 명시한다. `role`·시각 등 신원/판정 값을 body·query에 싣지 마라.

### `web/src/test/fakeModel.js`

1. seed 키 2개를 받는다: `distributionFailures`(미해소 항목 배열), `tickResult`(tick 응답 객체, 기본값 제공).
2. `queryDistributionFailures(filters = {})` — 미해소 항목의 **복사본** 배열을 `{ ok:true, items }`로 돌려준다. `limit`이 있으면 앞에서 잘라 준다.
3. `retryDistribution(articleId, targetId)` — 일치 항목이 없으면 `{ ok:false, reason:'no-failure' }`, 있으면 해당 항목을 해소 처리하고 `{ ok:true, articleId, targetId, kind, at }`를 돌려준다.
4. `runDistributionTick()` — seed `tickResult` 또는 기본값을 돌려준다.
5. 주석에 **"fake는 서버가 파생해서 주는 '미해소 목록'을 모사한다 — 원장(ArticleHistory) 자체를 모사하지 않는다"**고 명시한다(해소 처리를 배열에서 제거로 구현해도 되지만, 그것이 DB 행 삭제를 뜻하지 않음을 못 박는다).
6. 기존 fake 메서드·seed 키는 변경 금지.

## Acceptance Criteria

```bash
npm run test:web  # 실패 0 — 기준선(90 files / 2262) + 신규 케이스
npm run lint      # 통과
npm run build     # 통과
npm test          # 실패 0 (백엔드 무영향 확인)
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `web/src/model/contract.js`, `web/src/model/httpModel.js`, `web/src/test/fakeModel.js`, `web/src/model/contract.test.js`, `web/src/model/httpModel.test.js` **5개뿐**.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증 3종(확인 후 원복):
   - `httpModel`에서 `runDistributionTick`을 지우면 `assertModel` 케이스가 red.
   - `retryDistribution`의 body에 `role:'Z'`를 추가하면 케이스 9가 red.
   - fake의 `queryDistributionFailures`가 내부 배열을 그대로 반환하게 하면 케이스 4가 red.
3. 아키텍처 체크리스트:
   - View/Controller가 `fetch`를 직접 쓰지 않는 구조가 유지되는가(ADR-003)?
   - fake와 http가 같은 사유 토큰 어휘를 쓰는가?
   - 응답을 가공·정규화하지 않고 그대로 반환하는가(표시 정책은 View 책임)?
4. `phases/57-distribution-mvp4/index.json`의 step6을 `completed` + `summary`로 갱신한다. summary에 새 키 3개·경로/메서드·fake seed 키·MODEL_KEYS 길이 변화를 명시하라.

## 금지사항

- `MODEL_KEYS`의 기존 키를 지우거나 이름을 바꾸지 마라. 이유: 전 화면의 주입 계약이 깨지고 부팅 시 `assertModel`이 throw한다.
- Model에서 서버 응답을 가공(사유 토큰 → 한글 문구 변환, 항목 정렬 변경, 기본값 주입)하지 마라. 이유: 표시 정책은 View(`mgmtMessages`) 책임이고, Model이 가공하면 fake와 실물이 다른 진실을 말하게 된다.
- `retryDistribution`에 `kind`·`spoolDir` 인자를 추가하지 마라. 이유: 배부 대상·종류는 서버가 실패 이력에서 도출한다 — 클라이언트가 정하면 임의 배부 경로가 열린다.
- tick 호출에 body·주기 타이머·자동 폴링을 붙이지 마라. 이유: ADR-008 (3) — 실행 트리거는 외부 cron과 Z의 명시 조작뿐이다.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
