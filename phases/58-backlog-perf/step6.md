# Step 6: docs-failed-at

## 목표

배부 실패 목록의 `failedAt`이 **"그 사이클의 첫 실패 시각"** 이며 같은 사이클·같은 사유의 반복 실패로는 갱신되지 않는다는 중복 억제 트레이드오프를 운영 문서에 명시한다.

**실행 코드 0** — `docs/ARCHITECTURE.md` 1개 파일만 수정한다. 그리고 phase 58 전체를 마감한다.

## 읽어야 할 파일

- `docs/ARCHITECTURE.md` 37~59행(`## 데이터 흐름`의 코드 펜스 — `[요청]`·`[실시간]`·`[배부]`·`[tick]` 블록의 표기 관례: 대괄호 라벨 + 들여쓴 연속 줄). **이 파일은 이 step이 단독 소유한다.**
- `src/services/distributionService.js`의 실패 기록 경로 — `recordTargetFailure` / `isDuplicateSameCycleFailure`(phase 57 step15). **문서 문장을 쓰기 전에 실제 조건을 코드로 확인하라**: 같은 사이클(= `embargoPolicy.latestSendId` 경계 이후) 안에서 같은 `reason`의 미해소 실패가 이미 있으면 새 행을 남기지 않는다.
- `src/services/distributionFailureLog.js`의 `unresolvedFailures` — 목록 항목의 `failedAt`이 그 실패 행의 `createdAt`이라는 사실(제목만 확인).
- `src/services/distributionRetryService.js` `list()`(step4 완료본) — 항목 필드 `failedAt`.
- `docs/ADR.md` ADR-008(45~48행) — **읽기 전용·무접촉**. 결정은 바뀌지 않는다(이번 phase는 그 결정의 구현 비용 최적화일 뿐이다).
- `phases/58-backlog-perf/index.json`의 `decisions` (11).

## 배경 (자기완결)

phase 57은 같은 실패가 반복될 때 이력 행이 무한 증식하는 것을 막기 위해 **중복 억제**를 넣었다: 같은 배부 사이클 안에서 같은 수신처·같은 사유의 미해소 실패가 이미 있으면 새 `distribute-failed` 행을 남기지 않는다. 그 결과 운영자가 목록에서 보는 `failedAt`은 **최근 실패 시각이 아니라 그 사이클의 첫 실패 시각**이다.

이건 버그가 아니라 의도된 트레이드오프지만, 문서에 없으면 운영자가 "최근에 실패했는가"를 그 값으로 판단하다가 오독한다(리뷰 게이트 info 항목).

정확도 요구(문서 문장이 코드와 어긋나면 이 step은 실패다):

- 갱신되지 않는 조건은 **같은 사이클 + 같은 사유**다. 사유가 바뀌면 새 행이 생겨 갱신된다.
- 해소(재전송 성공) 후 다시 실패하면 새 행이 생긴다.
- 재송고로 새 사이클이 열리면(그 경계는 마지막 송고 이력) 같은 사유여도 새 행이 생긴다.

## 작업

`docs/ARCHITECTURE.md`의 `## 데이터 흐름` 코드 펜스 안, `[tick]` 블록 **다음**에 `[실패복구]` 블록을 2줄로 추가한다(기존 블록 표기 관례를 그대로 따르고, 기존 줄은 한 글자도 지우지 마라).

내용(문구는 다듬되 아래 사실을 모두 담을 것):

1. 수신처 단위 배부 실패(`ArticleHistory` `distribute-failed`) → Z가 실패 목록 조회 → 명시적 재전송(스풀 재기록). 자동 재시도·타이머 없음(ADR-008).
2. 목록의 `failedAt` = **그 사이클의 첫 실패 시각** — 같은 사이클에서 같은 사유로 반복 실패하면 중복 억제로 새 행을 남기지 않아 갱신되지 않는다(사유 변경·해소 후 재실패·재송고로 새 사이클이 열린 경우에는 새 행이 생겨 갱신된다).

