# Step 2: docs-closeout

## 목표

이 phase 때문에 **거짓이 된 문장 3곳**을 정정하고 phase 59를 마감한다.

- `docs/SCHEMA.md` 56행 — ArticleHistory 절 머리말이 "append-only — 행 삭제·수정 없음(DB 비파괴)"이라고 단언한다. **이 phase가 행 수정을 도입하므로 불변식의 명시 예외를 적어야 한다**(사용자 승인 2026-08-11, index.json `decisions` (14)).
- `docs/SCHEMA.md` 60행 — `snapshotTitle` 설명이 "백필·행 재작성 없음"이라고 단언한다.
- `src/services/historyMeta.js` 상단 주석 — 규칙 드리프트 설명이 "(재파생·백필이 없다)"고 단언한다.

**실행 로직 변경 0** — `historyMeta.js`는 **주석만** 손댄다(함수 본문·export·동작 무수정). 문서는 `SCHEMA.md` **1개 파일(2곳)** 뿐이다 — ARCHITECTURE.md·ADR.md로 번지지 마라(과다 문서화 금지).

## 읽어야 할 파일

- `docs/SCHEMA.md` — 상단 기술명세서(5~11행: "멱등 마이그레이션만", "DB 삭제 금지")와 `## ArticleHistory Table` 절(55~65행). 특히 **56행**:
  > `기사 편집/생애주기 전이/배부 이벤트 로그에 대한 명세서. append-only — 행 삭제·수정 없음(DB 비파괴).`

  그리고 **60행**:
  > `snapshotTitle(VARCHAR)은 ... 이전 버전에서 기록된 행은 NULL이고, 조회가 그 행에 한해 본문을 함께 읽어 파생하는 폴백을 유지한다(백필·행 재작성 없음 — 이력은 append-only 원장이다). 파생 규칙이 바뀌어도 이미 저장된 행은 옛 규칙의 값을 유지한다(재파생·백필 없음).`

  **이 파일은 이 step이 단독 소유한다.**
- `src/services/historyMeta.js` 1~17행 — 상단 주석과 `snapshotTitle` 위 "규칙 드리프트(의도된 대가)" 주석(11~12행). **주석 외 수정 금지.**
- `src/db/schema.js`(step0 완료본)의 `backfillHistoryTitles` 주석 + `SCHEMA.ArticleHistory`의 `snapshotTitle` 주석 — 문서 문장을 쓰기 전에 **실제 구현과 대조**하라(대상 술어·빈 값만 채움·`''` 저장·멱등·행 삭제 0).
- `server/index.js`(step1 완료본)의 `runHistoryTitleBackfill`과 `bootstrap()` 결선 — 문서에 쓸 "부트 시 1회" 서술의 근거.
- `docs/ADR.md`·`docs/ARCHITECTURE.md`·`docs/news.md` — **읽기 전용·무접촉**. 무접촉의 근거는 "결정이 안 바뀐다"가 아니라(append-only 불변식에 예외를 두는 결정이 실제로 있었다), **그 예외의 적용 범위가 파생 표시 컬럼 1개로 한정되어 아키텍처 흐름·계층·외부 계약을 바꾸지 않아 ADR 신설 기준에 미달**한다는 것이다(index.json `decisions` (12)·(14)).
- `phases/59-history-title-backfill/index.json`의 `decisions` (3)·(10)·(12)·**(14 — append-only 명시 예외 결정문. 이 step의 문안은 이 결정문을 문서 어투로 옮긴 것이어야 한다)**, `phases/index.json`의 `58-backlog-perf` 항목 note(잔여 백로그 (a)가 이 phase에서 해소됨).

## 배경 (자기완결)

phase 58은 "레거시 행은 백필하지 않는다"를 **명시적 결정**으로 문서·주석에 남겼다(대량 UPDATE가 그 phase의 범위 밖이라는 판단이었고, 백필이 필요하다고 판단되면 별도 phase의 명시적 결정으로 한다고 적었다). phase 59가 바로 그 결정을 내렸으므로, 옛 문장을 그대로 두면 문서가 코드에 대해 거짓말을 한다.

정확도 요구(문장이 구현과 어긋나면 이 step은 실패다):

