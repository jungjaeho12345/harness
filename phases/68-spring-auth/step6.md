# Step 6: parity-green

## 목표
auth/session 슬라이스의 **최종 게이트**를 닫는다: 큐레이션 5파일 전부를 한 번의 오케스트레이터 실행으로 Node·Spring 각각(프로파일마다 새 프로세스) 돌려 **전건 green + contract-diff 0**. 이 step은 Spring/Java 신규 로직을 만들지 않는다 — 오케스트레이터 마감 + 회귀 + 미검증의 정직한 기록(forward notes)이다.

## 왜 별도 step인가
step4·step5는 파일을 개별로 diff했다. 이 step은 5파일을 **한 번에** 돌려 파일 간 상호작용(러너 세션 준비 예산, 단일 세션 복구 순서, default 프로파일 공유 카운터, 프로파일 격리)이 실제로 성립하는지를 통합 판정한다. 여기서 green이어야 phase 68 완료다.

## 큐레이션 집합 (정본)
| 프로파일 | 파일 | 로그인 예산 |
|---|---|---|
| default | health · auth · session-guard | 러너 3 + auth 2 + session-guard 1 = 6 ≤ 10 |
| auth-negative | login-negative | 전용 프로세스(429/423까지 소진) — 격리 |
| prod-cookie | cookie-prod | 전용 프로세스 |

## 읽어야 할 파일
- `scripts/contract-parity-spring.mjs`(step1 — 오케스트레이터, 큐레이션 표 하드코딩) · `scripts/contract-run.mjs`(`--target spring`) · `scripts/contract-diff.mjs`.
- `contract/README.md`(로그인 예산·프로파일) · `docs/porting-plan-cpp-spring.md` §8(검증 전략 — 이중 실행 패리티·게이트 문화).
- 이전 step 산출물: `server-spring/`(step0~5 — health·auth·session·guard·지원 라우트), 오케스트레이터·`--target spring`(step1).

## 작업 (검증 우선)
1. `scripts/contract-parity-spring.mjs`를 최종 확인/보강: 큐레이션 5파일을 프로파일별로 (Node·Spring) 실행 → 프로파일별 `contract-diff` → 하나라도 diff>0 또는 케이스 red면 exit 1. 리포트는 OS 임시 디렉토리에만(리포 오염 0). 요약 라인(프로파일별 관측 수·diff 수)을 stdout에.
2. `npm run test:contract:parity`가 이 오케스트레이터를 부르는지 확인(step1에서 추가). 없으면 추가.
3. **회귀**: 기존 Node 계약 러너(`npm run test:contract -- --profile default --files ...`)와 Spring 러너가 서로 간섭 없이 도는지, 리포 news.db 무변인지.
4. **forward notes(정직한 기록)**: `phases/68-spring-auth/` 산출물 요약과 함께 이 phase가 **구현하지 않은 것**을 index.json step6 summary(및 필요 시 `server-spring/README.md` 또는 짧은 노트)에 남긴다: sse-stream(SSE 팬아웃+articles write 필요)·articles read/write·collection·distribution(tick/스풀 — ADR-008 파일 스풀 방식 준수 필요)·media/upload·photos·receiver-config·users 전체 계약·logs/stream·CSRF Origin 가드(ADR-009 — prod-cookie에서 Node는 활성이나 큐레이션 케이스가 Origin을 보내지 않아 이 slice에선 관측 차이 없음)·minimal/failclosed 프로파일. **문서(.md) 보고서 파일을 새로 만들지는 말고**, index.json summary + 코드 인접 주석 수준으로 남겨라.

## Acceptance Criteria (실행 커맨드)
```bash
# 1) Spring 전체 유닛 green + 빌드
mvn -f server-spring/pom.xml -q test && mvn -f server-spring/pom.xml -q -DskipTests package && test -f server-spring/target/spring-auth.jar
# 2) 최종 패리티 게이트 — 5파일 전부 Node↔Spring diff 0 (프로파일마다 새 프로세스)
npm run test:contract:parity
# 3) Node 계약 러너 무회귀(현행 Node 서버 대상)
npm run test:contract -- --profile prod-cookie --boot-check
# 4) DB 비파괴 정적 잠금 + 린트
! grep -rniE "DROP |DELETE FROM|TRUNCATE|CREATE TABLE|ALTER TABLE" server-spring/src/main/java
npm run lint
```
- 2)가 exit 0(전 프로파일 diff 0·케이스 green)이어야 한다. 요약에 프로파일 3종·관측 수·diffs=0가 찍혀야 한다.
- 모든 실행 후 리포 `news.db`·`uploads/`가 무변이어야 한다(러너 데이터 안전 단언).

## 검증 절차
- `test:contract:parity` 요약이 default·auth-negative·prod-cookie 3프로파일을 모두 포함하고 skipped 0인지 확인(프로파일 미제공을 통과로 위장하지 않는다).
- auth-negative가 429/423까지 카운터를 소진해도 default/prod-cookie diff에 영향이 없는지(프로세스 격리) 확인.
- forward notes가 구현 범위와 미구현 범위를 정확히 구분하는지 확인(다음 phase 기획의 입력).

## 금지사항
- diff를 통과시키려고 케이스나 `contract-diff.mjs`를 느슨하게 고치지 마라(값 비우기·비교 끄기·큐레이션 축소). 이유: 패리티 판정이 거짓 green이 된다.
- 이 step에서 새 엔드포인트/도메인을 구현하지 마라. 이유: 범위는 auth/session 슬라이스로 확정됐다 — 확장은 후속 phase.
- 리포트를 리포 트리에 쓰지 마라(OS 임시 디렉토리만). 이유: 리포 오염·비밀(세션 토큰) 잔존 방지.
- 미구현 범위를 "완료"로 요약하지 마라. 이유: 하류 phase 기획이 오염된다(게이트 문화 — 정직한 기록).
