# Step 11: articles-query-http

기사 **조회 표면 4개**를 만든다: `GET /api/articles/search` · `GET /api/articles` · `GET /api/articles/:id/history` · `GET /api/articles/:id/history/:historyId`. 그리고 **`minimal` 프로파일을 하네스 scope 표에 새로 올린다**.

이 step에서 **`articles-read.contract.js`와 `transitions.contract.js`가 동시에 green이 된다**(두 파일이 기다리던 마지막 조각이 목록·검색·이력이다 — index.json `order` (a)). 이 phase의 계약 4파일이 여기서 전부 닫힌다.

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — decisions **(2)(3)(4)(5)(9)(10)(12)(15)(19)(23)** · order (a)(e)
- `server/index.js` 378~390행(`FILTER_KEYS` 13키·`pickFilters`) · 793~852행(**이식 원본 4라우트** — 특히 이력 목록의 `sendOnly` 판정식과 스냅샷 라우트의 정수 판정)
- `contract/cases/default/articles-read.contract.js` 전부 — **합격 정의**(투영 27키·검색 5키·이력 12키·스냅샷 7키·필터 전수·반복 키·콤마 미분해·스칼라 반복 500·`sendOnly` 8변형·404 4종)
- `contract/cases/minimal/transitions.contract.js` 390~420행 — 이력 부수효과 케이스(이 파일이 이력 라우트를 요구하는 지점)
- `scripts/spring-contract.mjs` 55~80행 — scope 표(**default 행에 파일 1개 추가 + `minimal` 프로파일 행 신설**)
- `scripts/contract-run.mjs` 53~60행 — `minimal` 프리셋의 정의(`sessions:true, spool:false, token:false`) — 읽기 전용
- step4(읽기 서비스) · step2(필터 매핑·스칼라 반복 예외) · step3(이력 리포지토리) 산출물

## 배경 (동결된 계약 사실)

