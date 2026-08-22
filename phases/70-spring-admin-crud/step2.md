# Step 2: receiver-config-service

수집 수신 설정 서비스를 만든다 — `ReceiverConfigService`(Z 게이트 → 조회 시 **SAFE_FIELDS 10키 투영** · 생성 · 삭제). 인가 게이트는 `Authorization`에 `MANAGE_RECEIVER_CONFIG` capability를 추가해 재사용한다.

이 step은 **service 계층만** 건드린다. 컨트롤러가 없어 `receiver-config.contract.js`는 아직 green이 될 수 없다 — 판정은 Java 서비스 단위 테스트 + 이미 green인 scope 무회귀다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — decisions **(3)(4)(7)(8)(12)(14)** · forward_notes (4)
- `src/services/receiverConfigService.js` — **이식 원본**(SAFE_FIELDS 10키 · sanitize · query/create/remove가 각각 `authorization.manageReceiverConfig`로 게이트 → 실패면 그대로 반환). 읽기 전용 참조
- `src/services/authorization.js` 8행·52~59행 — `manageReceiverConfig: ['Z']`와 세션→role 판정(unauthenticated/forbidden)
- `server-spring/src/main/java/harness/news/service/Authorization.java` — capability 맵·`authorize(token, capability)`·`Decision` record(이 step에서 capability 1개 추가)
- `server-spring/src/main/java/harness/news/service/UserService.java` — SAFE_FIELDS 투영 헬퍼 패턴(재사용 본보기)
- `server-spring/src/main/java/harness/news/model/ReceiverConfigRepository.java` — step1이 만든 리포지토리(query/insert/remove)
- `server-spring/src/test/java/harness/news/service/*` — 서비스 단위 테스트 형식(SessionStore/Authorization 주입)

## 배경 (동결된 계약 사실)

- **3 op 전부 Z 전용**: 미인증 → `unauthenticated`(→401) · 비-Z → `forbidden`(→403). 게이트는 라우트가 아니라 서비스가 세션 토큰으로 판정한다(Spring에서 게이트 위치가 바뀌어도 계약은 동일).
- **SAFE_FIELDS 10키(정렬)**: `active,apiEndpoint,createdAt,host,id,name,port,sourceId,type,username`. `password`(FTP)·`apiKey`(API)는 **쓰기 전용 시크릿**이라 어떤 응답에도 없다. 투영은 **allowlist**(담을 것만 나열 — 빼기 방식 금지, decisions (3)).
- 목록 원소는 항상 정확 10키다(미지정 컬럼도 `null`로 실린다 — NULL 키 보존, decisions (4)). `createdAt`은 서버가 채우지 않으면 `null`.
- create 응답은 `{ok:true,id:<정수>}`(user 객체를 되돌려주지 않는다 — 시크릿 반향 원천 차단). remove 응답은 `{ok:true,changes:<int>}`.
- 검증이 없다: type·sourceId 미검증. 게이트 통과 시 항상 성공(입력 검증을 추가하지 마라 — 이 도메인은 결함 재현 대상이 아니지만 계약이 '검증 없음'을 동결했다).

## 작업

### A. `Authorization`에 capability 추가 (같은 step에서)

- `MANAGE_RECEIVER_CONFIG = "manageReceiverConfig"` 상수 + capability 맵에 `MANAGE_RECEIVER_CONFIG → List.of("Z")` 항목을 추가한다. `authorize(token, MANAGE_RECEIVER_CONFIG)`가 미인증 `unauthenticated`·비-Z `forbidden`을 낸다(기존 `MANAGE_USERS` 패턴 동형).
- role은 **오직 세션에서 재도출한 값**만 쓴다(ADR-004 — 본문·헤더·쿼리의 role은 판정에 닿지 않는다, `Authorization`의 공개 API가 role을 파라미터로 받지 않는 불변식 유지).

### B. `service` 계층 — `ReceiverConfigService`

