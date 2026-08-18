# P0(a) 패리티 스파이크 — 최소 와이어 계약 (2026-08-18 현행 코드 실측)

목표: **기존 `web/dist` SPA가 무수정으로 붙어 로그인 → 목록 → SSE 실시간 갱신까지 동작**하는 Spring Boot 미니 서버. 이 문서의 모든 값은 현행 코드에서 추출한 실측이다(추출 근거는 httpModel.js·server/index.js 교차 대조).

## 부트 시퀀스 (SPA가 실제로 하는 일)
1. 마운트 즉시 `GET /api/session` — **이 요청이 JSON으로 응답하지 않으면 SPA는 "세션 복원 중…"에서 영원히 멈춘다.**
2. 비로그인 → login.do 강제 → 로그인 성공 시 **writer.do로 이동**(목록 아님). writer 마운트가 `/api/stream` EventSource를 연다(REST 호출은 없음).
3. TopBar "기사조회" → list.do → `GET /api/articles?...` + `GET /api/users` + 두 번째 `/api/stream` 구독. **동시 SSE 연결 2개를 견뎌야 한다.**
4. `change` 이벤트 수신 → kind 무관하게 목록 재조회.

## 구현 대상 엔드포인트 (이것만)
| 메서드/경로 | 성공 | 실패 |
|---|---|---|
| `GET /api/session` | 200 `{"ok":true,"user":{userId,name,role,department,departmentCode}}` (정확 5키) | 401 `{"ok":false,"reason":"unauthenticated"}` — **401에도 JSON 바디 필수** |
| `POST /api/login` `{userId,password}` | 200 `{"ok":true,"sessionId":"<64-hex>","user":{userId,name,role,department,departmentCode,active}}` + Set-Cookie | 401 `{"ok":false,"reason":"invalid-credentials"}` (inactive 403·locked 423은 스파이크 선택) |
| `POST /api/logout` | 항상 200 `{"ok":true}` + sid Max-Age=0 | — |
| `GET /api/articles` | 200 `{"ok":true,"items":[...]}` — **페이징/총수 필드 없음**(클라가 10개씩 슬라이스), `ORDER BY createdAt DESC` | 401 동형 |
| `GET /api/users` | 200 `{"ok":true,"items":[{userId,name,department,departmentCode}]}` (축소 shape 하나면 충분) | 401 동형 |
| `GET /api/stream` | SSE (아래) | 미인증은 **스트림 열기 전** 401 JSON |
| `GET /api/health` | 200 `{"ok":true}` (Electron 클라 프로브용 — 1줄) | — |
| 정적 | `web/dist` 서빙 + SPA 폴백 (아래) | — |

**구현 금지**: CORS·CSRF Origin 가드·CSP·HTTPS 강제·레이트리밋 — 동일 출처 배치에서 no-op이며, 어설픈 재현(Origin==Host 검사)은 로그인 POST를 403시킨다.

## /api/articles 쿼리 (반복 키 배열)
화이트리스트: `articleId, author, sender, status, excludeStatus, department, departments, createdAtFrom/To, sentAtFrom/To, distributedAtFrom/To`. 배열은 같은 키 반복(`?status=RDS&status=DDH`). **최초 진입은 항상 `?status=RDS&DDH`**. 메뉴별: deptWrite=`excludeStatus=DPS,RRH` / deptSend=`status=DPS` / personal=`author=<name>&status=RDS,RRK` / kill=`status=RRK,DDK,EEK` / embargo=`status=DES,EPS`. 부서 멀티 `departments=` 반복.

행 객체 = Contents 전 컬럼에서 **`lockerSessionId`·`lockerClientId` 2개만 제거**. 목록이 소비하는 키: `articleId,title,author,modifier,department,departmentCode,createdAt,editedAt,sentAt,distributedAt,status,lockYN`(누락 필드는 공백 — 크래시 없음). 시간은 ISO-8601 문자열.

## 쿠키
```
Set-Cookie: sid=<64-hex>; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax
```
(dev 기준 — Secure 미설정.) 판독: Cookie `sid` 우선, `x-session-id` 헤더 폴백(스파이크는 쿠키만으로 충분 — SSE가 쿠키 전용이라 동일 출처 배치에서 전부 통과). REST는 `credentials:'include'`, SSE는 `withCredentials:true`.

## SSE 정확 프레임 (바이트 단위, LF)
```
event: ready
data: {"ok":true}
␊
event: change
data: {"kind":"update"}
␊
event: unauthorized
data: {"ok":false,"reason":"unauthenticated"}
␊
```
- 각 프레임 종결자는 **빈 줄**. 빠지면 브라우저가 디스패치하지 않고 무한 재연결.
- 헤더: `Content-Type: text/event-stream`, `Cache-Control: no-cache` + 즉시 flush.
- kind 전수: `create|update|status|lock` — 목록은 kind 무시하고 재조회하므로 스파이크는 `update` 하나로 충분.
- 클라는 `error`에 닫지 않고 자동 재연결(연결을 그냥 끊으면 3초 간격 무한 재연결). 세션 죽음은 `unauthorized` 프레임으로만 알린다(수신 시 클라가 close).
- 필터 변경 시 구독 해제→재구독 반복을 견딜 것.

## 정적 서빙 + SPA 폴백 (필수)
- `web/dist`를 같은 origin에서 서빙(SPA는 base='' 상대경로 — 원점만 맞으면 무설정).
- 폴백 규칙(Express 동형): `GET|HEAD` ∧ 경로가 `/api*`·`/uploads*` 아님(소문자 비교) ∧ `Accept`에 `text/html` 포함 → `index.html`. 그 외는 정적 매칭, 없으면 404.
- **확장자 유무로 판정 금지** — `.do` 경로에 점이 있어 반대로 동작한다. 폴백 없으면 `writer.do`에서 F5 시 404로 SPA가 죽는다.

## 계정/DB
- 시드 계정(bcryptjs cost 10, `$2a$10$...`): `reporter/reporter123`(R·사회부·SOC) `desk/desk123`(D·편집부·EDT) `admin/admin123`(Z·운영부·ADM). Spring `BCryptPasswordEncoder.matches`가 그대로 호환.
- 스파이크는 리포 `news.db`의 **사본**(spikes/p0-spring/data/news.db)을 **읽기 전용**으로 열어 User·Contents 실데이터를 쓴다. 원본 무접촉. 사본·빌드 산출물은 커밋 금지.

## 클라이언트 관용 규칙 (판정에 중요)
- httpModel은 **상태코드를 해석하지 않고 JSON 본문만** 읽는다. 비-JSON 응답 = `invalid-response`, 네트워크 단절 = `network-error`로 정규화, 절대 reject 없음. → **모든 응답에 JSON 바디 필수.**
- `/api/users` 실패는 부서 드롭다운만 빈다(크래시 없음). 목록 401은 빈 목록.
