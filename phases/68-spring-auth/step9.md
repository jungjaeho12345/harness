# Step 9: logs-digest

in-memory 로그 링 버퍼와 `GET /api/logs/digest`(Z 전용)를 만든다. 이 step이 끝나면 `contract/cases/default/session-guard.contract.js`가 green이 되고, **이 phase의 인증/세션 축 계약 5파일이 전부 Spring 대상에서 green**이 된다.

`logs-digest`가 이 phase에 들어온 이유는 로그 도메인이 아니라 **세션 가드 축** 때문이다: session-guard 계약이 "Z 전용 라우트"로 이 엔드포인트를 써서 강등 전 200 → 강등 후 403을 검증한다.

## 읽어야 할 파일

- `phases/68-spring-auth/index.json` — decisions **(13)(14)(15)** · excluded (a)
- `contract/cases/default/session-guard.contract.js` — **판정 기준 원문**. 5케이스: 갓 로그인한 Z가 `GET /api/logs/digest` 200 → Z가 그 계정을 R로 강등하면 **재로그인 없이** 같은 토큰이 403 `{ok:false, reason:'forbidden'}` → `GET /api/session`의 role이 DB 최신값 → `active='N'`이면 즉시 401 → 무효화는 영구(다른 라우트에서도 401)
- `docs/api-contract/endpoints.json` — `logs-digest` 행(auth `admin`, expect `success`·`unauthenticated`·`forbidden`, notes "24h 창 경계는 미동결 — shape·인가만 동결")
- `docs/api-contract/openapi.yaml` — `logsDigest` 오퍼레이션 + `LogRecord` 스키마(**키 5개 필수: `seq`·`ts`·`level`·`message`·`line`**, level enum 4종)
- `docs/api-contract/README.md` "미검증·미동결 목록" — **갓 기동한 서버에서 `items`는 항상 빈 배열**이라는 실측(창이 항상 과거 구간이라 방금 쌓인 로그가 들어오지 않는다)
- `src/services/logService.js` — **이식 원본**(86행). 레벨 4종, 링 버퍼 cap 10000 FIFO, `seq` 단조 증가, `line` 포맷(`[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지`), 타임존 고정 오프셋(KST=540분) 주입, `digest`의 06:00 정렬 24시간 반열림 구간 계산
- `server/index.js` 1168~1175행(digest 라우트 — Z 게이트) · 545~553행(요청 로깅: **`req.path`만 담는다** — 쿼리·헤더·쿠키·바디 금지) — **읽기 전용 참조**
- `docs/ADR.md` ADR-007 · `docs/LOGS.md`(있다면 마스킹 규율)
- step3(가드)·step5(에러 응답)·step6(경로 정책·필터 순서) 산출물

## 배경 (동결된 계약 사실)

- **인가**: 미인증 401 `unauthenticated` · 인증됐지만 Z가 아니면 403 `forbidden`. `/api/stream`(로그인만 요구)과 달리 **role 게이트가 있다**.
- **응답 shape**: 200 `{ok:true, items:[LogRecord…]}`. 레코드는 5키 고정.
- **다이제스트 창**: `[전날 06:00, 당일 06:00)` KST. 창 경계 자체는 계약이 동결하지 않았다(시계 주입 불가) — **shape과 인가만** 동결이다. 갓 기동한 서버에서는 `items`가 빈 배열이 정상이다.
- **로그는 in-memory만**(파일·DB 저장 금지, ADR-007). cap 초과 시 오래된 것부터 evict.
- **마스킹**: 메시지에 비밀번호·세션 토큰·쿠키/Authorization 값·본문·쿼리스트링을 담지 않는다.
- `GET /api/logs/stream`(SSE)은 **이 phase 범위 밖**이다(excluded (a)).

## 작업

### A. `service` 패키지 — 로그 서비스

- 링 버퍼(cap 10000, FIFO evict) + 레벨 4종 + 프로세스 수명 동안 단조 증가하는 `seq`(evict돼도 재사용 없음).
- `line` 포맷과 타임존 처리는 이식 원본과 동형으로 하되, **시각은 주입 `Clock`**에서만 읽는다(decisions (14)). 타임존 오프셋은 고정값(분 단위)으로 주입 가능하게 둔다 — 프로세스 기본 타임존에 의존하면 서버 환경에 따라 창이 달라진다.
- `digest(at)` = 06:00 정렬 경계를 잡아 `[경계-24h, 경계)` 반열림 구간의 레코드.
- 구독(subscribe) API는 만들지 않아도 된다(SSE가 범위 밖) — 만들지 않는 쪽을 택하고 그 사실을 주석에 남긴다.

### B. `web` 패키지 — 요청 로깅 필터

- 응답 완료 시점에 `메서드 경로 상태 소요시간(ms)` 1줄을 INFO로 남긴다. **경로만**(쿼리스트링 금지), 헤더·쿠키·바디 금지.
- 필터 순서: CORS 다음, CSRF 앞(Node 동형 — 거부 403도 액세스 로그에 남는다). step6의 순서 상수에 추가한다.

### C. `controller` 패키지 — `GET /api/logs/digest`

- 세션 가드로 신원 조회 → 없으면 401, role이 Z가 아니면 403 → 그 외 200 `{ok:true, items: digest()}`.
- 경로 정책 표(step6)에 이 경로가 보호 경로로 들어 있는지 확인한다.

