# Step 2: session-core

세션 코어를 만든다. 이 phase의 **가장 중요한 보안 불변식**은 ADR-004의 "acting 신원은 로그인 스냅샷이 아니라 **매 요청 User 행 재조회로 재도출**"이다. phase 67 테스트 게이트가 이 축의 공백(가드를 빼도 계약이 green)을 발견했으므로, Spring 이식에서 절대 빠뜨리면 안 된다.

## 읽어야 할 파일

- `/home/user/harness/phases/68-spring-auth/step1.md` 과 이전 산출물 — `findUser(userId)`(role·active 최신값 재조회 경로), 패키지 base `harness.server`.
- `/home/user/harness/docs/ADR.md` — **ADR-004 전문**(세션에서만 role 도출 · 1시간 슬라이딩 idle 만료 · 매 요청 User 재조회 · 행 없거나 active='N'이면 즉시 무효화 · 캐시/TTL 금지).
- `/home/user/harness/contract/cases/default/session-guard.contract.js` — **재도출 계약의 실측 케이스**(강등은 재로그인 없이 다음 요청 403 · GET /api/session의 user는 DB 최신값 · active='N'은 즉시 401이며 영구적이라 다른 라우트에서도 되살아나지 않음).
- `/home/user/harness/contract/cases/default/auth.contract.js` — 단일 세션 정책(재로그인이 같은 userId의 기존 세션 전부 무효화) · sid 64-hex · `x-session-id` 헤더/쿠키 2수단 · ?session= 쿼리 폴백 부재 · 잘못된 토큰은 401(500 아님).
- `/home/user/harness/spikes/p0-spring/src/main/java/harness/p0_spring/SessionStore.java`·`Sessions.java` — SecureRandom 64-hex·ConcurrentHashMap 패턴 참고(단 스파이크는 만료·재도출·단일세션이 없다 — 이 step이 그것을 더한다).

## 작업

`harness.server`에 세션 저장소(`SessionStore`)와 세션 신원 도출(guard)을 만든다. **세션에는 User 객체 스냅샷이 아니라 `userId`(+ 발급/최근접근 시각)만 저장**하고, 조회 때마다 `findUser(userId)`로 최신 행을 재도출한다.

시그니처(재량이되 계약 고정):

- `String issue(String userId)` — 64자 소문자 hex(SecureRandom 32바이트) 토큰 발급. **단일 세션 정책**: 발급 전에 같은 `userId`의 기존 세션 엔트리를 전부 제거한다(재로그인이 이전 세션을 죽인다).
- `User resolve(String sessionId, long now)` — 없는/만료/무효 세션이면 `null`. 유효하면:
  1. 슬라이딩 idle 만료: 마지막 접근 시각 + 3600_000ms < now 이면 만료 → 엔트리 제거 후 null.
  2. `findUser(userId)` 재조회. 행이 없거나 `active='N'`이면 → **그 세션 엔트리를 영구 제거**하고 null(무효화는 영구적 — 같은 토큰이 다른 라우트에서 되살아나면 안 된다).
  3. 살아 있으면 마지막 접근 시각을 now로 갱신(슬라이딩 연장)하고 **재조회한 최신 User**를 반환한다(로그인 시점 role/부서가 아니라 DB 최신값).
- `void remove(String sessionId)` — 멱등 제거(로그아웃용).
- 세션ID 추출 헬퍼: 쿠키 `sid` 우선, 없으면 `x-session-id` 헤더 폴백. **쿼리스트링 `?session=`은 읽지 않는다**(URL/로그 누출 표면 금지 — ADR-005/007 규율).
- 시계는 주입 가능하게(`now`를 인자로 받거나 `Clock` 주입) — 테스트 결정성(userService `now` 패턴 동형).

핵심 규칙(반드시 박기):

- **캐시/TTL로 role·active를 굳히지 마라.** 매 `resolve`가 `findUser`를 호출한다(마이크로초 비용 — ADR-004 트레이드오프 수용). 스냅샷 반환은 이 phase가 막으려는 바로 그 결함이다.
- 무효화(만료·비활성·행 없음)는 **엔트리 제거**로 한다(그 요청만 거부가 아니라 스토어에서 삭제 — session-guard의 "영구적" 음성 증거).
- 토큰 형식이 잘못돼도 예외를 던지지 말고 `null`(→ 상위가 401). 500이 되면 계약 위반이다.

### 테스트(TDD, 먼저 작성)

임시 DB(테스트 셋업 DDL로 User 세움) 위에서:
- issue→resolve 왕복, remove 멱등, 알 수 없는 토큰 null.
- 단일 세션: 같은 userId 두 번 issue → 첫 토큰 resolve는 null.
- **재도출**: issue 후 DB에서 role을 R→변경 → resolve가 새 role을 반영. active='N'으로 UPDATE → resolve null이고, **같은 토큰 재resolve도 null**(영구 제거). User 행이 사라진(테스트가 UPDATE로 시뮬레이트 불가하면 findUser가 null 반환하도록) 경우 null.
- 슬라이딩 만료: now를 3600_000ms+1 진행 → null. 경계 직전 접근 → 연장돼 유효.

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && ./mvnw -q -DskipTests=false test
```

- 세션 코어 테스트 전부 green(특히 재도출·단일세션·영구 무효화·슬라이딩 만료).

## 검증 절차

1. AC 실행.
2. 아키텍처 체크리스트:
   - `resolve`가 매번 `findUser`를 호출하는가(스냅샷 반환 아님)?
   - active='N'/행 없음이 엔트리를 **제거**하는가(영구 무효화)?
   - 쿼리 폴백을 읽지 않는가? 잘못된 토큰이 예외 대신 null인가?
   - 시계가 주입 가능한가?
3. 결과 반영: 성공 → `completed` + `summary`(SessionStore API·재도출/단일세션/만료 테스트). 실패 3회 → `error`. 외부 요인 → `blocked`.

## 금지사항

- 로그인 시점 User 스냅샷을 세션에 저장해 그대로 반환하지 마라. 이유: 강등·비활성 계정이 최대 1시간 이전 권한을 유지하는 권한 상승(ADR-004, phase 67 게이트가 잡은 결함).
- role·active를 캐시/TTL로 굳히지 마라. 이유: 매 요청 재도출이 계약이다.
- 잘못된 토큰에서 예외를 던지지 마라. 이유: 401이어야 할 자리가 500이 되면 계약 위반(auth.contract "malformed-token").
- `server/**`·`src/**`·`web/**`·`contract/**`·`docs/**`를 수정하지 마라. 이유: 기존 npm test 1328 불변.
- 기존 테스트를 깨뜨리지 마라.
