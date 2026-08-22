# Step 9: lifecycle-service

**생애주기 서비스**를 만든다: (a) 액션 적용(송고·보류·KILL·삭제승인) (b) 파생(후속/계속 기사 작성). HTTP 비의존이며 이 phase에서 가장 무거운 도메인 로직이다.

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — decisions **(2)(3)(6)(12)(16)(17)(18)(21)** · excluded (c)(d)
- `src/services/articleService.js` 202~245행(`applyAction`: 전이 → 마커 → 엠바고 후처리 → stamp → 저장 → 이력) · 246~270행(**송고 훅 — 이 phase는 이식하지 않는다**) · 305~340행(`deriveArticle`)
- `src/services/lifecycle.js` — 전이표(step1이 이식)
- `contract/cases/minimal/transitions.contract.js` 전부 — **합격 정의**. 특히 12~26행의 예측(가드 순서·DES 진입 조건), 174~250행의 허용/거부 칸, 265~300행의 마커 게이트 2케이스, 305~330행의 송고 stamp, 340~395행의 엠바고 3변형 + DDH 진입 + R은 RDS 유지, 400~420행의 이력 부수효과, 425~536행의 derive 3케이스(복사 필드 실측 포함)
- `docs/api-contract/README.md` "코드 ↔ 스펙 문서 차이" 4번 — derive가 **부서를 복사하지 않는다**는 실측(주석이 아니라 복사 목록이 계약이다)
- step1(전이표·마커·시각) · step2(리포지토리) · step3(이력) · step5(신규 저장·이력 기록 헬퍼) 산출물

## 배경 (동결된 계약 사실)

- **가드 순서**(계약이 명시적으로 동결): ① 존재(없으면 `not-found`) ② **전이표 판정**(불가면 `forbidden-transition`) ③ 송고면 `(끝)` 마커(없으면 `no-end-marker`) ④ 엠바고 후처리 ⑤ `sender`/`sentAt` stamp + 상태 저장 ⑥ 이력 기록. **전이가 불가하면 마커 검사에 도달하지 않는다**(마커도 없고 전이도 불가한 입력은 409이지 400이 아니다).
- **엠바고 DES 진입**: 이전 상태가 `RDS`·`DDH`이고 role이 D/Z이며 전이 결과가 `DPS`이고 **엠바고 컬럼 둘 중 하나라도 설정돼 있으면** 최종 상태는 `DES`다. **시각 비교를 하지 않는다**(설정 여부만 본다). 판정 입력은 **DB에 저장된 값**이다(클라 입력 불신).
- **R의 송고는 `RDS` 유지**이므로 엠바고가 설정돼 있어도 `DES`로 가지 않는다(전이 결과가 `DPS`일 때만 진입한다).
- **송고 stamp**: `sender`는 호출자가 준 userId(없으면 null), `sentAt`은 현재 시각. **송고가 아닌 액션은 stamp하지 않는다.**
- **상태 저장은 present-only**로 `status`(+송고면 2컬럼)만 쓴다 — 본문·잠금·`distributedAt`을 함께 쓰지 않는다.
- **이력**: 전이 성공 직후 `eventType:'status'` 행에 `action`·`fromStatus`·`toStatus`·`actorUserId`를 남긴다. 거부·마커 실패 경로에서는 **남기지 않는다**. `approveDelete`로 `DPD`가 돼도 **행은 남는다**(DB 비파괴).
- **송고 훅(배부)은 이식하지 않는다**(excluded (c)). Node는 스풀이 설정된 환경에서만 결선하고 `minimal` 프로파일은 미설정이라 발화하지 않으며, `default`도 수신처 0건이라 관측 가능한 부수효과가 없다(decisions (2)(3)). 승격 함수(`syncEmbargoStatus`)도 만들지 않는다 — 배부 phase 소유다.
- **파생(derive)**: `followUp`·`continue` 2종만 유효(그 외는 `unknown-mode`). 원본이 없으면 `not-found`. **항상 신규 저장 경로로만** 새 행을 만든다(새 `articleId`·`status` `RDS`). 복사 규칙 실측: 제목 복사 · 본문은 `continue`만 복사하고 `followUp`은 **빈 문자열** · 공통정보 **9키**(`coAuthor`·`category`·`region`·`attribute`·`keyword`·`internalComment`·`externalComment`·`attachmentFile`·`referenceFile`) 복사 · 엠바고 2컬럼은 **빈 문자열로 초기화** · **부서 2종은 복사하지 않는다**(파생 기사에서 `null`) · 송고 stamp·`distributedAt`·잠금은 복사하지 않는다 · 작성자는 **파생 실행자**(호출자가 넘긴다).
- **원본은 한 글자도 바뀌지 않는다**(계약이 `article`·`contents` 전체 비교로 단언한다).

