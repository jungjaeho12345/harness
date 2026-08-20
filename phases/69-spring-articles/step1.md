# Step 1: domain-core

기사 도메인의 **순수 모듈**(DB·HTTP·시계 비의존, 또는 주입된 `Clock`만 의존)을 이식한다. 이 step은 HTTP도 SQL도 건드리지 않는다 — 뒤의 모든 step이 이 조각들을 재사용한다.

이식 대상 5종: **전이표(lifecycle)** · **"(끝)" 마커 판정** · **파일 참조 정화(fileRef)** · **응답 투영(contentsProjection)** · **이력 표시 파생(historyMeta: snapshotTitle + decorate)**. 여기에 **시각 포매터**와 **articleId 형식 생성기**(유일성 확인은 리포지토리 몫)를 더한다.

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — decisions **(4)(5)(6)(7)(16)** · excluded (d)
- `src/services/lifecycle.js` (53행 전부) — **정본**. `DESK_TABLE`(RDS·DPS·DDH·EPS·DES) · `REPORTER_TABLE`(RDS만) · `initialStatus(role, action)` · 거부 사유 3종(`unknown-action`·`unknown-role`·`forbidden-transition`)
- `src/services/articleService.js` 38~60행 — `hasEndMarker`(블록 JSON의 `text`를 개행으로 이어 붙여 `(끝)` 포함 여부. **`type` 필터 없음**) · `isStale`(30분 TTL, 파싱 실패는 stale)
- `src/services/fileRef.js` (20행 전부) — 거부 기반 정화 규칙 순서 전부
- `src/services/contentsProjection.js` (33행 전부) — 제거 2컬럼과 그 이유, 원본 mutate 금지
- `src/services/historyMeta.js` (105행 전부) — `snapshotTitle`(텍스트 블록만 필터 → 첫 줄 → trim → 200자 절단) · `decorateHistoryRows`(id 오름차순 계산 · 스냅샷마다 version 증가 · 전이 행에서 status 갱신 · 첫 전이의 `fromStatus`로 역승계 · 스냅샷 0건일 때만 `v1Body` 사용 · 반환은 입력 순서 유지 + `markupVersion`·`snapshotTitle` 제거)
- `src/db/articleId.js` (16행 전부) — `AKR` + UTC `YYYYMMDD` + 9자리 난수
- `contract/cases/default/articles-read.contract.js` 480~530행 — 이력 행의 파생값 단언(`hasSnapshot`은 정수 1/0 · `edit.version === 2` · `edit.status === 'RDS'`(역승계) · `send.status === 'DPS'` · `edit.title`이 스냅샷 첫 텍스트 줄)
- `contract/cases/minimal/transitions.contract.js` 12~26행·174~250행 — 전이표 예측과 허용/거부 칸 전수
- `server-spring/src/main/java/harness/news/service/SessionConfig.java`·`config/AppConfig.java` — 기존 `Clock` 빈 결선 방식

## 배경 (동결된 계약 사실)

- 전이표는 **표에 없는 칸 = 거부**다. D와 Z는 **같은 표**를 쓰고 R은 `RDS`만 다룬다. `DPS`는 재송고(`send`→`DPS`)·보류·삭제승인만 있고 `kill`이 없다. `DDH`는 `hold`가 없다. `DES`·`EPS`는 `kill`·`hold`만 있다.
- `initialStatus`는 **항상 유효한 상태를 반환하고 거부하지 않는다**(기본 `RDS`, `hold`일 때만 전이표를 재사용해 D/Z→`DDH`, R→`RRH`).
- `hasEndMarker`는 블록의 `type`을 보지 않는다. 반면 `snapshotTitle`은 **`type === 'text'`인 블록만** 센다 — 두 규칙이 다르다는 것이 실측이며, 하나로 합치면 계약이 깨진다.
- `snapshotTitle`의 입력이 파싱 불가·평문이면 문자열 그대로 취급한다(빈 값·null은 `''`).
- 투영 제거 대상은 `lockerSessionId`·`lockerClientId` **2개뿐**이다. `lockYN`·`lockerUserId`·`lockedAt`은 잠금 표시 UI 계약이라 남는다.
- 시각 문자열은 **소수 3자리 + Z 고정**이다(decisions (6) — 사전식 정렬·범위 필터의 전제).

## 작업

### A. 전이 코어

