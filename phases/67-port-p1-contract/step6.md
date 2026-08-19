# Step 6: transitions

**생애주기 전이 2 라우트**를 동결한다: `POST /api/articles/:id/action`(#24 — send/hold/kill/approveDelete) · `POST /api/articles/:id/derive`(#25 — followUp/continue). 계약 축은 **(status, role, action) 전이표**, **송고의 "(끝)" 마커 게이트**, **엠바고 송고의 DES 진입**, **derive가 원본을 변경하지 않는다는 것**이다.

> **프로파일 주의**: 이 step의 케이스는 `contract/cases/minimal/` 에 둔다. 이유: `default` 프로파일은 배부가 켜져 있어(`DIST_SPOOL_DIR` 설정) 송고 직후 **비동기** 배부 훅이 DES→EPS→DPS 승격을 일으킬 수 있고, 그러면 "송고 후 status"가 관측 시점에 따라 달라져 비결정적이 된다. `minimal`은 배부가 비활성이라 전이 결과가 전이표만으로 결정된다. 배부가 켜진 상태의 송고 계약은 step10가 `default`에서 소유한다.

## 읽어야 할 파일

- `phases/67-port-p1-contract/index.json` — decisions **(2)(5)(6)(7)(9)(16)(18)**
- `phases/67-port-p1-contract/step5.md` — 픽스처 생성 방식(이미 동결한 create 라우트를 그대로 쓴다)
- `docs/api-contract/endpoints.json` — `articles-action`·`articles-derive` 행(주 프로파일 `minimal`)
- `server/index.js` — action 라우트(874~886행: `ACTION_SET` 검증 → 409 fallback), derive 라우트(892~905행: `DERIVE_MODE_SET`·author stamp)
- `src/services/lifecycle.js` **전체**(53줄) — `DESK_TABLE`·`REPORTER_TABLE`·`initialStatus`·거부 토큰 3종. **이 표가 케이스 매트릭스의 정본이다.**
- `src/services/articleService.js` 198~300행 — `applyAction`(마커 게이트·DES 진입 조건·sender/sentAt stamp·이력 기록), `syncEmbargoStatus`(왜 배부가 상태를 움직이는지)
- `src/services/articleService.js` 302~370행 — `deriveArticle`(복사 필드·새 articleId·원본 불변)
- `src/services/embargoPolicy.js` — 엠바고 2축 규칙(1차=언론사·2차=비언론사)과 상태 계산 범위
- `docs/news.md` "기사 생애주기" 절 및 엠바고 절 — 스펙 정본(전이표 원문)
- `docs/SCHEMA.md` — status 11종의 의미(DES·EPS·EEK·EEH·DPD 포함)

## 배경

- 전이표(코드 실측): R은 `RDS`에서만 `send→RDS`(유지)·`hold→RRH`·`kill→RRK`. D/Z는 `RDS{send→DPS,hold→DDH,kill→DDK}` · `DPS{send→DPS,hold→DDH,approveDelete→DPD}` · `DDH{send→DPS,kill→DDK}` · `EPS{kill→EEK,hold→EEH}` · `DES{kill→EEK,hold→EEH}`.
- 표에 없는 칸은 409 `forbidden-transition`, 정의 외 action은 400 `unknown-action`(라우트가 `ACTION_SET`로 먼저 거른다), 정의 외 role은 403 `unknown-role`(시드 계정으로는 도달 불가 — 미검증으로 기록).
- `send`는 본문에 `"(끝)"`이 없으면 400 `no-end-marker`(**전이 판정 다음**에 검사한다 — 순서가 계약이다: 전이 자체가 불가하면 마커 검사에 도달하지 않는다).
- 엠바고 컬럼(`embargoAt`·`secondEmbargoAt`)이 하나라도 있고 D/Z가 `RDS`/`DDH`에서 send하면 `DPS`가 아니라 **`DES`**다.
- `derive`는 **새 기사**를 만든다(새 articleId·status RDS·author는 세션 사용자). 원본은 한 글자도 바뀌지 않는다.

## 작업

### A. `contract/cases/minimal/transitions.contract.js`

1. **인가**: 두 라우트 미인증 → 401. 없는 articleId → 404(action은 서비스 경유라 실측 확인).
2. **입력 검증**: `action:'bogus'` → 400 `unknown-action`. body에 action 누락 → 400. `mode:'bogus'` → 400 `unknown-mode`. mode 누락 → 400.
3. **전이 매트릭스**(핵심): 위 표의 **허용 칸 전수**를 케이스로 만든다. 각 칸은 (a) 그 status의 픽스처를 이미 동결한 라우트만 써서 만들고 (b) action 호출 → 200 `{ok:true, status:<기대>}` (c) `GET /api/articles/:id`로 되읽어 실제 status가 같은지 확인한다(응답만 믿지 않는다).
   - 상태 도달 경로 예: `RDS`(create) → `DDH`(D hold) → `DPS`(D send, 마커 포함) → `DPD`(D approveDelete) / `RRH`·`RRK`(R hold·kill) / `DDK`(D kill) / `DES`(엠바고 설정 후 D send) → `EEK`·`EEH`(DES에서 kill·hold).
   - 도달 불가능한 상태(`EPS`는 배부가 있어야 진입)는 **이 프로파일에서 만들지 않는다** — 대신 `EPS`발 전이는 미검증으로 명세와 요약에 기록한다(step10가 배부 있는 환경에서 진입을 관측하면 그 사실도 기록).
4. **거부 칸 대표 케이스**: 최소 4건 — R이 `DPS` 기사에 send(409) · R이 approveDelete(400/409 실측) · D가 `DDH`에서 hold(409) · D가 `RRK`에서 send(409). 각각 사유 토큰까지 단언.
5. **마커 게이트**: 마커 없는 `RDS` 기사에 D send → 400 `no-end-marker` · 되읽어 status가 여전히 `RDS`(전이가 일어나지 않았다는 음성 증거). 마커를 넣어 다시 PUT(잠금 필요 — step5에서 동결한 경로 사용)한 뒤 send → 200 `DPS`.
6. **send stamp**: send 성공 후 되읽어 `sender`가 세션 사용자, `sentAt`이 비어 있지 않음(값 자체는 단언하지 않는다 — 시각은 휘발값).
7. **엠바고 진입**: `embargoAt`을 미래 ISO 문자열로 설정해 생성 → D send → `DES`. `secondEmbargoAt`만 설정한 경우도 1건(실측 결과를 명세에 기록). R이 같은 기사를 send하면? (R은 `RDS`에서 send→RDS 유지) — 엠바고 무관임을 1건으로 못 박는다.
8. **이력 부수효과**: 전이 후 `GET /api/articles/:id/history`에 `eventType:'status'` + `action` + `fromStatus`/`toStatus` 행이 생긴다(step4에서 동결한 라우트로 확인). 행 **개수**가 아니라 "그 전이에 해당하는 행이 존재한다"로 단언한다.
9. **derive**: `followUp`·`continue` 각각 → 200 `{ok:true, articleId:<새 id>}` · 새 id ≠ 원본 id · 새 기사 되읽어 `status='RDS'`·`author`=세션 사용자 · **원본을 되읽어 status·title·본문이 그대로**(원본 불변 단언이 이 케이스의 핵심). 어떤 필드가 복사되는지 실측해 명세에 표로 적는다.
10. **derive 권한**: R/D/Z 모두 가능한지 실측(라우트는 `ROLES` 게이트만 본다). DPS 기사에서의 derive 1건 포함.

### B. 명세 반영 `docs/api-contract/openapi.yaml`

- 2 라우트 paths 추가.
- **전이표를 명세에 옮긴다**: `POST /api/articles/:id/action`의 description에 (status × role × action → nextStatus) 표 전체를 넣는다(Spring 구현자가 이 문서만 보고 표를 재현할 수 있어야 한다). 거부 시 상태/토큰도 함께.
- 마커 게이트·엠바고 DES 진입 규칙·`sender`/`sentAt` stamp를 description에 명시한다.
- derive의 복사 필드 목록(실측)을 스키마 description에 적는다.

## Acceptance Criteria

```bash
npm run test:contract -- --profile minimal --files contract/cases/minimal/transitions.contract.js
npm run test:contract -- --profile minimal
npm run test:contract
npm test
npm run lint
node scripts/contract-inventory-check.mjs
git status --porcelain
```

## 검증 절차

1. 예측 먼저: 전이표를 코드에서 옮겨 적고 **케이스를 실행하기 전에** 각 칸의 기대 status를 확정한다. 실측과 다른 칸이 하나라도 있으면 그 칸을 요약에 굵게 기록한다(전이표 드리프트는 이 phase가 잡아야 할 최우선 사실이다).
2. `docs/news.md`의 전이표와 코드의 전이표를 대조한다. **차이가 있으면 코드를 정본으로 채택**하고, 차이 목록을 요약 + `docs/api-contract/README.md`의 "코드 ↔ 스펙 문서 차이" 절에 기록한다(news.md는 고치지 마라 — 무접촉 파일이다).
3. **vacuity 변이 2종**(각각 원복): (a) 5번의 기대 토큰을 `no-end-marker`→`no-end`로 바꿔 red 확인 (b) 9번의 "원본 불변" 단언을 원본 status가 바뀌기를 기대하도록 뒤집어 red 확인.
4. 결정성 확인: 같은 파일을 연속 2회 실행해 둘 다 green(픽스처가 매번 새로 만들어지고 이전 실행 상태에 의존하지 않는지).
5. AC 전부 실행. `--profile minimal` 전체 실행이 green인지도 확인(같은 프로파일에 다른 step의 케이스가 이미 있을 수 있다).
6. `git status --porcelain` 증분 = `contract/cases/minimal/transitions.contract.js` · `docs/api-contract/openapi.yaml` · `phases/67-port-p1-contract/index.json`.
7. 아키텍처 체크: 서버 코드 무수정 · `npm test` 1327 유지.
8. index.json step6 status·summary 갱신(전이표 실측 대조 결과·미검증 칸 목록 포함).

## 금지사항

- 이 step의 케이스를 `default` 프로파일에 두지 마라. 이유: 배부 훅이 비동기로 상태를 승격시켜(`DES`→`EPS`→`DPS`) 같은 요청이 실행 때마다 다른 status로 관측된다 — flake의 교과서적 원인이다.
- 도달 불가능한 상태(예: 배부 없는 환경의 `EPS`)를 만들려고 DB를 직접 건드리거나 서버를 고치지 마라. 이유: 계약 스위트는 API로만 말한다 — 도달 불가능하면 **미검증으로 정직하게 기록**하는 것이 계약 동결의 일부다.
- `docs/news.md`를 고치지 마라(무접촉 파일). 이유: 사용자가 편집 중인 문서이며, 코드-스펙 차이는 `docs/api-contract/`에 기록하는 것이 이 phase의 규약이다.
- 전이 결과를 응답 본문만 보고 단언하고 끝내지 마라. 이유: 응답과 DB가 갈라지는 결함(전이는 보고했는데 저장이 안 됨)을 놓친다 — 되읽기 단언이 필수다.
- 이력 행 **개수**를 단언하지 마라. 이유: 대상 서버의 기존 데이터·재실행에 따라 달라진다(존재 단언만 한다).
- `approveDelete`를 "행 삭제"로 기대하지 마라. 이유: DPD는 **상태값 전이**이며 행은 남는다(DB 비파괴 원칙의 핵심 계약이다).