## 작업

### A. 액션 적용

- 시그니처: `(articleId, role, action, actorUserId)` → `{ok:true, status}` 또는 `{ok:false, reason}`. **세션·요청 객체를 받지 않는다.**
- 위 가드 순서를 그대로 구현하고, 각 단계의 사유 토큰을 정본과 동일하게 돌려준다.
- 엠바고 진입 판정은 **저장된 행**의 두 컬럼으로만 한다(빈 문자열은 미설정으로 본다 — Node의 falsy 의미론).
- 저장 후 이력은 step5의 기록 헬퍼를 재사용한다(중복 구현 금지).

### B. 파생

- 시그니처: `(sourceArticleId, mode, author)` → `{ok:true, articleId}` 또는 `{ok:false, reason}`.
- 모드 검증 → 원본 조회(없으면 `not-found`) → dto 조립(위 복사 규칙 그대로) → **step5의 신규 저장 호출**.
- dto에 `status`·`sender`·`sentAt`·`editedAt`·`distributedAt`·잠금·`articleId`를 **넣지 않는다**(신규 저장이 새 id와 `RDS`를 강제한다).
- 부서 2종을 복사하지 마라(실측 계약 — 주석이 아니라 복사 목록이 정본이다).

### C. 테스트 (먼저 쓴다 — `@TempDir` DB + 고정 시계 + 실제 리포지토리)

1. **전이 허용 칸 전수**(**표 허용 칸 15** = 계약 도달 가능 13 + `EPS`발 2 · **계약 케이스는 16건**이며 같은 칸을 두 번 관측하는 케이스가 있어 칸 수와 다르다): 반환 상태와 되읽은 상태가 같다. 이 phase의 계약 도달 범위는 13칸이고 `EPS`발 2칸은 Java 단위 테스트만 덮는다(excluded (d)).
2. **거부 칸**(계약 5칸): `forbidden-transition`이고 **상태가 그대로**이며 **이력 행이 생기지 않는다**.
3. 가드 순서: 마커 없는 `DDK`에 송고 → `forbidden-transition`(400 아님) · 마커 없는 `RDS`에 송고 → `no-end-marker`이고 상태 그대로 · 마커를 넣어 저장한 뒤 송고 → `DPS`.
4. 없는 기사 → `not-found`(전이표 판정 전에).
5. 송고 stamp: `sender`가 호출자 userId, `sentAt`이 비어 있지 않다. **송고가 아닌 액션은 두 컬럼을 건드리지 않는다.**
6. 엠바고: 1차만·2차만·둘 다 → `DES` · `DDH`에서 송고해도 `DES` · **R의 송고는 `RDS`**(엠바고가 있어도) · 엠바고 컬럼이 빈 문자열이면 `DPS`.
7. 이력: 전이 성공 후 `status` 행이 생기고 `action`·`fromStatus`·`toStatus`·`actorUserId`가 맞다.
8. `approveDelete` → `DPD`이고 **행이 남아 있다**(조회로 확인).
9. 파생: 두 모드 각각 새 id·`RDS`·작성자 = 파생 실행자 · 제목 복사 · 본문은 모드에 따라 복사/빈 문자열.
10. 파생 복사 필드 실측: 공통정보 9키 복사 · 엠바고 2컬럼 **빈 문자열** · 부서 2종 **null** · 송고 stamp·`distributedAt` null.
11. 파생: **원본 무변**(두 테이블 전체 비교) · 없는 원본 `not-found` · 정의 밖 모드 `unknown-mode`.
12. **배부 훅이 없다**는 것의 확인: 송고 후에도 `distributedAt`이 `null`이고 `distribute` 이력 행이 생기지 않는다(이 phase의 의도된 부재 — decisions (2)(3)).

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3번은 무회귀 확인(관측 수 불변 · `diffs=0`). 이 step은 라우트를 늘리지 않는다.