- 생성자 주입(`ReceiverConfigRepository`, `Authorization`). 시그니처(구현 재량 — Node의 `{ok,...}` 결과 객체 동형으로 게이트 실패를 그대로 전파):
  - `Result query(String sessionToken, Map<String,Object> filters)` — 게이트 → 통과면 `repo.query(filters)`를 **행마다 sanitize(SAFE_FIELDS 10키)** 하여 items 반환.
  - `Result create(String sessionToken, Map<String,Object> entry)` — 게이트 → 통과면 `repo.insert(entry)` id 반환.
  - `Result remove(String sessionToken, long id)` — 게이트 → 통과면 `repo.remove(id)` changes 반환.
- `sanitize`는 SAFE_FIELDS allowlist를 순서대로 도는 `LinkedHashMap`(값 없으면 `null` — 키 보존). 시크릿(password·apiKey)은 allowlist에 없으므로 자연히 빠진다.
- 게이트 실패 시 서비스는 `{ok:false, reason}`만 반환하고 리포지토리를 부르지 않는다(거부된 요청이 행을 만들거나 지우지 못하게 — 계약이 실측).

### C. 테스트 (먼저 쓴다 — 서비스 단위, Authorization/SessionStore 주입)

1. Z 세션 create → id 양수. 응답에 password·apiKey 없음(반환 객체가 애초에 id만).
2. Z 세션 query → 원소가 정확 10키, 시크릿 키 부재, 미지정 컬럼은 null 키 보존.
3. 비-Z(R) 세션 → 3 op 전부 `{ok:false,reason:'forbidden'}`, 리포지토리 호출 0(행 불변).
4. 미인증(무토큰/무효 토큰) → `{ok:false,reason:'unauthenticated'}`.
5. remove(자기 id) → changes 1 · 재remove → changes 0.
6. **투영 allowlist 실증**: 리포지토리가 password를 담은 행을 돌려줘도 sanitize 후 그 키가 없다.

## Acceptance Criteria

프레시 체크아웃이면 먼저: `cd /home/user/harness && npm ci`

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B verify
cd /home/user/harness && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 node scripts/spring-contract.mjs --parity
cd /home/user/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가. 실측치를 요약에 적는다.
- 2번: exit 0 · 4 프로파일 diffs 0 · 관측 수 170 그대로(HTTP가 없어 계약 파일은 여전히 scope 밖).
- 3번 증분 = `server-spring/src/main/java/harness/news/service/ReceiverConfigService.java` · `.../service/Authorization.java`(capability 1개 추가) · `server-spring/src/test/java/harness/news/service/*` · `phases/70-spring-admin-crud/index.json`.

## 검증 절차

1. **red 먼저**: 서비스 단위 테스트를 구현 전에 돌려 실패를 실측.
2. **투영 변이 실증(원복)**: SAFE_FIELDS에 `password`를 한 키 추가하면 6번 테스트가 red인가(allowlist가 진짜 방어선인지) — 확인 후 원복.
3. AC 실행. `--parity` 관측 수 170 불변 확인.
4. index.json step2 갱신.

## 금지사항

- 응답/반환에 `password`·`apiKey`를 담지 마라. 이유: 쓰기 전용 시크릿이 계약이다(SAFE_FIELDS 10키).
- SAFE_FIELDS를 '전체에서 시크릿을 빼는' 방식으로 만들지 마라. 이유: 새 시크릿 컬럼이 스키마에 추가되면 조용히 노출된다 — allowlist는 언제나 담을 것의 목록이다.
- 입력 검증(type·sourceId 등)을 추가하지 마라. 이유: 계약이 '검증 없음'을 동결했다(게이트 통과 시 항상 성공).
- role을 본문·헤더·쿼리에서 읽지 마라. 이유: acting role은 검증된 세션에서만(ADR-004).
- 컨트롤러를 만들거나 scope 표를 늘리지 마라. 이유: 이 step은 service 계층 전용(실패 원인 격리).