- 백필은 **부트 시 실행**되고 **빈 컬럼(`NULL`)만** 채운다.
- **이미 값이 있는 행은 재파생·덮어쓰기하지 않는다** → 파생 규칙 드리프트 서술(저장된 행은 옛 규칙 값 유지)은 **그대로 유효**하다. 이 부분을 지우지 마라.
- 스냅샷이 아닌 행(`markupVersion`이 `NULL`/`''`)은 건드리지 않는다. 행 삭제 0 · **표시제목 외 컬럼 수정 0**.
- 파생 결과가 빈 문자열이면 `''`를 저장한다(`NULL` 유지 아님).
- **조회의 행 단위 폴백은 그대로 남는다** — 백필을 돌리지 않은 DB·구버전 인스턴스가 기록한 행이 있을 수 있다.
- 멱등: 재실행 시 **채운 행 수 0 · 값 불변**("대상 0건"이라고 쓰지 마라 — 파생이 건너뛴 행은 다시 스캔된다).
- 백필 대상은 **"컬럼 도입 이전에 기록된 행"만이 아니다** — phase 58의 기록 게이트가 비문자열 본문 행의 제목 컬럼을 비워 두므로, 그 이후에 기록된 행도 드물게 대상이 된다(index.json `decisions` (3)). 문서 문안을 "이전 버전에서 기록된 행"에만 한정해 쓰면 또 거짓이 된다 — "표시제목이 비어 있는 행"으로 쓰라.

## 작업

### 1-a. `docs/SCHEMA.md` 56행 — append-only 불변식의 명시 예외 (**필수**)

머리말의 `append-only — 행 삭제·수정 없음(DB 비파괴)`를 다음 취지로 정정한다(1~2줄):

- **행 삭제는 없다**(변함 없음).
- **행 수정은 표시제목(파생 컬럼)이 비어 있는 행을 1회 멱등 백필로 채우는 것뿐**이다.
- **이벤트 사실(이벤트유형·마크업버전·생성시간·행위자 등)은 어떤 경우에도 수정하지 않는다** — 원장이 기록한 "무슨 일이 언제 있었는가"는 불변이고, 그 사실에서 파생된 표시용 값만 채운다.

이 정정을 빠뜨리면 문서가 스스로 모순된다(56행은 "수정 없음", 60행은 "백필한다"). 새 문장이 후속 작업자에게 "원장의 사실 컬럼도 고쳐도 된다"로 읽히지 않게 **파생 표시 컬럼 한정**임을 분명히 하라.

### 1-b. `docs/SCHEMA.md` 60행 — snapshotTitle 설명

기존 문장을 **삭제·재구성하지 말고** 사실이 어긋난 부분만 고친다(다른 phase가 남긴 근거 문장을 지우지 않는다).

- `(백필·행 재작성 없음 — 이력은 append-only 원장이다)` → 부트 시 멱등 백필이 **빈 컬럼만** 채운다는 사실로 교체하되, **행 삭제·기존 값 덮어쓰기·다른 컬럼 수정이 없다**는 규율은 그대로 유지되도록 쓴다(1-a와 같은 취지여야 한다 — 두 문장이 어긋나면 실패다).
- 대상은 **표시제목이 비어 있는 행**이다("이전 버전에서 기록된 행"으로만 한정해 쓰지 마라 — 배경의 마지막 항목 참조).
- `(재파생·백필 없음)` → 백필은 **빈 값만** 채우므로 **이미 저장된 값은 재파생하지 않는다**(옛 규칙 값 유지)로 정정한다.
- 조회의 행 단위 폴백이 백필 이후에도 유지된다는 사실을 한 마디로 남긴다(폴백 코드가 왜 남아 있는지 후대가 알게).

분량은 **1-a 1~2줄 + 1-b 2~3줄**로 제한한다. 함수명·파일 경로·SQL은 적지 마라(문서 노후화 방지 — 이 절의 기존 표기 수위를 유지한다). `## ArticleHistory Table` 절 밖(상단 기술명세서·다른 테이블 절)은 건드리지 않는다.

### 2. `src/services/historyMeta.js` (주석만)

11~12행의 `규칙 드리프트(의도된 대가): ... (재파생·백필이 없다)` 를 사실에 맞게 1~2줄로 정정한다:

