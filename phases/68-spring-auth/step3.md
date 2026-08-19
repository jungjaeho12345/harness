# Step 3: session-core

## 목표
auth/session 슬라이스의 **핵심 서비스 계층**을 만든다: (1) 인메모리 세션 스토어(64-hex, 1시간 슬라이딩, 단일 세션 정책), (2) **세션 가드 — 매 요청 User 행 재도출**(ADR-004의 심장부), (3) 세션 쿠키 writer(프로덕션/비프로덕션 속성 분기 + 헤더 폴백). 컨트롤러/라우트는 이 step에 없다(step4 소유) — 서비스/필터 단위 테스트로 계약을 잠근다.

## 배경 — ADR-004 재도출 (이 step의 존재 이유, 자기완결)
- 신뢰 경계는 서버다. acting role은 **세션에서만** 도출하고, 로그인 시점 스냅샷이 아니라 **매 요청 User 행을 재조회**해 role/active를 다시 얻는다. 행이 없거나 `active='N'`이면 그 세션을 **즉시 무효화**(스토어에서 제거)한다. 캐시·TTL 금지.
- **스파이크의 함정**: `spikes/p0-spring/SessionStore.java`는 `Map<sessionId, User>`로 User 객체를 캐시한다 — 이는 ADR-004 위반이다(강등·비활성이 반영되지 않는다). 이 step은 세션에 **userId(+세션 메타)만** 저장하고, 신원(role/active)은 요청마다 DB에서 재도출한다.
- phase 67 테스트 게이트가 발견한 사실: 재도출을 "세션이 준 신원 그대로 반환"으로 바꿔도 계약 스위트가 green이었다 → `session-guard.contract.js`가 이 축을 잠그기 위해 신설됐다. step5에서 그 케이스를 green으로 만들려면 이 step의 재도출이 실제로 동작해야 한다.

## 계약 상세 (실측 — `contract/cases/default/auth.contract.js`·`session-guard.contract.js`·`prod-cookie/cookie-prod.contract.js`)
- 세션 토큰 = 소문자 64-hex. 운반: **쿠키 `sid` 우선 · `x-session-id` 헤더 폴백**. `?session=` 쿼리 폴백은 **없다**(유효 토큰이어도 401).
- 쿠키 속성:
  - 비프로덕션(`APS_PROD_COOKIE` 미설정/false): `sid=<값>; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`(**Secure 없음**).
  - 프로덕션(`APS_PROD_COOKIE=true`): 위와 같되 **Secure + SameSite=None**.
  - 로그아웃/무효화 쿠키: 빈 값 + `Max-Age=0`, 나머지 속성 동일(프로덕션이면 Secure+None).
- 단일 세션 정책: 같은 userId로 로그인하면 그 userId의 **기존 세션을 전부 무효화**한다(이전 토큰은 이후 401).
- 슬라이딩 만료 1시간: 유효 요청마다 만료 시각을 연장(touch). (SSE의 비연장 peek은 이 phase 밖 — REST 슬라이딩만.)
- 형식이 잘못된/미존재 토큰 → **401**(500 아님).

## 읽어야 할 파일
- `docs/ADR.md` ADR-004(재도출)·ADR-012(단일 인스턴스 — 세션 스토어가 프로세스 로컬인 이유, 배경만).
- `contract/cases/default/auth.contract.js` — 쿠키 속성·단일 세션·malformed 토큰 계약(단언 값의 정본).
- `contract/cases/default/session-guard.contract.js` — 재도출 축(강등→role 변화, 비활성→즉시 401, 무효화 영구성).
- `contract/cases/prod-cookie/cookie-prod.contract.js` — 프로덕션 쿠키(Secure+SameSite=None).
- `spikes/p0-spring/src/main/java/harness/p0_spring/{SessionStore,Sessions,ApiController}.java` — 참고(재도출 결함 유의).
- 이전 step 산출물: `server-spring/`의 `NewsDb`/repository(step2 — `findUser`로 재도출).