## 검증 절차

1. red 먼저(C의 12군). 전이 전수 테스트의 red를 먼저 확인한다.
2. AC 실행 후 Java 테스트 수 증가분 기록.
3. **변이 실증 4종**(확인 후 원복): (a) 마커 검사를 전이 판정 **앞**으로 옮기면 3번이 red인가 (b) 엠바고 진입에 시각 비교를 넣으면 6번이 red인가 (c) 파생이 부서를 복사하면 10번이 red인가 (d) 거부 경로에서도 이력을 남기면 2번이 red인가.
4. **DB 비파괴**: 8번(삭제 승인 후 행 존속)과 11번(원본 무변) 결과를 요약에 명시한다.
5. **의도된 부재 기록**: 12번으로 배부 훅이 없음을 실증했고, 그것이 `minimal`·`default` 두 프로파일에서 패리티를 깨지 않는 근거(decisions (2)(3))를 요약에 1줄로 적는다.
6. `git status --porcelain` 증분 = `server-spring/src/main/java/harness/news/service/**` · `server-spring/src/test/**` · `phases/69-spring-articles/index.json`.
7. index.json step9 status·summary 갱신.

## 금지사항

- 배부 훅·승격 함수(`syncEmbargoStatus` 등가)를 만들지 마라. 이유: 이 phase 범위 밖이며(excluded (c)) ADR-008 아키텍처(파일 스풀 outbound·tick pull)를 따르는 배부 phase가 소유한다. 앱 내 타이머·직접 네트워크 전송은 어떤 형태로도 도입하지 않는다.
- 가드 순서를 바꾸지 마라. 이유: 같은 요청이 400과 409 사이에서 갈린다 — 계약이 그 순서를 명시적으로 동결했다.
- 엠바고 진입에 시각 비교를 넣지 마라. 이유: "지금이 엠바고 시각인가"는 tick의 책임이고 여기서 비교하면 도래 전 기사가 즉시 배부 상태로 떨어진다.
- 상태 저장에 다른 컬럼을 함께 쓰지 마라(본문·잠금·`distributedAt`). 이유: present-only 갱신이 DB 비파괴의 실질 보증이다.
- 거부·마커 실패 경로에서 이력을 남기지 마라. 이유: 계약이 '전이 성공 직후에만 기록'을 동결했고, 이력은 감사 기록이자 판정 입력이다.
- `approveDelete`를 행 삭제로 구현하지 마라. 이유: 최상위 규칙(DB 비파괴)이며 계약이 삭제 승인 후 행 존속을 단언한다.
- 파생에서 원본을 갱신하지 마라(파생 카운터·마지막 파생 시각 등). 이유: 계약이 원본 두 테이블 전체의 무변을 단언한다.
- 파생을 신규 저장 경로 밖에서 직접 INSERT로 만들지 마라. 이유: 새 id 발급·초기 상태·트랜잭션 규율이 한 곳(신규 저장)에 있어야 갈라지지 않는다.
