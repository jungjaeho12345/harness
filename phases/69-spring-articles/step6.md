# Step 6: lock-service

**편집 잠금 서비스**를 만든다: 획득 · 해제 · 강제 해제 · 보유자 검사 4연산. 인가의 실체가 여기 있고, HTTP 계층(step8)은 이 판정을 그대로 상태코드로 옮긴다.

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — decisions **(11)(12)(19)(21)** · forward_notes (4)①②
- `src/services/articleService.js` 385~470행 — **이식 원본 4함수**(`acquireEditLock`·`releaseEditLock`·`forceReleaseEditLock`·`assertLockHolder`)와 그 CRITICAL 주석 전부. 특히 (a) 같은 탭 재획득 허용 (b) 같은 사용자·다른 세션 = 재로그인 takeover 허용 (c) 같은 세션의 다른 탭 차단 (d) 그 외 차단 (e) 실패 사유는 전부 `locked`/`not-holder`로 수렴하고 **누가 잠갔는지 노출하지 않는다**
- `src/services/articleService.js` 56~62행 — 30분 stale 판정(step1이 이식)
- `contract/cases/default/articles-write.contract.js` 190~300행·420~536행 — 잠금·해제·강제 해제의 합격 정의(성공 응답이 `{ok:true}` **뿐**이라는 것 포함)
- `src/services/authorization.js` 28~41행 — `editDps` 게이트(D 전용, `not-dps`면 통과) — **이 step은 그 게이트를 만들지 않는다**(step8에서 결선). 순서를 이해하기 위해 읽는다
- step1(stale 판정·시각 포매터) · step2(리포지토리의 잠금 설정/해제) 산출물

## 배경 (동결된 계약 사실)

- 보유자 식별자는 **편집 탭**(`x-edit-client` 헤더의 `clientId`)이다. 그러나 **인가는 clientId 하나로 하지 않는다** — 반드시 검증된 세션의 `userId`와 잠금 행의 `lockerUserId`를 함께 대조한다(ADR-004). `userId`가 없거나 행의 보유자 id가 비어 있으면 **거부**한다("미전달이면 통과" 폴백은 인가를 조용히 여는 구멍 그 자체다).
- **획득**: 잠겨 있고 stale이 아니면, 같은 탭이거나 같은 사용자의 다른 세션(재로그인)일 때만 통과하고 그 외에는 `locked`. 통과하면 5컬럼을 현재 시각으로 다시 세팅한다(재획득도 시각을 갱신한다).
- **해제**: 잠겨 있지 않으면 **멱등 성공**(탭 닫기·pagehide가 중복 호출한다). 잠겨 있으면 사용자 대조 → 탭 대조(행의 탭 값이 비어 있으면 탭 검사를 건너뛴다) → 해제.
- **강제 해제**: 보유자와 무관하게 해제한다. 존재하지 않으면 `not-found`. **권한(D/Z) 판정은 HTTP 계층**이 한다.
- **보유자 검사**(저장 인가): 잠금이 없으면 `not-holder`, 탭이 다르면 `not-holder`, 사용자가 다르거나 미상이면 `not-holder`. **존재하지 않으면 `not-found`이며 그것이 잠금 판정보다 먼저다**.
- **세션 일치는 강제하지 않는다**(해제·보유자 검사 모두). 강제하면 세션이 갱신된 편집자가 자기 잠금을 놓지 못해 편집물이 유실된다.
- 응답 사유는 `locked`(획득 충돌 · **401**로 매핑된다 — 423·409가 아니다) · `not-holder`(403) · `not-found`(404)뿐이다.

## 작업

### A. 값 동등성 규칙을 먼저 고정한다 (decisions (11) — 이 step의 최대 함정)

Node는 **DB NULL과 헤더 부재를 다른 값**으로 본다. 그래서:

- **보유 탭 일치**는 *양쪽이 모두 non-null이고 문자열이 같을 때만* 참이다. 둘 다 비어 있으면 **불일치**(= 거부)다. Java의 "둘 다 null이면 같다" 의미론을 그대로 쓰면 **보유자가 아닌 요청이 저장 인가를 얻는다**.
- 해제 경로의 탭 검사는 **행의 탭 값이 비어 있을 때만 건너뛴다**(의도된 관용 — 정본 그대로).
- 재로그인 판정의 세션 비교는 *다르면 참*이며 한쪽이 비어 있어도 다르다.
- 잠금 보유 여부(`held`)는 `lockYN`이 `'Y'`이고 **탭 값이 비어 있지 않을 때만** 참이다(빈 값이면 미보유로 보고 덮어쓴다).

이 4개를 **작은 판정 헬퍼 1곳**에 모으고 각각을 단위 테스트로 잠근다.