## 작업 (TDD — 테스트 먼저)
1. **테스트 먼저** `SessionStoreTest`: 발급 토큰이 64-hex; 같은 userId 재발급 시 이전 토큰 무효화(단일 세션); 슬라이딩 touch로 만료 연장; 만료/미존재 토큰 resolve → 없음.
2. **테스트 먼저** `SessionGuardTest`(repository는 임시 시드 DB 또는 테스트 더블): 유효 세션 → 현재 DB role/active로 신원 재도출; DB에서 role 변경 후 **재로그인 없이** 다음 재도출이 새 role 반영; `active='N'`으로 바꾸면 재도출이 세션을 제거하고 "무효" 반환; 제거 후 같은 토큰은 다시 살아나지 않음.
3. **테스트 먼저** `SessionCookieTest`: 비프로덕션 속성(HttpOnly·Path=/·Max-Age=3600·SameSite=Lax·Secure 없음); 프로덕션(`APS_PROD_COOKIE=true`) 속성(Secure·SameSite=None); 만료 쿠키(Max-Age=0·빈 값).
4. 구현:
   - `SessionStore`: `ConcurrentHashMap<sessionId, SessionEntry{userId, expiresAt}>` + `SecureRandom` 32바이트→64-hex. `issue(userId)`가 그 userId의 기존 항목을 제거(단일 세션). `peek(sid)`(비연장 조회)·`touch(sid)`(슬라이딩 연장)·`remove(sid)`.
   - `SessionGuard`: `resolve(sid) → Identity|null`. 흐름: `store.touch/peek로 userId 획득 → repository.findUser(userId) → 행 없거나 active='N'이면 store.remove(sid) 후 null → 아니면 Identity{userId,name,role,department,departmentCode}` 반환. **User 객체를 세션에 캐시하지 않는다.**
   - `SessionCookieWriter`: `APS_PROD_COOKIE` 설정을 주입받아 발급/만료 쿠키 문자열 생성. 토큰 판독기(쿠키 우선·헤더 폴백·쿼리 없음)도 여기 또는 `Sessions` 헬퍼에.
   - 생성자 주입으로 조립(합성 루트 단일 지점).

## Acceptance Criteria (실행 커맨드)
```bash
# 1) 세션 코어 유닛 테스트 green(스토어·가드 재도출·쿠키 속성)
mvn -f server-spring/pom.xml -q test
# 2) 재도출이 실제로 DB를 다시 읽는지 — 세션에 User 캐시가 없다는 구조 확인(정적)
grep -rn "class SessionStore" server-spring/src/main/java | head -1   # 존재 확인
! grep -rniE "Map<[^>]*, *User|cache.*[Uu]ser|user *=.*session" server-spring/src/main/java/harness/spring_auth/SessionStore.java
# 3) 정적 안전망
npm run lint
```
- 2)의 부정 grep 목적: 세션 스토어가 User 신원을 값으로 들고 있지 않음을 대략 확인(정확한 구조는 `SessionGuardTest`가 재도출로 증명). 구현 네이밍이 달라 이 grep이 부적절하면, 대신 `SessionGuardTest`에 "repository.findUser가 요청마다 호출된다"를 mock 호출 횟수로 단언해 대체하라(그 편이 강한 증거다).

## 검증 절차
- `SessionGuardTest`가 "강등→다음 요청 반영"과 "비활성→즉시 무효+영구"를 각각 별 테스트로 덮는지 확인(session-guard.contract.js의 두 축과 1:1).
- 쿠키 테스트가 프로덕션/비프로덕션 두 분기와 만료 쿠키를 모두 덮는지 확인.

## 금지사항
- 세션에 User(role/active)를 캐시하지 마라. 이유: 강등·비활성이 반영되지 않아 권한 상승(ADR-004 위반) — session-guard 계약이 red가 된다.
- 신원 재도출에 TTL/캐시를 두지 마라. 이유: "매 요청 재조회"가 계약이다(비활성 즉시 반영).
- `?session=` 쿼리 토큰 폴백을 만들지 마라. 이유: URL 누출 표면 — 계약상 존재하지 않는다(유효 토큰이어도 401이어야 함).
- HTTP 컨트롤러/`@RestController`를 이 step에서 만들지 마라. 이유: 라우트는 step4 소유(계층 분리).