- 상태 전이표 2개(데스크·기자)를 **불변 맵 상수**로 두고, `transition(status, role, action)` → 허용이면 다음 상태, 아니면 사유 토큰을 담은 결과를 돌려준다. `initialStatus(role, action)`은 전이 결과를 재사용해 한 표로 수렴시킨다(정본과 같은 구조 — 두 벌로 갈라 놓지 마라).
- 반환 타입은 `record`로 `{ok, status, reason}` 중 필요한 것만 담는다. **서블릿·SQL 타입을 참조하지 마라.**
- `EPS`발 2칸도 표에 넣는다(계약 도달 불가 = 미검증이지만 표의 일부다 — excluded (d)).

### B. 마커·TTL·파일 참조

- 마커 판정: 본문 문자열 → JSON 파싱 시도 → `blocks` 배열이면 각 블록의 문자열 `text`를 개행으로 join → `(끝)` 포함 여부. 파싱 실패·비JSON은 원문 문자열 그대로 검사. 빈 값·null은 거짓.
- stale 판정: 잠금 시각 문자열 파싱 실패·부재면 stale, 아니면 `(now - lockedAt) > 30분`. `now`는 **주입된 `Clock`**에서만 얻는다.
- 파일 참조 정화: 정본의 **거부 순서 그대로**(빈 문자열 통과 → 제어문자·공백 포함 거부 → 백슬래시 거부 → 프로토콜 상대 거부 → https 허용 → 그 외 스킴 거부 → `/uploads/` 접두 아니면 거부 → `..` 세그먼트 거부). 정본이 입력을 먼저 문자열로 변환하므로 **null 입력은 문자열 `"null"`이 되어 결국 빈 문자열로 정화된다** — 그 동작까지 테스트로 잠근다(Node 동형).

### C. 응답 투영

- `Contents` 행(맵) → 제거 2컬럼을 뺀 **새 맵**(원본 mutate 금지, 키 순서 유지). 제거 목록은 **상수 1곳**이 소유한다.
- 배열 입력 방어(원소별 투영)도 정본과 같이 둔다.

### D. 이력 표시 파생

- `snapshotTitle(markup)`: JSON 파싱 → 최상위 배열이거나 `blocks` 배열이면 **`type === 'text'`이고 `text`가 문자열인 블록만** 골라 개행으로 join → 첫 줄 → trim → **200자 절단**. 파싱 실패는 원문 문자열로 같은 처리.
- `decorateHistoryRows(rows, snapshots, v1Body)`: 정본의 계산 규칙을 그대로 옮긴다 — (1) 계산은 id 오름차순, 반환은 **입력 순서 그대로** (2) 스냅샷 보유 행에서 version을 **먼저 증가시키고 그 값을 그 행에 부여** (3) 전이 행(`toStatus`가 비어 있지 않은 행)에서 status 갱신 (4) 첫 전이 이전 구간은 그 전이의 `fromStatus`로 **역승계** (5) 저장된 파생 제목이 **문자열이면 재파생하지 않는다**(빈 문자열도 유효한 저장값) (6) 스냅샷이 **한 건도 없을 때만** `v1Body`로 v1 구간 제목을 만든다 (7) 반환 행에서 `markupVersion`·`snapshotTitle`을 **싣지 않는다**.
- 입력 행은 이력 리포지토리가 주는 맵/레코드 형태를 그대로 받는다(다음 step에서 결선한다).

### E. 시각 포매터 · articleId 형식

- 시각: 주입된 `Clock` → **소수 3자리 + Z**(예: `2026-08-20T12:34:56.789Z`)를 만드는 헬퍼 1곳. 나노초가 0이어도 소수부를 **반드시** 싣는다.
- articleId: `AKR` + **UTC 날짜 8자리** + 9자리 0채움 난수 문자열을 만드는 순수 생성기. 유일성 확인 루프는 리포지토리(step2)가 소유한다 — 여기서는 형식만.

### F. 테스트 (먼저 쓴다 — 순수 단위 테스트, 스프링 컨텍스트 불필요)

