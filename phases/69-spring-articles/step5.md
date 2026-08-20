# Step 5: write-service

기사 **쓰기 서비스**(신규 저장·부분 수정)를 만든다. HTTP 비의존이며, 잠금 인가와 상태 전이는 이 step의 범위가 아니다(step6·step9).

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — decisions **(5)(6)(7)(8)(16)(18)(20)(21)**
- `src/services/articleService.js` 17~26행(컬럼 화이트리스트 2종) · 100~140행(이력 기록 헬퍼 `record` — 스냅샷 제목 파생 조건과 실패 격리) · 144~172행(`create`·`update`)
- `src/services/lifecycle.js` `initialStatus` — 신규 저장의 초기 상태 계산(step1이 이미 이식)
- `contract/cases/default/articles-write.contract.js` 88~185행(create 3케이스) · 355~410행(update 화이트리스트) — **합격 정의**
- `contract/cases/default/articles-read.contract.js` 74~100행(픽스처가 PUT으로 편집 스냅샷을 남기는 방식)
- `server/index.js` 853~875행·926~950행 — 라우트가 하는 **신뢰 경계 stamp**(클라 role 제거·빈 부서/작성자 보정·`modifier`=세션 사용자). 이 step은 그 stamp를 **하지 않는다**(step7의 컨트롤러 몫) — 대신 서비스가 받은 dto를 어떻게 다루는지만 소유한다
- step1(시각 포매터·파일 참조 정화·표시 제목 파생) · step2(리포지토리·트랜잭션) · step3(이력 리포지토리) 산출물

## 배경 (동결된 계약 사실)

- **신규 저장**: 서버가 `articleId`를 발급하고 `status`는 **서버 계산값**이다(기본 `RDS`, `hold` 의도면 D/Z→`DDH`·R→`RRH`). `createdAt`을 stamp한다. 클라이언트가 보낸 `status`·`sender`·`articleId`·`distributedAt`·잠금 컬럼은 **저장 대상이 아니다**(화이트리스트에 없어서 자연히 빠진다 — 개별 삭제 코드로 막지 마라).
- 저장 대상 화이트리스트는 두 갈래다: `Article`에는 `title`·`markupVersion`·`modifier`, `Contents`에는 제목·작성자·수정자·부서 2종·엠바고 2종·공통정보 9종. **`content` 컬럼은 어느 쪽에도 쓰지 않는다**(항상 NULL로 남는다 — 응답 27키에는 키가 존재한다).
- **부분 수정**: 준 필드만 반영하고 `editedAt`을 stamp한다. `status`는 **전이 라우트만** 바꾼다. 반환은 `{ok:true, changes:<두 갱신문 합>}`이며 그 정수가 패리티 비교 값이다(decisions (18)).
- **편집 이력**: 수정 성공 후 `eventType:'edit'` 행을 남긴다. `actorUserId`는 호출자가 stamp한 수정자다. 이 편집에서 저장되는 본문을 **스냅샷으로 함께 기록**하고, 본문이 **비어 있지 않은 문자열일 때만** 표시 제목을 파생해 저장한다(빈 문자열 파생 결과도 그대로 저장한다 — NULL로 바꾸면 그 행이 영구 레거시로 오판된다).
- **이력 기록 실패는 본 기능을 막지 않는다**: 삽입 실패는 삼키되 **반드시 남긴다**(경고 로그). 로그에는 식별자·사유만 담고 **본문 스냅샷·세션 토큰·비밀번호를 담지 않는다**(LOGS.md 마스킹 규율).
- **파일 참조 정화**: `attachmentFile`·`referenceFile`은 **주어진 경우에만** 정화한다(미전달 필드를 추가·변경하지 않는다 — present-only 규율과 함께 DB 비파괴를 보장한다).
- 신규 저장은 **항상 성공**한다(입력 검증으로 거부하는 경로가 없다).

## 작업

### A. 신규 저장

- `articleId` 발급(step2 리포지토리) → `Article` dto·`Contents` dto를 **각 화이트리스트로 픽** → `status`(step1 초기 상태 계산) · `createdAt`(step1 포매터) stamp → 파일 참조 정화 → **한 트랜잭션으로 두 행 삽입** → `{ok:true, articleId}`.
- 호출 시그니처에는 `role`과 의도 `action`이 함께 온다(둘 다 없으면 `RDS`). **role은 인자로만 받는다** — 서비스가 세션을 읽지 않는다.

### B. 부분 수정

- `Article`·`Contents` 화이트리스트로 픽 → `editedAt` stamp → 파일 참조 정화(present인 것만) → **한 트랜잭션으로 두 갱신문** → 이력(`edit`) 기록 → `{ok:true, changes}`.
- 존재 검사·잠금 인가는 **하지 않는다**(호출자 책임 — step7의 컨트롤러가 step6의 잠금 서비스로 먼저 판정한다).