### D. 테스트(먼저 쓴다)

1. **단위**: 링 버퍼 FIFO evict(cap 경계) · `seq` 단조 증가 · `line` 포맷 · **다이제스트 창 계산**(고정 시계로 경계 전후 레코드를 넣어 포함/제외 판정 — 05:59:59.999와 06:00:00.000의 경계 포함).
2. **와이어**(RANDOM_PORT + 원시 HTTP): 미인증 401 JSON · R/D 세션 403 JSON · Z 세션 200 + 본문 키가 정확히 `{ok, items}` · `items` 원소가 있으면 5키(없으면 빈 배열이 정상 — **개수를 단언하지 마라**).
3. **마스킹**: 쿼리스트링이 붙은 요청을 보낸 뒤 버퍼 내용에 쿼리 문자열이 없는지 확인한다.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && node scripts/spring-contract.mjs --profile default --files contract/cases/default/session-guard.contract.js
cd /d/agents/harness && node scripts/spring-contract.mjs --profile default
cd /d/agents/harness && node scripts/spring-contract.mjs --profile default --parity
cd /d/agents/harness && node scripts/spring-contract.mjs --profile default --dual-run
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3번: session-guard 계약 green(이 step의 목표).
- 4번: `default` 프로파일의 **scope 표 전체**(auth + crosscutting + health + session-guard) green — 네 파일이 한 실행에서 정렬 순서대로 도는지(공용 세션 복구 규약이 실제로 동작하는지) 확인하는 지점이다.
- 5번: 패리티 diff 0.
- 6번: 자기 결정성 — 하네스가 **새 DATA_DIR + 새 Spring 프로세스로 두 패스**를 돌린다(같은 인스턴스 2회는 로그인 예산 12회 > 10으로 확정 red다 — step1 배경).

## 검증 절차

1. red 먼저(D). 특히 다이제스트 창 경계 테스트의 red를 확인한다.
2. AC 실행. 4번은 **연속 2회** green이어야 한다(로그인 예산: 러너 3 + auth 2 + session-guard 1 = 6 ≤ 10, 그리고 실행마다 새 인스턴스라 카운터가 리셋된다).
3. **변이 실증 3종**(확인 후 원복): (a) digest의 Z 게이트를 제거하면 session-guard의 강등 케이스가 red인가, (b) 세션 가드의 재도출을 제거하면(step3 변이 재적용) **session-guard 5케이스 중 4건이 red**인가 — phase 67 ④ 게이트가 Node에서 관측한 것과 같은 패턴이 Spring에서도 재현되는지 확인하고 결과를 요약에 적는다, (c) 요청 로깅에 쿼리스트링을 포함시키면 마스킹 테스트가 red인가.
4. AC 6번(`--dual-run`)에서 리포트 diff 0과 **두 패스의 임시 DATA_DIR·java PID 상이**를 확인한다. 다이제스트 `items`가 비어 있지 않게 되면 비결정 요소(ts·seq)가 리포트로 샐 수 있다 — 실제 관측(빈 배열인지 여부)을 요약에 적는다.
5. **누출 스캔**: 리포트·로그 버퍼에 세션 토큰(64-hex)·비밀번호·쿠키 값이 없는지 확인.
6. `git status --porcelain` 증분 = `server-spring/src/main/**` · `server-spring/src/test/**` · `phases/68-spring-auth/index.json`.
7. index.json step9 status·summary 갱신(변이 (b)의 red 건수 포함).

## 금지사항

- 로그를 파일·DB에 저장하지 마라. 이유: ADR-007·LOGS.md의 "파일 미저장" 결정이고, DB에 쓰면 무한 증식 + DB 비파괴 규칙과 충돌한다.
- 요청 로그에 쿼리스트링·헤더·쿠키·바디를 담지 마라. 이유: 세션 토큰·비밀번호가 그대로 링 버퍼에 남고, 그 버퍼는 Z 전용이지만 다이제스트 API로 **밖으로 나간다**.
- 다이제스트를 앱 내 타이머로 주기 전송하지 마라(`@Scheduled` 금지). 이유: "매일 6시 전달"은 앱이 아니라 운영 루틴이 이 API를 pull해서 한다(ADR-007·ADR-008 — 앱 내 타이머 0·egress 0).
- `items` 개수를 계약 판정 근거로 삼지 마라(테스트에서도). 이유: 갓 기동한 서버에서는 항상 빈 배열이며, 개수를 단언하면 환경에 따라 흔들린다.
- `GET /api/logs/stream`(SSE)을 구현하지 마라. 이유: excluded (a) — SSE는 프레임 바이트 계약(`docs/api-contract/sse.md`)과 push 시점 비연장 재검증까지 함께 다뤄야 하는 별도 축이다.
- 프로세스 기본 타임존에 의존하지 마라(고정 오프셋 주입). 이유: 서버 TZ 설정에 따라 24h 창이 통째로 밀린다.
- 로그 레벨·포맷을 Spring 기본 로거(Logback) 출력으로 대체하지 마라. 이유: 계약이 요구하는 것은 **API로 나가는 레코드 5키**이며, 그것을 만드는 링 버퍼가 별도로 있어야 한다(콘솔 출력은 별개 문제다).
