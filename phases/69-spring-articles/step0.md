# Step 0: users-list

`GET /api/users`(인벤토리 id `users-list`) 하나를 구현해 **`contract/cases/default/users.contract.js`를 통째로 green**으로 만든다. 68이 이미 만든 users 쓰기 2라우트(`POST /api/users`·`PUT /api/users/:id`)에 목록 1개만 얹으면 그 파일의 전 케이스가 도달 가능해진다.

이 step은 이 phase에서 **유일하게 다른 라우트에 의존하지 않는 계약 파일**을 닫는다(기사 계약 3파일은 서로의 라우트를 픽스처로 부른다 — index.json `order` (a)). 그래서 맨 앞에 두어 **확장된 default 프로파일 scope가 실제로 도는지**를 기계로 먼저 확인한다.

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — scope · baseline · decisions **(1)(4)(5)(13)(15)(20)(22)(23)** · excluded (g)
- `contract/cases/default/users.contract.js` — **이 step의 합격 정의**. 특히 (a) Z 목록 = `SAFE_FIELDS` 6키(`active,department,departmentCode,name,role,userId`)이고 **그 밖의 키가 하나라도 있으면 실패** (b) 비-Z(R) 목록 = **정확 4키**(`department,departmentCode,name,userId`) — `role`·`active` 미노출 (c) 미인증 401 `{ok:false,reason:'unauthenticated'}` (d) 어떤 응답에도 `password` 키·bcrypt 해시 접두사·평문 비밀번호가 없다
- `docs/api-contract/endpoints.json` — `users-list`(method GET, auth `session`, profile `default`, expect `success`·`unauthenticated`, notes에 두 투영이 **둘 다 `success` 태그**임이 적혀 있다)
- `docs/api-contract/openapi.yaml` — `usersList` 오퍼레이션
- `server/index.js` 654~665행 — **이식 원본**(Z면 서비스 투영 그대로, 그 외는 라우트가 4필드로 재투영) — 읽기 전용 참조
- `src/services/userService.js` 10행·90~92행 — `SAFE_FIELDS` 6키와 `query(filters)`가 `sanitize`를 map 한다는 사실
- `server-spring/src/main/java/harness/news/service/UserService.java` — 이미 있는 SAFE_FIELDS 투영 헬퍼(재사용 대상)
- `server-spring/src/main/java/harness/news/model/UserRepository.java` — 이미 있는 `query(Map)`(화이트리스트 필터, 빈 맵이면 전체)
- `server-spring/src/main/java/harness/news/controller/UsersController.java` — 쓰기 2라우트의 게이트·응답 조립 패턴
- `server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java` — 구현 라우트 목록(이 step에서 +1)
- `scripts/spring-contract.mjs` 55~80행 — scope 표(이 step에서 default 행에 파일 1개 추가)

## 배경 (동결된 계약 사실)

- **판정 기준은 요청자의 세션 role**이다(ADR-004). 클라이언트가 보낸 `role`·본문은 신뢰 대상이 아니며, role은 **매 요청 재도출된 신원**에서 읽는다(68의 세션 가드).
- `GET /api/users`의 인증 클래스는 `session`이다 — **Z 전용이 아니다**. R·D도 200을 받고 투영만 좁아진다.
- 지금 이 라우트에 매핑이 없어서 인증된 `GET /api/users`는 **405**를 돌려준다(68 forward_notes (13) 실측 — POST/PUT 매핑만 있기 때문이다). 핸들러를 붙이면 405가 사라지고 200이 된다.
- 미인증 401은 이미 경로 정책 필터가 만든다(표에 `users-list`가 `session`으로 올라 있다) — **그 401을 컨트롤러에서 다시 만들지 마라**. 다만 컨트롤러는 role 판정을 위해 자기 문맥에서 신원을 다시 도출해야 한다(decisions (14)).

## 작업

### A. Node 대조 리포트 실측 (구현 전, decisions (23))

리포 **밖** 임시 경로에 Node 리포트를 뽑고 `users-list` 관측의 `status`·`bodyKeys`·`values`·`headers`를 눈으로 확인한다.