### B. 4연산 구현

- 각 연산은 먼저 행을 읽고(없으면 `not-found`) **투영되지 않은 원본**으로 판정한다(재로그인 판정에 세션 컬럼이 필요하다 — decisions (4)).
- 성공 응답에는 보유자 정보를 담지 않는다(`{ok:true}`만).
- 시각은 주입된 시계 + step1 포매터로만 만든다.

### C. 테스트 (먼저 쓴다 — `@TempDir` DB + 고정 시계)

1. 획득: 미잠금 → 성공 · 5컬럼이 채워지고 `lockYN='Y'`.
2. 획득: 같은 탭 재획득 → 성공(시각 갱신).
3. 획득: 같은 사용자·**다른 세션**(재로그인) → 성공(takeover).
4. 획득: 같은 세션·**다른 탭** → `locked`. 다른 사용자 → `locked`. **응답에 보유자 식별자가 없다.**
5. 획득: 30분 초과 stale이면 다른 사용자도 가져간다(고정 시계로 29:59 실패 / 30:01 성공).
6. 해제: 보유 탭 → 성공 · 5컬럼이 `'N'`/NULL로 돌아간다 · **행 수 불변**.
7. 해제: 잠겨 있지 않은 기사 → **멱등 성공**.
8. 해제: 다른 사용자(남의 탭 문자열을 그대로 흉내내도) → `not-holder` · 다른 탭 → `not-holder` · 잠금 유지 확인.
9. 보유자 검사: 잠금 없음 → `not-holder` · **탭 값·헤더가 둘 다 비어 있어도 `not-holder`**(A의 함정 — 이 케이스가 red면 인가 구멍이다) · 사용자 미상 → `not-holder` · 정상 → 통과.
10. 강제 해제: 보유자와 무관하게 해제 · 잠기지 않은 기사도 성공 · 없는 기사 → `not-found`.
11. 4연산 모두 없는 기사에 `not-found`를 돌려준다(보유자 판정보다 존재 판정이 먼저다).

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3번은 무회귀 확인(관측 수 불변 · `diffs=0`).

## 검증 절차

1. red 먼저(C의 11군). **9번의 red를 반드시 실측해 요약에 남긴다** — 그 케이스가 이 step의 핵심 인가 함정이다.
2. AC 실행 후 Java 테스트 수 증가분 기록.
3. **변이 실증 3종**(확인 후 원복): (a) 탭 일치 판정을 "둘 다 비어 있으면 같다"로 바꾸면 9번이 red인가(**인가 우회 재현 — 반드시 원복**) (b) 해제에서 사용자 대조를 빼면 8번이 red인가 (c) 획득 실패 응답에 보유자 userId를 담으면 4번이 red인가.
4. **시간축 한계 기록**: 30분 TTL은 고정 시계 단위 테스트만 덮는다(계약 스위트는 시계를 주입할 수 없다) — forward_notes (4)①에 해당한다는 사실을 요약에 적는다.
5. `git status --porcelain` 증분 = `server-spring/src/main/java/harness/news/service/**` · `server-spring/src/test/**` · `phases/69-spring-articles/index.json`.
6. index.json step6 status·summary 갱신.

## 금지사항

- `clientId`(헤더 문자열) 하나로 인가하지 마라. 이유: 클라이언트가 만든 탭 식별자일 뿐이다 — 남의 탭 문자열을 알면 잠금을 뺏는다. 인가는 검증된 세션의 `userId`와 함께 판정한다(ADR-004).
- "값이 없으면 통과" 폴백을 만들지 마라(`userId` 미전달·행의 보유자 미상 포함). 이유: 그 폴백이 곧 아무나 남의 잠금을 푸는 구멍이다.
- 실패 응답에 보유자 식별자·세션 토큰·탭 식별자를 담지 마라. 이유: 누가 잠갔는지 노출하지 않는 것이 계약이고, 탭 식별자는 사칭 재료다.
- 해제·보유자 검사에서 세션 일치를 강제하지 마라. 이유: 세션이 갱신된 편집자가 잠금을 놓지 못해 30분간 편집이 막히고 저장이 거부된다(편집물 유실).
- 잠금 해제를 행 삭제로 구현하지 마라. 이유: DB 비파괴 최상위 규칙 — 해제는 5컬럼 갱신이다.
- 존재 검사보다 잠금 검사를 먼저 하지 마라. 이유: 계약이 '없는 기사는 404'를 동결했다(403이 아니다).
- DPS 역할 게이트(`editDps`)를 이 서비스에 넣지 마라. 이유: 그 판정은 기사 상태 + 역할이고 HTTP 계층이 소유한다(step8) — 두 곳에 두면 판정이 갈라진다.