### C. 이력 기록 헬퍼

- 삽입 레코드에 `createdAt`을 stamp하고, 본문이 비어 있지 않은 문자열이면 표시 제목을 파생해 함께 넣는다.
- 실패는 **격리**한다(본 기능 계속) + 경고 통지 seam을 둔다(주입 가능한 콜백 또는 로그 서비스). 통지 자체의 실패도 본 기능을 막지 않는다.
- 이 헬퍼는 다음 step(전이·파생)도 쓴다 — **한 곳에 둔다**.

### D. 테스트 (먼저 쓴다 — `@TempDir` DB + 실제 리포지토리)

1. 신규 저장: 반환 `articleId` 형식 · 저장된 `status`가 `RDS` · `createdAt`이 소수 3자리 형식 · 클라가 보낸 `status`/`sender`/`articleId`/`distributedAt`이 **저장되지 않았다**.
2. 초기 상태: (D, hold)→`DDH` · (R, hold)→`RRH` · (D, send)→`RDS` · role/action 미지정→`RDS`.
3. 신규 저장은 **이력 행을 남기지 않는다**(계약: 갓 만든 기사의 이력은 빈 배열).
4. 부분 수정: 준 필드만 바뀌고 `editedAt`이 갱신되며 `changes`가 **두 갱신문의 합**이다.
5. 부분 수정 후 `edit` 이력 행이 생기고 `hasSnapshot`이 본문 유무를 따른다(본문 없는 메타 편집 → 0).
6. 표시 제목: 본문이 있는 편집의 이력 행에 파생 제목이 저장된다(빈 파생 결과도 저장된다 — NULL이 아니다).
7. 이력 삽입이 실패해도 수정은 성공하고 경고가 통지된다(스텁 리포지토리로 실증). **통지 페이로드에 본문이 없다.**
8. 파일 참조: `/uploads/...`는 보존 · 위험 스킴은 빈 문자열 · **미전달 필드는 건드리지 않는다**(기존 값 유지).
9. 트랜잭션: `Contents` 삽입이 실패하면 `Article` 행도 남지 않는다(실패 주입으로 실증).
10. 화이트리스트 밖 키(예: `lockYN`·`lockerSessionId`)를 dto에 넣어도 **조용히 무시**되고 잠금 컬럼이 바뀌지 않는다.

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

1. red 먼저(D의 10군).
2. AC 실행 후 Java 테스트 수 증가분 기록.
3. **변이 실증 3종**(확인 후 원복): (a) `Contents` 화이트리스트에 `status`를 추가하면 1번이 red인가(클라가 상태를 정하게 되는 권한 상승 재현 — 반드시 원복) (b) `changes`를 1로 고정하면 4번이 red인가 (c) 이력 삽입 실패를 예외로 승격하면 7번이 red인가.
4. **DB 비파괴 확인**: 갱신이 present-only이며 잠금·전이 컬럼을 건드리지 않는다는 것을 10번으로 실증했음을 요약에 적는다.
5. `git status --porcelain` 증분 = `server-spring/src/main/java/harness/news/service/**` · `server-spring/src/test/**` · `phases/69-spring-articles/index.json`.
6. index.json step5 status·summary 갱신.

## 금지사항

- 서비스에서 세션·요청 객체를 읽지 마라(신뢰 경계 stamp는 컨트롤러 몫이다). 이유: 서비스가 서블릿에 묶이면 계층이 무너지고 단위 테스트가 컨테이너를 요구하게 된다.
- 클라이언트 입력을 '삭제'해서 막지 마라(예: dto에서 `status` 키 제거). 이유: 화이트리스트 픽이 정본의 방어 수단이며, 삭제 목록은 새 필드가 생길 때마다 누락된다.
- 신규 저장에 입력 검증(제목 필수·본문 필수 등)을 추가하지 마라. 이유: 계약은 '항상 성공'이며 검증을 넣으면 픽스처가 무너진다.
- 신규 저장에서 이력 행을 남기지 마라. 이유: 계약이 '생성은 이력 행을 남기지 않는다'를 동결했다(빈 배열 단언).
- 이력 실패를 예외로 승격하지 마라. 이유: 이미 커밋된 편집을 되돌릴 수 없는 상태에서 호출자를 깨뜨린다 — 삼키되 반드시 로그로 남긴다.
- 로그·통지에 본문 스냅샷·세션 토큰·비밀번호를 담지 마라. 이유: LOGS.md 마스킹 규율.
- 파일 참조 정화를 미전달 필드에까지 적용하지 마라(그 순간 값이 `null`에서 빈 문자열로 바뀐다). 이유: present-only 규율이 깨지고 부분 수정이 남의 필드를 덮는다.