```bash
cd /d/agents/harness && OUT="$(mktemp -d)" && node scripts/contract-run.mjs --profile default --files contract/cases/default/users.contract.js --out "$OUT/node-users.json" && ls -l "$OUT"
```

리포트 경로는 **리포 안에 두지 마라**. `$TMPDIR`를 쓰지 마라 — win32 Git Bash에서는 비어 있을 수 있어 `--out "/node-users.json"`으로 펴진다(리포 밖 보장이 깨진다). `mktemp -d`를 쓰고, 그것이 없는 셸이면 `${TMPDIR:-${TMP:-/tmp}}` 폴백으로 디렉토리를 명시해 만든 뒤 쓴다. 실제로 쓴 절대 경로와 확인한 사실(특히 `content-type` 문자열과 `bodyKeys`)을 step 요약에 1~2줄로 남긴다.

### B. `service` 계층 — 사용자 목록

- `UserService`에 목록 조회를 추가한다: 필터 없는 전체 조회 → **행마다 SAFE_FIELDS 6키 투영**(키는 항상 있고 값이 없으면 `null` — 기존 헬퍼 재사용).
- 비밀번호 해시와 잠금 메타(`failedLoginCount`·`lockedUntil`·`lastFailedLoginAt`)는 **어떤 경로로도 나가지 않는다**.
- 서비스는 role을 모른다 — 역할 분기는 컨트롤러가 한다(Node 동형).

### C. `controller` 계층 — `GET /api/users`

- 쿠키 우선 · `x-session-id` 폴백으로 토큰을 읽어 신원을 재도출한다(68의 `SessionTokens`·세션 가드 사용). 신원이 없으면 401 `unauthenticated`(필터가 먼저 끊지만 컨트롤러도 자기 판정을 갖는다).
- role이 `Z`면 서비스 투영(6키)을 그대로 싣고, 그 외에는 **정확 4키**(`userId`,`name`,`department`,`departmentCode`)로 재투영한다. 4키 맵도 **키를 항상 싣고 값이 없으면 `null`**이다.
- 응답은 `{ok:true, items:[...]}`이며 `JsonHttp`로만 쓴다(decisions (22)).

### D. 인벤토리·scope 표 갱신 (같은 step에서)

- `HandlerInventoryTest`의 구현 라우트 목록(`IMPLEMENTED_ROUTES`)에 `GET /api/users`를 추가한다(스텁 금지 게이트 — decisions (15)). **같은 step에서 그 테스트의 메서드명·실패 메시지에 박힌 라우트 수 표기도 갱신한다**(`exactlyTheSevenImplementedRoutesHaveHandlers` → 8 라우트 · 실패 메시지의 '7 라우트' 문구). 수치를 그대로 두면 그 테스트가 주장하는 문장이 거짓이 된 채로 green이 된다.
- 이 step은 `GET /api/users`에 매핑을 붙인다 — `server-spring/src/test/**`에 **그 경로를 '미구현'으로 전제한 단언이 있는지 먼저 검색**하라(있으면 step7과 같은 규율으로 다룬다: 삭제·약화 금지, 프로브를 이 phase가 구현하지 않는 라우트로 재조준). 계획 시점 관측으로는 그런 단언이 `GET /api/articles`에만 있고(`PathPolicyWireTest`) `GET /api/users`에는 없다 — 검색으로 재확인하고 결과를 요약에 1줄 남긴다.
- `scripts/spring-contract.mjs`의 scope 표 `default` 행 `files`에 `contract/cases/default/users.contract.js`를 추가한다. **알파벳 정렬 위치를 지켜라**(러너의 디렉토리 스캔 순서와 같아야 한다 — `users.contract.js`는 목록의 마지막이다).

### E. 테스트 (먼저 쓴다 — 전 기동 `RANDOM_PORT` + 원시 HTTP, MockMvc 금지)