- **목록**: 200 `{ok:true, items}` **정확히 2키**(총수·페이징 없음). 필터는 **13키 화이트리스트**이고 그 밖의 키는 **조용히 무시**된다(400이 아니다). 배열 허용은 `status`·`excludeStatus`·`departments` 3키뿐이며 **나머지 키를 반복하면 500 `internal-error`**다(결함 후보 #4 재현 — decisions (9)). 콤마 표기는 분해되지 않는다.
- **검색**: 200 `{ok:true, items}`. `q` 미전달·빈 문자열은 **전 행 매칭**이고 무매칭도 200 빈 목록이다. 행은 `Article` **5키**.
- **이력 목록**: 200 `{ok:true, items}`. 이력이 없거나 **기사가 존재하지 않아도 빈 배열**(404가 아니다). 행은 **12키**(파생 `title`·`version`·`status` 포함, 본문 blob·저장 제목 없음). `hasSnapshot`은 **정수 1/0**.
- **`sendOnly` 판정**: 파라미터가 존재하고 값이 `'0'`도 `'false'`도 아니면 참(빈 문자열·`'no'`도 참), 또는 `type === 'send'`면 참. 계약이 8변형을 전수 동결했다.
- **단건 스냅샷**: 200 `{ok:true, item}`이고 `item`은 **7키**(본문 포함, 전이 컬럼 없음). 스냅샷이 없는 전이 행도 200이고 본문만 `null`. **비정수·미존재·타 기사 스코프는 전부 404 `not-found`**. 정수 판정은 Node의 숫자 변환 의미론을 따른다(`'abc'`·`'1.5'`는 404).
- **`minimal` 프로파일**: Node 러너 프리셋이 스풀·수집 토큰을 주지 않는 구성이며 세션은 준비한다. Spring에는 배부 구현이 없어 **추가 env가 필요 없다**(decisions (2)). 프로파일은 **전용 프로세스 + 전용 임시 DATA_DIR**로 뜬다(하네스가 이미 그렇게 한다).
- 미인증은 4라우트 전부 401 JSON(경로 정책 필터).

## 작업

### A. Node 대조 리포트 실측 (구현 전, decisions (23))

```bash
cd /d/agents/harness && node scripts/contract-run.mjs --profile default --files contract/cases/default/articles-read.contract.js --out "$TMPDIR/node-ar.json"
cd /d/agents/harness && node scripts/contract-run.mjs --profile minimal --files contract/cases/minimal/transitions.contract.js --out "$TMPDIR/node-tr2.json"
```

`articles-list`·`articles-search`·`articles-history`·`articles-history-snapshot` 관측의 `status`·`bodyKeys`·`values`(특히 `rowKeys` 문자열)와 `x-articles-list-repeated-scalar-key`의 **500** 관측을 확인하고 요약에 적는다.

### B. 컨트롤러 4개

- **목록**: 신원 → 요청 파라미터에서 **13키만** 뽑아(원문 값 배열 그대로) 서비스에 넘긴다 → `{ok:true, items}`. 화이트리스트 밖 키는 버린다. 스칼라 키 반복은 리포지토리가 예외를 던져 전역 핸들러의 500이 된다(**컨트롤러에서 미리 400으로 막지 마라**).
- **검색**: 신원 → `q`(없으면 빈 문자열) → 서비스 → `{ok:true, items}`.
- **이력 목록**: 신원 → `sendOnly`/`type` 판정(위 규칙 그대로) → 서비스 → `{ok:true, items}`.
- **단건 스냅샷**: 신원 → `historyId` 정수 판정(아니면 **404**) → 서비스 → 없으면 404 `not-found`, 있으면 `{ok:true, item}`.
- 라우트 매핑 순서 주의: `/api/articles/search`는 `/api/articles/{id}`보다 **구체적**이어야 한다(리터럴 우선 — 매핑이 겹치지 않는지 테스트로 확인한다).

### C. scope 표 · 인벤토리 갱신

- `scripts/spring-contract.mjs`:
  - default 행 `files`에 `contract/cases/default/articles-read.contract.js`를 **알파벳 순서 위치**(목록 맨 앞)에 추가한다.
  - **`minimal` 프로파일 행을 신설**한다: `files: ['contract/cases/minimal/transitions.contract.js']` · `extraEnv: {}`. 주석에 "스풀·수집 토큰 미설정이 프로파일의 정의이고 Spring은 배부 구현이 없어 추가 env가 없다(index.json decisions (2))"를 남긴다. 행 위치는 러너 프리셋 순서와 맞춘다(default 다음).
  - **`minimal` 디렉토리에는 이 phase가 소유하지 않는 케이스 파일 2개**(`collection-open`·`distribution-disabled`)가 있다 — 그래서 `files`를 **명시**해야 한다(비우면 러너가 디렉토리를 스캔해 미구현 도메인까지 돌린다).
- `HandlerInventoryTest`에 4행 추가(이 phase 총 13 라우트 + 68의 7 = **20**이 된다).

### D. 테스트 (먼저 쓴다 — 전 기동 + 원시 HTTP)

1. 목록 2키 · 행 27키 · **잠긴 행에서도 두 잠금 컬럼 없음** · 역할(R/D/Z) 무관하게 같은 결과.
2. 필터: 반복 키 IN/NOT IN · 콤마 미분해 · `departments` 우선 · 날짜 범위에서 NULL 행 탈락 · 13키 동시 사용 200 · 화이트리스트 밖 키 무시.
3. **스칼라 키 반복 → 500 `{ok:false,reason:'internal-error'}`**(400이 아니다).
4. 검색: 토큰 매칭 · 행 5키 · 빈 `q` 전 행 · `q` 미전달 · 무매칭 200 빈 목록.
5. 이력 목록: 갓 만든 기사 → 빈 배열 · 없는 기사 → 빈 배열 · 행 12키 · `hasSnapshot` 정수 · 파생 `version`/`status`/`title`.
6. `sendOnly` 8변형 전수(계약의 표 그대로).
7. 스냅샷: 편집 행 7키·본문 왕복 · 전이 행 200 + 본문 `null` · 비정수/미존재/타 기사 스코프 404.
8. 미인증 4라우트 401 JSON · 경로 파라미터·퍼센트 인코딩 변형에서도 401 유지.
9. `/api/articles/search`가 단건 조회 매핑에 흡수되지 않는다(둘 다 정상 동작).
10. **투영 정적 스캔 테스트 신설**(decisions (4)①): `src/main/java` 전체에서 두 잠금 컬럼명 문자열이 **화이트리스트 파일에만** 등장한다. 화이트리스트는 투영 클래스 · 컬럼 목록 상수 · 잠금 리포지토리/서비스로 제한하고, 목록에 없는 파일에서 발견되면 실패 메시지에 경로를 담는다.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --profile default --files contract/cases/default/articles-read.contract.js --parity
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --profile minimal --parity
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3번·4번: 이 step의 본 게이트 — 두 계약 파일이 각각 green이고 `diffs=0`.
- 5번: scope 표 전체(**4 프로파일**: default 7파일 · minimal 1 · auth-negative 1 · prod-cookie 1) exit 0 · 전 프로파일 `diffs=0`.
- 6번: **1328/1328**.

## 검증 절차

1. red 먼저(D의 10군). 특히 3번(스칼라 반복 500)과 10번(정적 스캔)의 red를 실측해 적는다.
2. AC 실행. 각 프로파일의 `observations`·`diffs`를 요약에 기록한다(이 phase의 최종 수치는 step12가 다시 측정한다).
3. **decisions (3) 재확인**: `minimal`과 `default` 양쪽에서 송고를 포함한 관측이 `diffs=0`이라는 사실을 적는다(배부 없는 Spring이 두 프로파일 모두에서 동형).
4. **변이 실증 4종**(확인 후 원복): (a) 스칼라 반복을 400으로 바꾸면 3번이 red인가 (b) 콤마를 분해하면 2번이 red인가 (c) 이력 목록에 본문을 실으면 5번(12키)이 red인가 (d) 목록 응답 조립에서 투영을 우회하면 1번과 10번이 **둘 다** red인가(2층 방어 실증).
5. **DB 비파괴**: 하네스의 리포 `news.db`·`uploads/` 무변 단언 + 크기·mtime 눈 확인.
6. `git status --porcelain` 증분 = `server-spring/src/main/java/harness/news/{controller,web}/**` · `server-spring/src/test/**` · `scripts/spring-contract.mjs` · `phases/69-spring-articles/index.json`.
7. index.json step11 status·summary 갱신(계약 4파일 전부 green · `minimal` 프로파일 신설 · derive의 계약 편입 완료 명시 — decisions (15)의 예외가 닫혔다).

## 금지사항

- 스칼라 전용 필터 키의 반복을 400으로 막지 마라. 이유: 계약이 500을 동결했다(결함 후보 #4). 고치는 것은 Node·명세·케이스를 함께 바꾸는 별도 판단이다.
- 쿼리 값에 콤마 분해·트림·형변환을 넣지 마라(`@RequestParam List<String>` 기본 동작 포함). 이유: `?status=RDS,DDH`가 매칭 0건인 것이 계약이다.
- 이력 목록에 본문·저장 제목·배부 컬럼(`targetId`·`reason`)을 싣지 마라. 이유: 12키 계약이고 배부 컬럼은 Z 전용 표면이다.
- 빈 결과·없는 기사에 404를 돌려주지 마라(목록·검색·이력). 이유: 200 + 빈 배열이 계약이다. 반대로 **단건 스냅샷은 404**다 — 두 규칙을 섞지 마라.
- `minimal` 프로파일의 `files`를 비워 두지 마라. 이유: 러너가 디렉토리를 스캔해 이 phase가 구현하지 않은 수집·배부 케이스까지 돌린다(설정 실수가 계약 실패로 위장된다).
- `minimal` 프로파일에 배부·수집 관련 env를 주지 마라. 이유: 스풀·토큰 미설정이 프로파일의 정의이며 그것이 전이 관측의 결정성을 만든다.
- 응답을 메시지 컨버터로 반환하지 마라(decisions (22)).
