# Step 13: adr-distribution-retry

## 목표

이번 phase가 확정한 배부 설계 결정을 **ADR-008에 반영**한다(문서 step — 코드 변경 0).

`docs/ADR.md`의 ADR-008 **결정** 항목 끝에 `(6)`을 추가한다: 수신처 단위 실패는 ArticleHistory에 append-only로 영속하고, 복구는 **Z의 명시적 재전송(파일 스풀 재기록)**으로만 한다 — 앱 자동 재시도·백오프·타이머는 두지 않는다.

이 step은 문서 1파일만 다룬다.

## 읽어야 할 파일

- `docs/ADR.md` **전체** — 특히 L45~48 **ADR-008**의 3단 구조(**결정** / **이유** / **트레이드오프**)와 번호 매김 방식`(1)~(5)`, 그리고 인접 ADR들이 후속 phase의 결정을 본문에 흡수한 방식(ADR-005·ADR-007의 "push 시점 재검증" 문장, ADR-009의 "가정과 실패 모드" 절).
- `docs/ARCHITECTURE.md` L47~59 — `[배부]`·`[tick]` 흐름 서술(용어를 여기와 맞춘다: 스풀 기록 시각 = `distributedAt`, 앱은 egress·타이머 없음).
- `docs/SCHEMA.md`의 `## ArticleHistory Table` 절(step0에서 신설) — 컬럼·eventType 어휘의 단일 출처. ADR 문장이 이 절과 어긋나면 안 된다.
- `phases/57-distribution-mvp4/index.json`의 `decisions` — 이 phase가 확정한 결정 전체(문서에 옮길 원본).
- 구현 결과 확인용(수정 금지): `src/services/distributionFailureLog.js`, `src/services/distributionRetryService.js`, `src/db/schema.js`의 `ArticleHistory` 정의, `server/index.js`의 `/api/distribution/failures`·`/api/distribution/retry`.

## 배경 (자기완결)

ADR-008 결정 항목은 현재 `(1) 파일 스풀 outbound … (5) 배부 이벤트는 ArticleHistory에 기록 …`까지다. MVP-4는 그 `(5)`를 확장하는 새 사실을 만들었다:

- ArticleHistory에 **수신처 단위** 실패/재전송 행이 추가됐다(additive 컬럼 `targetId`·`reason`, eventType `distribute-failed`·`distribute-retry`).
- 복구 경로가 **Z 전용 수동 재전송** 하나로 확정됐다(자동 재시도 없음 — 타이머 금지 원칙 유지).
- 재전송에는 4중 게이트(Z 세션 / 미해소 실패 존재 / 수신처 kind 일치 / 배부 가능 status)가 있다.

ADR은 "왜 이 선택인가"를 남기는 문서다 — 구현 세부(함수명·필드명 나열)를 옮기지 말고 **결정과 그 대가**만 적는다.

## 작업

`docs/ADR.md`의 ADR-008 **결정** 문단 끝에 `(6)`을 잇고, **트레이드오프** 문단에 대가 한 문장을 덧붙인다. 다른 ADR·다른 문단은 손대지 않는다.

담을 내용(1~2문장 + 트레이드오프 1문장, 기존 문체·번호 매김을 그대로 따른다):

1. **결정 (6)**: 수신처 단위 배부 실패는 `ArticleHistory`에 append-only로 영속한다(additive 컬럼 — 행 삭제·수정 없음). 미발송의 복구는 **Z가 명시적으로 실행하는 재전송(해당 수신처로 스풀 파일 재기록)** 뿐이며, 앱은 자동 재시도·백오프·재시도 큐를 두지 않는다((1)·(3)의 "앱에 타이머·egress 없음" 원칙 유지). 해소 여부는 실패 행을 갱신하지 않고 **이후 재전송 이력으로 파생**한다.
2. **트레이드오프 추가**: 미발송 복구가 운영자의 관측·조작에 의존한다(자동 복구 없음). 실패 해소 판정이 안전 방향(과다 보고)이라 이미 복구된 항목이 목록에 남을 수 있고, 그 상태에서 재전송하면 같은 수신처에 중복 스풀이 생길 수 있다 — 미발송보다 중복이 낫다는 판단이다.

규칙:

1. 기존 `(1)`~`(5)` 문장을 수정·재배열하지 마라(additive만).
2. 함수명·파일 경로·테스트 이름을 ADR에 쓰지 마라(구현 세부는 코드 주석과 phase 문서가 갖는다).
3. 새 ADR 번호(ADR-010 등)를 만들지 마라 — 같은 결정(배부 아키텍처)의 연장이므로 ADR-008 안에 둔다.
4. `docs/ARCHITECTURE.md`·`docs/SCHEMA.md`·`docs/news.md`는 이 step에서 수정하지 않는다(SCHEMA는 step0이 이미 반영했다).

## Acceptance Criteria

```bash
npm test          # 실패 0 — step12 종료 시점과 동일(문서 step이므로 증가 0)
npm run test:web  # 실패 0 — step12 종료 시점과 동일
npm run lint      # 통과
npm run build     # 통과
```

**diff scope**: 시작 시점 `git status --porcelain` 스냅샷 대비 증분이 `docs/ADR.md` **1개뿐**이어야 한다(절대 목록 비교 금지).

## 검증 절차

1. 위 AC 커맨드 4종을 실행한다(문서 변경이므로 개수는 step12 종료 시점과 같아야 한다 — 다르면 이전 step 산출물이 흔들린 것이다).
2. 문서 정합 점검:
   - ADR-008의 번호가 `(1)`~`(6)`으로 연속하는가?
   - `(6)`의 서술이 `docs/SCHEMA.md`의 `## ArticleHistory Table` 절(eventType 어휘·additive 컬럼)과 어긋나지 않는가?
   - "앱 내 타이머·egress 없음" 원칙과 모순되는 표현(자동 재시도·스케줄러 등)이 없는가?
   - `docs/news.md`가 무수정인가?
3. **phase 마감 점검**: 기준선(backend 821 / web 90 files 2262) 대비 최종 개수와 lint·build 결과를 `phases/57-distribution-mvp4/index.json`에 기록하고, step0~13 전 step이 `completed`인지 확인한다.
4. `phases/57-distribution-mvp4/index.json`의 step13을 `completed` + `summary`로 갱신한다. summary에 ADR-008에 추가한 문장 요지와 트레이드오프 문장을 명시하라.

## 금지사항

- 새 ADR 번호를 만들지 마라. 이유: 배부 아키텍처의 단일 결정 문서는 ADR-008이며, 쪼개면 후속 개발자가 두 문서를 대조해야 한다.
- 기존 ADR 문장을 다시 쓰거나 순서를 바꾸지 마라. 이유: ADR은 결정의 역사 기록이다 — 과거 문장을 고치면 왜 그렇게 결정했는지가 사라진다.
- 코드·테스트 파일을 이 step에서 수정하지 마라. 이유: 문서 step의 diff scope가 오염되면 마감 점검에서 회귀 원인을 격리할 수 없다.
- "향후 자동 재시도를 도입할 수 있다" 같은 여지 문장을 쓰지 마라. 이유: ADR-007·ADR-008이 세운 "앱 내 타이머 없음" 원칙을 흐린다 — 필요해지면 새 ADR로 뒤집는다.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라. 이유: 사용자 소유 미커밋 파일이며 이번 phase 무접촉 대상이다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지. 이유: 사용자 작업물이 커밋에 섞이거나 소실된다.