1. Z 세션 → 200, 원소가 **정확히 6키**(6필드를 모두 채운 픽스처 계정으로 판정), 응답 문자열에 `password`·bcrypt 접두사 없음.
2. R 세션 → 200, 원소가 **정확히 4키**, `role`·`active` 키 부재.
3. D 세션 → R과 같은 4키(비-Z 분기가 role 목록이 아니라 'Z가 아님'으로 갈린다는 실증).
4. 미인증 → 401 JSON `{ok:false,reason:'unauthenticated'}`.
5. **강등 반영**: Z로 만든 계정이 목록에서 6키로 보이다가, 그 계정 세션으로 조회하면 4키만 받는다(신원 재도출 + 역할 분기 결선 실증).
6. 부서가 비어 있는 계정도 **키가 남고 값이 `null`**이다(decisions (5)·(20)의 실증 — 키를 빼는 구현이면 red).

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수는 기준선 **276 이상**(증가만 허용). 실측치를 요약에 적는다.
- 3번: exit 0이고 default 프로파일 관측이 **users 케이스만큼 늘어난 채** `diffs=0`. 프로파일 3종 전부 `diffs=0`이어야 한다.
- 4번: **1328/1328**(증감은 회귀다 — 이 step은 `test/**`·`package.json`을 건드리지 않는다).

## 검증 절차

1. **red 먼저**: E의 6개 테스트를 구현 전에 돌려 실패를 실측한다(현재는 매핑이 없어 405 또는 404가 관측될 것이다 — 실제 관측값을 요약에 적는다).
2. AC 실행. `--parity` 출력의 `[diff] A=default-node B=default-spring observations=<n> diffs=0`에서 `<n>`이 이전 기준선(24)보다 커졌는지 확인해 **케이스가 실제로 실행됐음**을 증명한다(관측 수가 그대로면 파일이 실행되지 않은 것이다).
3. **변이 실증 2종**(확인 후 반드시 원복): (a) 비-Z 투영에 `role`을 한 키 추가하면 계약이 red인가 (b) 4키 맵에서 값이 `null`인 키를 빼면 red인가(6번 Java 테스트로도 red여야 한다).
4. **결함 후보 재현 확인**: 이제 `users.contract.js`가 도는 만큼 중복 userId 500(#1)·정의 밖 role 200(#2)이 **계약 관측으로** 잠긴다. 두 케이스가 green으로 통과했음을 요약에 명시한다(68은 Java 테스트로만 덮었다).
5. **DB 비파괴**: 하네스가 리포 `news.db`·`uploads/` 무변을 단언한다. 요약에 크기·mtime 무변을 적는다.
6. `git status --porcelain` 증분 = `server-spring/src/main/**` · `server-spring/src/test/**` · `scripts/spring-contract.mjs` · `phases/69-spring-articles/index.json`.
7. index.json의 step0 status·summary 갱신(실측 수치 포함).

## 금지사항

- 목록 응답에 `password`·`failedLoginCount`·`lockedUntil`·`lastFailedLoginAt`을 담지 마라. 이유: 투영 6키가 계약이고 잠금 메타는 계정 열거 단서다.
- 비-Z 투영을 '6키에서 2개를 빼는' 식으로 만들지 마라. 이유: 계약은 **정확 4키**이며, 새 컬럼이 SAFE_FIELDS에 추가되는 순간 빼기 방식은 조용히 새 필드를 노출한다.
- 요청 본문·헤더·쿼리의 `role`을 판정에 쓰지 마라. 이유: acting role은 검증된 세션에서만 도출한다(ADR-004). 이 규칙이 깨지면 누구나 Z가 된다.
- users 생성·수정에 입력 검증을 추가하지 마라. 이유: 결함 후보 #1·#2의 **재현이 현행 계약**이다(68 decisions (12)). 지금 고치면 `users.contract.js`가 red가 되고 '이식 결함'과 '의도된 계약 변경'이 섞인다.
- 사용자 행을 삭제하는 경로를 만들지 마라(비활성화는 `active='N'` 갱신). 이유: DB 비파괴 최상위 규칙.
- 시드 계정(`reporter`·`desk`·`admin`)의 role·active를 바꾸는 코드를 만들지 마라. 이유: 러너가 그 세션으로 전 프로파일을 돌린다.
- 기사 도메인 코드를 손대지 마라(이 step의 diff에 `article`이 등장하면 범위 위반이다). 이유: 실패 원인 격리.
