# Step 3: receiver-config-http

수집 수신 설정 컨트롤러를 만든다 — `ReceiverConfigController`(3 라우트: `GET /api/receiver-config` · `POST /api/receiver-config` · `DELETE /api/receiver-config/:id`). 이 step에서 **`contract/cases/default/receiver-config.contract.js`가 통째로 green**이 된다.

receiver-config 도메인의 3 라우트가 전부 붙는 첫 지점이다(리포지토리 step1 · 서비스 step2가 아래에 있다). 계약 파일이 자기 도메인 라우트 3개를 전부 픽스처로 쓰므로(create가 list·delete의 픽스처), **여기가 이 파일의 유일한 green 지점**이다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — decisions **(7)(11)(14)(15)(18)** · order (f)
- `contract/cases/default/receiver-config.contract.js` — **이 step의 합격 정의**. 특히 (a) create 200 `{ok:true,id}` 2키·시크릿 미반향 (b) list 200 원소 SAFE_FIELDS 정확 10키·createdAt null (c) list 화이트리스트 AND 필터·밖의 키 무시 (d) 미인증 401·비-Z(R) 403이고 행 불변 (e) delete 자기 행 changes:1·재삭제 changes:0·NaN id changes:0
- `docs/api-contract/endpoints.json` — `receiver-config-list`/`-create`/`-delete`(auth `admin`, expect success·unauthenticated·forbidden)
- `docs/api-contract/openapi.yaml` — 해당 오퍼레이션
- `server/index.js` receiver-config 라우트 — **이식 원본**(게이트 → 서비스 호출 → shape 매핑). 읽기 전용 참조
- `server-spring/src/main/java/harness/news/controller/UsersController.java` — 게이트·shape 매핑·`SessionTokens`·`JsonHttp` 패턴(본보기)
- `server-spring/src/main/java/harness/news/service/ReceiverConfigService.java` — step2가 만든 서비스
- `server-spring/src/main/java/harness/news/web/ReasonStatus.java` — 사유→상태(unauthenticated 401·forbidden 403이 이미 있다 — 추가 금지)
- `server-spring/src/main/java/harness/news/web/RoutePolicy.java` 136~138행 — 3 라우트가 이미 `AuthClass.ADMIN`으로 등재됨(수정 금지)
- `server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java` — 구현 라우트 목록(이 step에서 +3 → 23) · 메서드명·라우트 수 표기
- `scripts/spring-contract.mjs` 58~73행 — scope 표 `default` 행(이 step에서 파일 1개 추가)

## 배경 (동결된 계약 사실)

- 인증 클래스 `admin`: 경로 정책 필터가 **미인증 401**을 컨트롤러 앞에서 끊고(RoutePolicy에 이미 등재), 컨트롤러/서비스가 **비-Z 403**을 낸다(users-create와 같은 2층 구조).
- delete는 존재 판정을 하지 않는다: 자기 행 200 changes:1 · 같은 id 재삭제 200 changes:0 · NaN id(`/abc`) 200 changes:0(404 아님 — decisions (11)).
- `ReasonStatus`는 이미 unauthenticated 401·forbidden 403·not-found 404를 갖는다 — **이 step에서 매핑을 추가하지 마라**(decisions (7)).
- 응답은 반드시 `JsonHttp`로만 쓴다(Content-Type 바이트 패리티 — decisions (18)).

## 작업

### A. Node 대조 리포트 실측 (구현 전, decisions (17))

step1에서 이미 뽑았다면 그 리포트를 재사용하되, 없으면 다시 뽑아 `receiver-config-list`/`-create`/`-delete`의 status·bodyKeys·values·헤더(특히 `content-type` 문자열)를 확인한다.

```bash
cd /home/user/harness && OUT="$(mktemp -d)" && node scripts/contract-run.mjs --profile default --files contract/cases/default/receiver-config.contract.js --out "$OUT/node-rc.json" && ls -l "$OUT"
```

### B. `controller` 계층 — `ReceiverConfigController`

- `@GetMapping("/api/receiver-config")` list · `@PostMapping("/api/receiver-config")` create · `@DeleteMapping("/api/receiver-config/{id}")` delete.
- 각 핸들러: 쿠키 우선·`x-session-id` 폴백으로 토큰을 읽어(`SessionTokens`) 서비스 op를 부른다. 서비스가 `{ok:false,reason}`이면 `ReasonStatus.of(reason)`으로 매핑해 `JsonHttp.fail(reason)` 응답. 성공이면 200 + shape.
- list: `?query`를 서비스 filters로 넘긴다(화이트리스트 밖 키는 서비스/리포지토리가 무시). 반복/콤마 처리는 이 도메인 계약이 관측하지 않으므로 Node 라우트가 `req.query`를 그대로 넘기는 동형을 유지한다.
- delete: 경로 변수 id를 서비스가 기대하는 형태로 넘긴다(NaN 수렴은 리포지토리가 처리 — 작업 A 실측대로 200 changes:0).
- create/delete 응답: create `{ok:true,id}`, delete `{ok:true,changes}`. list `{ok:true,items}`.