- 빈 컬럼을 채우는 **부트 백필은 있다**(그 백필도 이 함수를 파생 출처로 쓴다 — 규칙 단일 출처는 유지된다).
- 그러나 **이미 저장된 값은 재파생·덮어쓰기하지 않는다** → 드리프트 대가(같은 목록에 행마다 다른 규칙의 제목이 보일 수 있다)는 그대로다.

`snapshotTitle`·`decorateHistoryRows`·`resolveSnapshotTitle`의 **로직은 한 글자도 바꾸지 마라**. 이 파일에서 바뀌는 것은 주석뿐이다.

## Acceptance Criteria

```bash
npm test          # 실패 0 — step1 종료 시점 개수 그대로(문서·주석 step: 증가 0)
npm run test:web  # 실패 0 — 기준선 2368/2368(90 files) 그대로(web 무접촉)
npm run lint      # 통과
npm run build     # 통과
```

**diff scope**: 시작 시점 `git status --porcelain` 스냅샷 대비 증분이 `docs/SCHEMA.md`, `src/services/historyMeta.js`(주석만) **2개**(+ 진행·마감 기록 `phases/59-history-title-backfill/index.json`, `phases/index.json`)뿐.

## 검증 절차

1. 위 AC 4종을 실행하고 **2회 연속 동일 결과**인지 확인한다(flake 0). 기준선(backend 991 · web 2368/90 files) 대비 증가분을 기록한다.
2. `git diff src/services/historyMeta.js`로 **주석 줄만** 바뀌었는지 확인하라(코드 줄 변경 0). 확신이 서지 않으면 주석을 제외한 diff가 비어 있는지 눈으로 대조한다.
3. 문서 정합 점검:
   - 새 문장이 `src/db/schema.js`의 실제 구현(대상 술어 `snapshotTitle IS NULL AND length(markupVersion) > 0` · 빈 값만 · `''` 저장 · 멱등(채운 행 수 0·값 불변) · 행 삭제 0)과 정확히 일치하는가? 코드를 다시 열어 대조하라.
   - **56행(불변식 예외)과 60행(백필 설명)이 서로 모순되지 않는가?** 두 문장을 나란히 읽어 "행 삭제 0 / 표시제목 빈 컬럼만 1회 채움 / 이벤트 사실 불변"이 같은 내용으로 읽히는지 확인하라.
   - 56행의 새 문장이 "원장의 사실 컬럼도 수정 가능"으로 읽힐 여지가 없는가(파생 표시 컬럼 한정이 분명한가)?
   - `docs/SCHEMA.md` 상단의 "DB에 있는 내용은 절대 삭제하지 않는다"·"멱등 마이그레이션" 규율과 모순이 없는가?
   - `docs/ADR.md`·`docs/ARCHITECTURE.md`·`docs/news.md`가 무수정인가?
   - UTF-8로 저장됐고 마크다운 구조(절 제목·목록)가 깨지지 않았는가?
4. phase 마감:
   - `phases/59-history-title-backfill/index.json`의 step2를 `completed` + `summary`로 갱신하고, step0~1이 전부 `completed`인지 확인한다.
   - `phases/index.json`의 `59-history-title-backfill` 항목을 `completed`로 갱신하고 `note`에 다음을 남긴다: 무엇을 어떻게 채웠는지(대상 술어(기록 게이트보다 넓다는 점 포함)·주입 seam·배치/트랜잭션·`''` 저장·멱등(채운 행 수 0·값 불변)), 부트 결선과 로그 정책(0건 무로그), **E2E 실측(백필 전후 `queryHistory` deep equal + blob 적재 N → 0)**, **append-only 불변식에 명시 예외를 둔 결정(이벤트 사실 불변·파생 표시 컬럼 한정, 사용자 승인 2026-08-11)과 SCHEMA.md 2곳 정정**, DB 변경 0(스키마 무변경·행 삭제 0·기존 값 무덮기), 실 DB(news.db) 백필 대상 0행이라 로컬 체감 이득 0이라는 사실, 최종 테스트 수치.
   - `phases/index.json`의 `58-backlog-perf` note에 남아 있던 잔여 백로그 (a)("순수 레거시 기사는 개선 0")가 이 phase로 **해소**됐음을 59 항목 note에 한 줄로 명시한다(58 항목 note는 수정하지 마라 — 완료된 phase의 기록이다).
   - 잔여 백로그가 있으면 59 note 끝에 적는다(예: `articleHistoryModel.querySnapshotsByArticle` 소비자 0 정리는 여전히 미해결 — 이 phase 밖).