1. 전이표 **전수**: 허용 칸 전부(계약의 16칸 + `EPS`발 2칸)와 대표 거부 칸(`DPS`+R+send · `RDS`+R+approveDelete · `DDH`+D+hold · `RRK`+D+send · `DPD`+D+send) → 사유 토큰까지 단언.
2. `initialStatus`: 기본 `RDS` · D/Z+hold → `DDH` · R+hold → `RRH` · 알 수 없는 role·action → `RDS`(거부하지 않는다).
3. 마커: `(끝)` 있는 블록 · 없는 블록 · 평문 · 깨진 JSON · 빈 값 · `type`이 없는 블록에서도 참(주의: 계약 픽스처가 `type` 없는 블록을 쓴다).
4. stale: 고정 시계로 29분 59초(미stale) · 30분 1초(stale) · 파싱 불가(stale) · null(stale).
5. 파일 참조: 정본 규칙의 각 분기 1건 이상 + `null` 입력 → 빈 문자열.
6. 투영: 2컬럼 제거 · 다른 잠금 3컬럼 유지 · 원본 불변 · 값이 null인 키 **유지**.
7. `snapshotTitle`: 텍스트 블록만 세는지(`type` 없는 블록은 무시) · 첫 줄만 · trim · 200자 절단 · 평문 폴백 · 빈 값 → `''`.
8. `decorateHistoryRows`: 계약이 단언하는 시나리오(편집 1건 + 전이 1건)에서 `version`(2/2)·`status`(`RDS` 역승계 / `DPS`)·`title`이 맞는가 · 반환 순서가 입력 순서인가 · `markupVersion`·`snapshotTitle`이 빠졌는가 · 스냅샷 1건 이상이면 `v1Body`가 **무시**되는가.
9. 시각 포매터: 나노초 0인 고정 시계에서도 `.000Z`가 붙는가(이 한 건이 정렬 계약을 지킨다).
10. articleId 형식: 접두·길이·숫자 구성 · UTC 경계(로컬 시간대가 KST여도 UTC 날짜가 나오는가 — 고정 시계로).

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3번은 **무회귀 확인**이다(이 step은 라우트를 늘리지 않으므로 관측 수가 step0과 같아야 하고 `diffs=0`이어야 한다).

## 검증 절차

1. red 먼저(F의 10군). 전이표 테스트는 **표를 채우기 전에** 전수 red를 확인한다.
2. AC 실행 후 Java 테스트 수 증가분을 요약에 적는다.
3. **변이 실증 3종**(확인 후 원복): (a) `DPS`에 `kill` 칸을 추가하면 전이 테스트가 red인가 (b) `snapshotTitle`에서 `type` 필터를 빼면 8번이 red인가 (c) 시각 포매터에서 소수부를 생략하면 9번이 red인가.
4. **정적 규율 확인**: 이 step이 만든 클래스가 `jakarta.servlet`·`java.sql`·`org.springframework.jdbc`를 import하지 않는지 눈으로 확인한다(순수 계층 — 다음 step들이 이 경계에 기댄다).
5. `git status --porcelain` 증분 = `server-spring/src/main/java/harness/news/**`(순수 모듈) · `server-spring/src/test/java/harness/news/**` · `phases/69-spring-articles/index.json`.
6. index.json step1 status·summary 갱신.

## 금지사항

- 전이표를 두 벌로 만들지 마라(예: 초기 상태용 별도 표). 이유: 정본이 한 표로 수렴시킨 이유가 '단일 진실'이고, 갈라지면 `hold` 초기 상태와 편집 컨텍스트 전이가 조용히 달라진다.
- 마커 판정과 제목 파생의 블록 필터를 같은 함수로 합치지 마라. 이유: 마커는 모든 블록의 `text`를 보고 제목은 `type === 'text'`만 본다 — 합치면 계약 픽스처(`type` 없는 블록)에서 송고 가드가 뒤집힌다.
- 투영 대상 목록에 `lockYN`·`lockerUserId`·`lockedAt`을 넣지 마라. 이유: 그 3개는 잠금 표시 UI 계약이며 빼면 목록 화면이 잠금 상태를 잃는다.
- `System.currentTimeMillis()`·`Instant.now()`(무인자)를 쓰지 마라. 이유: 시간축 테스트의 결정성이 주입된 시계 하나에 걸려 있다(ADR-013).
- 이 step에서 SQL·컨트롤러·필터를 만들지 마라. 이유: 계층 경계가 무너지면 실패 원인이 '순수 로직'과 '결선'으로 갈라져 진단이 무너진다.
- Java main 소스의 주석에 스키마 조작·행 삭제 SQL 토큰을 쓰지 마라. 이유: 정적 스캔 테스트가 **주석까지** 검사한다(문자열이 등장하는 것만으로 red).