### C. 인벤토리·scope 표 갱신 (같은 step에서 — 스텁 금지 게이트)

- `HandlerInventoryTest.IMPLEMENTED_ROUTES`에 `GET /api/receiver-config`·`POST /api/receiver-config`·`DELETE /api/receiver-config/:id` **3행**을 추가한다(→ 총 23). **같은 step에서** 메서드명(`exactlyTheTwentyImplementedRoutesHaveHandlers` → 23)·실패 메시지·javadoc의 라우트 수 표기(20 → 23)도 갱신한다.
- `server-spring/src/test/**`에 이 3 경로를 '미구현'으로 전제한 단언이 있는지 검색한다(있으면 phase 69 규율: 삭제·약화 금지, 이 phase가 구현하지 않는 라우트로 재조준). 계획 시점 관측: `PathPolicyWireTest`의 스텁 금지 프로브는 `GET /api/media/search`를 쓰므로 무관하다 — 재확인 결과를 요약에 1줄.
- `scripts/spring-contract.mjs` scope 표 `default` 행에 `contract/cases/default/receiver-config.contract.js`를 추가한다. **알파벳 정렬 위치**: `health.contract.js`와 `session-guard.contract.js` 사이.

### D. 와이어 테스트 (먼저 쓴다 — 전 기동 RANDOM_PORT + 원시 HTTP, MockMvc 금지)

1. Z create → 200 `{ok:true,id}`, 응답 전문에 `"password"`·`"apiKey"`·시크릿 원문 없음.
2. Z list → 200, 원소 정확 10키, createdAt null, 시크릿 키 없음.
3. list 화이트리스트 필터(자기 sourceId로 좁힘 1건 · 밖의 키 무시 · AND 불일치 빈 목록).
4. 미인증 401 · R 403(3 라우트 동형), 거부 후 행 불변.
5. delete 자기 행 200 changes:1 · 재삭제 200 changes:0 · `/abc` 200 changes:0.

## Acceptance Criteria

프레시 체크아웃이면 먼저: `cd /home/user/harness && npm ci`

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B verify
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B -q package -DskipTests
cd /home/user/harness && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 node scripts/spring-contract.mjs --parity
cd /home/user/harness && npm test
cd /home/user/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가(와이어 테스트분). 실측치를 요약에 적는다.
- 3번: exit 0이고 **default 프로파일에 receiver-config 케이스가 실제로 실행돼 관측 수가 늘어난 채** 4 프로파일 전부 `diffs=0`. `[diff] ... observations=<n>`의 `<n>`이 기준선 default 106보다 커졌는지 확인해 케이스 실행을 증명한다.
- 4번: **1328/1328**(불변 — `test/**`·`package.json` 무접촉).
- 5번 증분 = `server-spring/src/main/java/harness/news/controller/ReceiverConfigController.java` · `server-spring/src/test/java/harness/news/**` · `server-spring/src/test/java/harness/news/web/HandlerInventoryTest.java` · `scripts/spring-contract.mjs` · `phases/70-spring-admin-crud/index.json`.

## 검증 절차

1. **red 먼저**: D의 와이어 테스트를 구현 전에 돌려 실패를 실측한다(매핑 부재로 인증 요청은 404, 미인증은 이미 401 — 실제 관측값을 요약에).
2. AC 실행. `--parity` default 관측 수가 106 → 늘어난 것을 확인(안 늘면 scope 표 편집이 안 먹은 것).
3. **투영 누출 변이 실증(원복)**: 서비스가 아니라 컨트롤러에서 리포지토리 원본 행을 직접 실어 보내는 코드로 바꾸면 계약이 red인가(응답에 password 키 등장) — 확인 후 원복.
4. **DB 비파괴**: 하네스가 리포 `news.db`·`uploads/` 무변 단언. 요약에 크기·mtime 무변.
5. `git status --porcelain` 증분 확인 → index.json step3 갱신(관측 수 증가·green 확인 포함).

## 금지사항

- `ReasonStatus`에 새 매핑을 추가하지 마라. 이유: 이 도메인의 사유(unauthenticated·forbidden)는 이미 표에 있다 — 도달하지 않는 표를 부풀리면 착시가 쌓인다(phase 69 decisions (19)).
- 응답을 Spring MVC 메시지 컨버터(반환값 직렬화)로 만들지 마라. 이유: Content-Type의 세미콜론 뒤 공백이 사라져 전 관측이 diff가 된다 — `JsonHttp` 한 지점.
- delete에서 존재 판정(404)을 하지 마라. 이유: 계약은 없는 id·NaN id에 200 changes:0을 동결했다.
- `RoutePolicy` 표를 고치지 마라. 이유: 3 라우트가 이미 `AuthClass.ADMIN`으로 등재돼 있다.
- `HandlerInventoryTest`의 라우트 수 표기를 목록과 어긋난 채 두지 마라. 이유: 그 테스트가 주장하는 문장이 거짓이 된 채 green이 된다.
- 계약 파일(`contract/**`)·명세(`docs/api-contract/**`)를 고쳐 green을 맞추지 마라. 이유: 계약과 다르면 Spring을 고친다.