5. 최종 점검 목록(오케스트레이터 보고용):
   - DB 스키마 변경 0 · 행 삭제 0 · 기존 값 덮어쓰기 0인가? **수정된 컬럼이 `snapshotTitle` 하나뿐인가(이벤트 사실 컬럼 UPDATE 0)?**
   - 응답 계약(`/api/articles/:id/history` 등) 불변인가?
   - 앱 내 타이머·네트워크 egress가 새로 도입되지 않았는가(ADR-008)?
   - 무접촉 파일(`docs/news.md`·`docs/ADR.md`·`docs/ARCHITECTURE.md`·`web/**`·`scripts/**`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`)이 전부 그대로인가?

## 금지사항

- `docs/ARCHITECTURE.md`·`docs/ADR.md`·`docs/news.md`를 수정하지 마라. 이유: append-only 불변식에 예외를 둔 결정은 실제로 있었지만(index.json `decisions` (14)), 그 적용 범위가 파생 표시 컬럼 1개로 한정되어 아키텍처 흐름·계층·외부 계약을 바꾸지 않으므로 ADR 신설 기준에 미달한다 — 결정문은 phase index.json이 보관하고, 사실이 어긋나게 된 문서 `SCHEMA.md` 1개 파일(2곳)만 고친다. "결정이 바뀌지 않았다"는 근거로 쓰지 마라(거짓이다).
- 56행 정정을 "append-only 원장이므로 수정하지 않는다"는 원문 유지로 처리하거나 아예 건너뛰지 마라. 이유: 그러면 문서가 스스로 모순되고(56행 "수정 없음" ↔ 60행 "백필한다"), 다음 작업자가 어느 쪽을 믿어야 할지 알 수 없다.
- 56행 예외 문장을 "파생 컬럼 한정" 없이 일반화해서 쓰지 마라(예: "필요 시 보정한다"). 이유: 후속 작업자가 그 문장을 근거로 `eventType`·`createdAt`·`markupVersion` 같은 **이벤트 사실 컬럼**의 UPDATE를 정당화할 수 있다 — 그건 감사 원장의 조용한 재작성이며 별도 결정이 필요한 사안이다.
- `src/services/historyMeta.js`의 코드(함수 본문·시그니처·export)를 바꾸지 마라. 이유: 파생 규칙은 phase 58에서 확정됐고 기록·백필·폴백 3경로가 그 출력에 묶여 있다 — 규칙이 바뀌면 이미 저장된 행과 새로 채운 행이 서로 다른 제목을 낸다.
- 조회 경로의 레거시 폴백(`querySnapshotTitlesByArticle`의 `CASE` · `resolveSnapshotTitle`의 폴백 · `queryHistory`의 가드)을 "백필했으니 이제 불필요"라며 제거하거나 그렇게 제안하는 문서를 쓰지 마라. 이유: 백필을 돌리지 않은 DB·구버전 인스턴스가 기록한 행과 파생이 건너뛴 행이 남을 수 있고, 폴백 제거는 그 행의 제목이 통째로 사라지는 회귀다.
- 기존 문서 문장을 재구성·요약·삭제하지 마라(사실이 어긋난 부분만 교체). 이유: 다른 phase의 결정이 문서에 남긴 근거가 조용히 사라진다.
- 문서에 함수명·파일 경로·SQL을 적지 마라. 이유: 리팩터링마다 문서가 거짓이 된다 — 해당 절의 기존 표기 수위(개념 서술)를 유지한다.
- 완료된 phase(`58-backlog-perf` 등)의 `note`를 고쳐 쓰지 마라. 이유: 완료 기록은 그 시점의 사실이며, 후속 해소는 후속 phase의 note가 말한다.
- 테스트를 추가·수정하지 마라. 이유: 이 step은 주석·문서 전용이며, 테스트 변경은 step0·step1의 게이트를 사후에 흔든다.
- `.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`·`web/**`·`scripts/**`를 수정하지 마라.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