분량은 2줄(필요 시 이어지는 들여쓴 줄 포함 3줄까지)로 제한한다. 함수명·파일 경로는 적지 마라(문서 노후화 방지 — 기존 블록의 표기 수위와 맞춘다).

## Acceptance Criteria

```bash
npm test          # 실패 0 — step4 종료 시점 개수 그대로(문서 step: 증가 0)
npm run test:web  # 실패 0 — step5 종료 시점 개수 그대로
npm run lint      # 통과
npm run build     # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `docs/ARCHITECTURE.md`(+ 진행·마감 기록인 `phases/58-backlog-perf/index.json`, `phases/index.json`)뿐.

## 검증 절차

1. 위 AC 4종을 실행하고 기준선(backend 944 · web 2361/90 files) 대비 증가분을 기록한다. **2회 연속 동일 결과**인지 확인하라(flake 0).
2. 문서 정합 점검:
   - 추가한 문장이 `distributionService`의 실제 억제 조건(같은 사이클 + 같은 사유)과 정확히 일치하는가? 코드를 다시 열어 대조하라.
   - `docs/SCHEMA.md`의 ArticleHistory 절(eventType 어휘·append-only)과 모순이 없는가?
   - `docs/ADR.md`가 무수정인가?
   - UTF-8로 저장됐고 기존 코드 펜스가 깨지지 않았는가?
3. phase 마감:
   - `phases/58-backlog-perf/index.json`의 step6을 `completed` + `summary`로 갱신하고, step0~5가 전부 `completed`인지 확인한다.
   - `phases/index.json`의 `58-backlog-perf` 항목을 `completed`로 갱신하고 `note`에 4건의 처리 결과(무엇을 어떻게 줄였는지 · DB additive 1컬럼 · 계약 불변)와 최종 테스트 수치를 남긴다.
   - 남은 백로그 2건을 `note` 끝에 기록한다: (a) 순수 레거시 기사는 개선 0(레거시 행 수만큼 본문 전송·파싱 — 백필을 하지 않기로 한 결정의 대가), (b) `articleHistoryModel.querySnapshotsByArticle`은 이 phase 이후 `src` 소비자가 없다(제거는 모델 표면 정리 백로그).
4. 최종 점검 목록(오케스트레이터 보고용):
   - DB 변경이 additive 컬럼 1개(`ArticleHistory.snapshotTitle`)뿐이고 삭제·백필 `UPDATE`가 0인가?
   - `/api/articles/:id/history`·`/api/distribution/failures` 응답 shape이 불변인가?
   - 앱 내 타이머·네트워크 egress가 새로 도입되지 않았는가(ADR-008)?
   - 무접촉 파일(`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`)이 전부 그대로인가?

## 금지사항

- `docs/ADR.md`를 수정하지 마라. 이유: ADR-008의 결정은 이 phase에서 바뀌지 않는다 — 성능 최적화가 아키텍처 결정 기록을 건드리면 결정 이력의 신호 대 잡음이 무너진다.
- 코드를 수정하지 마라(문서 step). 이유: 억제 규칙을 "고치는" 변경은 phase 57에서 두 차례 block을 거쳐 확정된 경로(같은 사이클 한정 억제)를 되돌릴 위험이 있고, 이 항목은 info(문서화)로 확정됐다.
- `failedAt`을 "최근 실패 시각"으로 바꾸는 개선안이나 새 필드(`lastFailedAt` 등)를 제안·구현하지 마라. 이유: 스코프 확장이며, 실패 행 갱신은 append-only 원장 규율과 충돌한다.
- 문서에 함수명·파일 경로·SQL을 적지 마라. 이유: 리팩터링마다 문서가 거짓이 된다 — 기존 데이터 흐름 블록의 표기 수위(개념 흐름)를 유지한다.
- 기존 문서 문장을 재구성·요약하지 마라(추가만). 이유: 다른 phase의 결정이 문서에 남긴 근거가 조용히 삭제된다.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
