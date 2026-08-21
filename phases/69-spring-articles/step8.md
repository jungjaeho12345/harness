# Step 8: edit-lock-http

편집 잠금의 **HTTP 표면 3개**를 만든다: `POST /api/articles/:id/lock` · `POST /api/articles/:id/unlock` · `POST /api/articles/:id/force-unlock`. 여기에 **DPS 기사 편집 진입 게이트**(`editDps` — D 전용)를 결선한다.

이 step이 끝나도 계약 파일은 green이 되지 않는다(`articles-write.contract.js`가 `action`(송고)까지 필요하다). 판정은 Java 와이어 테스트 + 진단 실행의 실패 서명으로 한다.

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — decisions **(11)(12)(13)(14)(15)(19)**
- `server/index.js` 952~995행 — **이식 원본 3라우트**. 특히 `lock`의 순서(`editDps` 프로브 → `not-found`면 404 → `ok`가 아니고 사유가 `not-dps`가 아니면 그대로 실패 매핑 → 획득)와 `force-unlock`의 역할 선판정(D/Z가 아니면 403)
- `src/services/authorization.js` 7~41행 — capability 표(`editDps: ['D']`)와 게이트 순서(세션 → 액션 어휘 → 존재 → DPS 여부 → 역할). `revise`·`portalRevise` 2종만 고침 액션이다
- `contract/cases/default/articles-write.contract.js` 190~300행(lock 성공·충돌·404·DPS 게이트) · 420~536행(unlock 멱등·403·404 / force-unlock 403·200·404)
- `server-spring/src/main/java/harness/news/service/Authorization.java` — capability 표의 기존 구조(행만 추가한다)
- step6(잠금 서비스) · step7(컨트롤러 패턴·신원 재도출) 산출물

## 배경 (동결된 계약 사실)

- **lock 성공 응답은 `{ok:true}` 뿐**이다(보유자 정보 없음). 같은 탭 재획득도 200.
- **잠금 충돌은 401 `locked`**다 — 423도 409도 아니다(`docs/api-contract/README.md` 드리프트 원장 3번: 코드 주석의 409 언급이 틀렸다). 다른 사용자든 같은 세션의 다른 탭이든 같은 401이며 **누가 잠갔는지 노출하지 않는다**.
- **DPS 게이트**: 기사가 `DPS`면 **D만** 편집 진입할 수 있다(Z도 403 `forbidden`). `DPS`가 아니면 게이트가 `not-dps`를 돌려주고 **그것은 통과**를 뜻한다. 요청 본문의 `action`이 `portalRevise`면 포털고침, 그 외 값은 전부 `revise`로 취급한다(정의 밖 문자열도 `revise`다 — 400을 만들지 마라).
- **잠금 획득은 상태 전이를 일으키지 않는다**(DPS 기사를 잠가도 상태는 `DPS`).
- **unlock**: 보유 탭이면 200, **이미 해제됐어도 200**(멱등 — 탭 닫기·pagehide가 중복 호출한다). 다른 사용자·다른 탭은 403 `not-holder`. 없는 기사는 404.
- **force-unlock**: R은 403 `forbidden`(라우트 직접 판정) · D는 200 · 잠기지 않은 기사도 200 · 없는 기사는 404(**역할 게이트를 통과한 뒤에** 존재 검사).
- 거부된 요청은 잠금 상태를 **바꾸지 않는다**(계약이 되읽기로 확인한다).

## 작업

### A. Node 대조 리포트 확인

step7에서 뽑은 `articles-write` Node 리포트를 다시 읽어 `articles-lock`·`articles-unlock`·`articles-force-unlock` 관측의 `status`·`reason`·`bodyKeys`를 확인한다(필요하면 다시 뽑는다 — 리포 밖 경로).

### B. capability 표 확장

- `Authorization`에 `editDps`(허용 역할 **D 하나**)를 추가한다. 표 구조는 그대로 두고 **행만 추가**한다(68 규율).
- DPS 판정(기사 상태 조회)은 인가 서비스가 기사 리포지토리를 직접 보든, 컨트롤러가 상태를 읽어 게이트에 넘기든 **한 방식만** 고른다. 어느 쪽이든 **판정 순서**(존재 → 상태 → 역할)는 정본과 같아야 하고, role은 반드시 재도출된 신원에서 읽는다.

### C. 컨트롤러 3개

- **lock**: 신원 → (본문 `action` 정규화) → DPS 게이트 → `not-found`면 404 · `not-dps`가 아닌 실패면 사유 매핑(403) → 잠금 서비스 획득 → 성공 `{ok:true}` / `locked`면 401.
- **unlock**: 신원 → 잠금 서비스 해제(탭 헤더·세션 userId 전달) → 성공 `{ok:true}` / `not-holder` 403 / `not-found` 404.
- **force-unlock**: 신원 → **역할 D/Z 판정(403)** → 잠금 서비스 강제 해제 → `{ok:true}` / `not-found` 404.
- 탭 헤더는 **있는 그대로** 넘긴다(부재를 빈 문자열로 바꾸지 마라 — step6 decisions (11)).
- `ReasonStatus`에 `locked` **401** · `not-dps` 403을 추가한다(도달하는 토큰만 — decisions (19)).

### D. 인벤토리 갱신

- `HandlerInventoryTest`의 `IMPLEMENTED_ROUTES`에 3행 추가 + **메서드명·실패 메시지의 라우트 수 표기도 같은 step에서 갱신**(decisions (15)). scope 표는 늘리지 않는다.
- 이 step은 `/api/articles/{id}/lock`·`unlock`·`force-unlock`에 매핑을 붙인다 — `server-spring/src/test/**`에 그 경로들을 **미구현 전제**로 쓰는 단언이 있는지 검색해 확인한다(step7이 `PathPolicyWireTest` 프로브를 이미 재조준했다면 추가 조치가 없어야 한다. 있으면 **삭제·약화 없이** 미구현으로 남는 라우트로 재조준한다).

### E. 테스트 (먼저 쓴다 — 전 기동 + 원시 HTTP)

1. lock 성공 → `{ok:true}` **1키** · 되읽기로 `lockYN='Y'`·`lockerUserId`가 세션 사용자 · **두 잠금 컬럼은 응답에 없다**.
2. 같은 탭 재획득 200 · 같은 세션 다른 탭 **401 `locked`** · 다른 사용자 401 `locked` · 응답 키가 `ok`,`reason` 2개뿐.
3. lock 404(없는 기사).
4. DPS 게이트: 송고된 기사에 R → **403 `forbidden`**이고 잠금이 생기지 않는다 · D → 200 · 본문 `action:'portalRevise'`도 200 · **Z도 403**(계약 미관측이지만 capability가 D 전용임을 실증) · 잠금 획득 후에도 상태가 `DPS` 그대로다.
5. unlock: 보유 탭 200 · 되읽기로 5컬럼이 비워졌다 · **재호출도 200**(멱등).
6. unlock 403: 다른 사용자가 **같은 탭 문자열**을 흉내내도 거부 · 같은 사용자의 다른 탭도 거부 · 잠금 유지.
7. unlock 404(없는 기사).
8. force-unlock: R 403이고 잠금 유지 · D 200이고 해제 · 잠기지 않은 기사도 200 · 없는 기사 404.
9. 미인증 3라우트 전부 401 JSON(`x-edit-client`만 붙여도 401).
10. 경로 파라미터·퍼센트 인코딩 변형에서도 미인증 401이 유지된다(68 forward_notes (20) 승계).

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- **이 블록의 5개 커맨드만 exit 0 대상이다**(AC = exit 0 게이트). 아래 검증 절차의 **진단 실행은 AC가 아니며 실패가 정상**이다 — AC 블록에 넣지 마라(④ 테스터가 정상 red를 회귀로 오판한다).
- 3번은 무회귀 확인(관측 수 불변 · `diffs=0`).

## 검증 절차

1. red 먼저(E의 10군).
2. AC 실행. Java 테스트 수 증가분 기록.
3. **진단 실행(AC 아님 — 실패가 정상이다)**: 아래를 1회 돌리고 실패 지점을 기록한다. **exit 코드로 판정하지 마라**.
   ```bash
   cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --profile default --files contract/cases/default/articles-write.contract.js
   ```
   이제 실패는 **송고(`POST .../action`)가 필요한 케이스에서만** 나야 한다(`createSentArticle` 픽스처 = DPS 잠금 게이트 케이스). 그 서명을 요약에 적는다 — step10의 잔여 범위 확정 관측이다. step7 진단에서 보이던 잠금 관련 실패가 사라졌는지도 함께 확인한다.
4. **변이 실증 3종**(확인 후 원복): (a) 잠금 충돌을 423으로 바꾸면 2번이 red인가 (b) DPS 게이트에서 `not-dps`를 실패로 취급하면 일반 기사 잠금이 막히는가(1번 red) (c) force-unlock에서 역할 판정을 존재 검사 뒤로 옮기면 8번의 404/403 순서가 바뀌는가.
5. **인가 층 확인**(68 forward_notes (2)): 이 3라우트의 인가가 경로 정책 필터에만 있는지 컨트롤러에도 있는지 점검하고, 컨트롤러 게이트가 있음을 요약에 적는다.
6. **DB 비파괴**: 거부된 요청이 잠금 컬럼을 바꾸지 않았다는 되읽기 단언(2·6·8번) 결과를 요약에 적는다.
7. `git status --porcelain` 증분 = `server-spring/src/main/java/harness/news/{controller,service,web}/**` · `server-spring/src/test/**` · `phases/69-spring-articles/index.json`.
8. index.json step8 status·summary 갱신.

## 금지사항

- 잠금 충돌에 423·409를 쓰지 마라. 이유: 전역 매핑의 `locked`는 **401**이고 계약·기존 backend 테스트가 401을 단언한다(코드 주석의 409는 문서화된 드리프트다).
- 실패 응답에 보유자 정보를 담지 마라. 이유: 누가 잠갔는지 노출하지 않는 것이 계약이고 탭 식별자는 사칭 재료다.
- `action` 본문 값이 정의 밖이라고 400을 내지 마라. 이유: 정본은 `portalRevise`가 아니면 전부 `revise`로 취급한다.
- Z에게 DPS 편집 진입을 허용하지 마라. 이유: capability 표가 `editDps: ['D']`다 — 넓히면 권한 모델이 갈라진다.
- unlock을 거부(4xx)로 만들지 마라(이미 해제된 경우). 이유: 탭 닫기·pagehide가 중복 호출하는 멱등 계약이다.
- 강제 해제에 존재 검사를 먼저 넣지 마라. 이유: 계약이 '권한 게이트 통과 후 존재 검사'를 동결했다(R은 없는 기사에도 403이다).
- 잠금 정책(TTL·takeover 판정)을 컨트롤러에 복제하지 마라. 이유: step6 서비스가 단일 지점이며 복제하면 두 판정이 갈라진다.
