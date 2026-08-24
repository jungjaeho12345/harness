# Step 5: docs-notes

## 목표

**실행 코드 변경 0건**인 문구·주석 위생 2건을 처리한다.

1. `docs/news.md` **L262**의 엠바고 송고 상태를 실제 구현·같은 문서의 생애주기 서술과 맞춘다: `EPS` → `DES` (**사용자 승인 범위 = 이 한 줄뿐**).
2. `web/src/view/editorEditOps.js`의 `sameBlocks`(L21~31)에 "align을 비교하지 않아도 안전한 이유"를 **주석 한 줄**로 남긴다(코드 무변경).

> **선행**: phase의 마지막 step. 이 step은 테스트를 추가·수정하지 않으므로, `npm test`/`npm run test:web`의 **개수는 step4 종료 시점과 동일**해야 한다(실패 0).

## 읽어야 할 파일

라인 번호는 실측 힌트 — 문구로 재확인하라.

- `docs/news.md`
  - **L256~263 "엠바고 규칙"** 절. 대상은 **L262**: `- 1차 엠바고 또는 2차 엠바고 기사의 시간이 설정되어있으면 해당 기사는 데스크 미송고에서 송고시 EPS가 된다.`
  - **L284**: `- 엠바고 기사는 RDS->DES->EPS 가 기본 생애주기가 된다.` ← 정합 대상(수정 금지).
  - L263(`EPS된 기사는 엠바고 관리 메뉴에서 편집할 수 있다.`)·L277~278(EPS 기사 KILL/보류) ← **수정 금지**.
- `docs/SCHEMA.md` **L50~51** — DES 정의("엠바고가 설정된 기사를 데스크가 송고했을 때의 배부 전 대기 상태", 첫 배부 후 EPS, 완결 시 DPS). 읽기만 — 이번 승인 범위 밖이라 수정하지 않는다.
- `src/services/articleService.js` — **L92~95 `DES_ENTRY_STATUSES = new Set(['RDS','DDH'])`**, **L164~174**: `action === 'send'`이고 이전 상태가 RDS·DDH이며 엠바고가 설정돼 있으면 `finalStatus = 'DES'`. **L77 주석**: "송고 직후 상태는 DES뿐이다(EPS는 배부가 실제 실행된 뒤 `syncEmbargoStatus`가 만든다)". → 문구 수정의 근거다.
- `src/services/lifecycle.js` **L17~19** — DES 전이표(`kill: 'EEK'`, `hold: 'EEH'`).
- `web/src/view/editorEditOps.js` — **L21~31 `sameBlocks(a, b)`**(텍스트만 비교), **L33~55 `sortDocument`**(안정 정렬 + 마커 align 승계), L47 `sorted = values.slice().sort((a,b) => a.text.localeCompare(b.text))`.
- 참고: `phases/49-mini-backlog-cleanup/index.json` step4 요약 — 정렬 의미론이 **pair-following**(줄 = 텍스트 + 정렬 한 쌍)으로 확정됐고 `sameBlocks`는 무수정으로 남겼다는 결정.

## 배경 (자기완결)

**(1) news.md L262** — phase 48이 엠바고 생애주기를 `RDS → DES → EPS → DPS`로 완성하면서, "데스크 미송고에서 송고"의 직후 상태는 **DES**(배부 전 대기)가 됐다. EPS는 첫 배부가 **실제로 실행된 뒤** `syncEmbargoStatus`가 만든다. 즉 L262의 `EPS`는 구현·L284·SCHEMA.md L51과 어긋난 잔재이며, 사용자가 `DES`로 고치는 것을 승인했다. 기존 EPS 행은 그대로 보존된다(DB 비파괴) — 문서 수정은 데이터에 아무 영향이 없다.

**(2) sameBlocks 주석** — `sortDocument`는 `{text, align}` 쌍을 텍스트 기준 **안정 정렬**한 뒤 텍스트-블록 슬롯에 되쓴다. `changed` 판정에 쓰는 `sameBlocks`는 텍스트만 비교해서, 언뜻 "align만 이동한 변화를 놓치는 것 아닌가"로 읽힌다. 실제로는 안전하다: 안정 정렬에서 **출력 텍스트 시퀀스가 입력과 동일하다면 입력이 이미 정렬돼 있었다는 뜻이고, 그때 정렬은 항등 순열이라 align 쌍도 그대로**다(값이 같아 비교 0인 원소끼리도 상대 순서가 보존되므로 자리를 바꾸지 않는다). 이 불변식이 근거라는 사실이 코드에 적혀 있지 않아 다음 독자가 같은 의심을 반복한다 — 그래서 한 줄을 남긴다. (`sortParagraph`는 `sameBlocks`를 쓰지 않고 자체적으로 쌍 비교를 하므로 무관하다.)

## 작업

1. `docs/news.md` L262 — `EPS가 된다` → `DES가 된다`. **그 줄의 나머지 문자(선행 공백·하이픈·조사·마침표)는 1바이트도 바꾸지 마라.** 결과:

   ```
    - 1차 엠바고 또는 2차 엠바고 기사의 시간이 설정되어있으면 해당 기사는 데스크 미송고에서 송고시 DES가 된다.
   ```

   news.md의 다른 줄은 건드리지 않는다(L263의 EPS 문장 포함 — 승인 범위 밖).

2. `web/src/view/editorEditOps.js` `sameBlocks` 주석(L21~22)에 **한 줄 추가**. 담을 내용: align을 비교하지 않는 것은 의도이며, 안정 정렬 하에서 텍스트 시퀀스가 그대로면 정렬은 항등 순열이라 align 쌍도 이동하지 않는다(그래서 텍스트 비교만으로 `changed` 판정이 성립한다). 함수 본문·시그니처·호출부는 **무변경**이다.

이 step에서는 테스트 파일을 추가·수정하지 않는다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web    # 실패 0 — 개수는 step4 종료 시점과 정확히 동일(테스트 미추가)
npm test            # 실패 0 — 개수는 step1 종료 시점과 정확히 동일
```

`git diff --name-only`는 `docs/news.md`와 `web/src/view/editorEditOps.js` **2개뿐**이어야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다. 테스트 **개수 자체가 직전과 동일**한지 확인하라(문서·주석만 바뀌었다는 증거).
2. `git diff --numstat docs/news.md`가 `1 1`(1줄 추가·1줄 삭제)인지 확인한다. 2줄 이상 바뀌었으면 범위를 넘은 것이다 — 되돌려라.
3. `git diff web/src/view/editorEditOps.js`에 **주석 줄만** 있는지 확인한다(`+`/`-` 라인 중 실행 코드 0줄).
4. 정합 확인: `git grep -n "EPS" -- docs/news.md`로 남은 EPS 언급(L105 배지 색·L263 엠바고 관리 편집·L277~278 KILL/보류·L284 생애주기)이 **그대로**인지 확인한다.
5. `phases/50-hygiene-cleanup/index.json`의 step5를 `completed` + `summary`로 갱신한다. **phase 50 전 step(0~5) 완결**을 summary에 명시하라.

## 금지사항

- `docs/news.md`의 다른 줄을 손대지 마라(L263·L277~278·L284 포함). 이유: 사용자 승인 범위는 L262 한 줄이며, 스펙 문서는 하류 phase 전체의 근거라 승인 없는 문구 변경은 계획을 오염시킨다.
- `docs/SCHEMA.md`·`docs/ARCHITECTURE.md`·`docs/ADR.md`를 갱신하지 마라. 이유: 이미 DES를 정확히 서술하고 있고, 이번 승인 범위 밖이다.
- `sameBlocks`에 align 비교를 추가하지 마라. 이유: 이 step은 주석 전용이고, 판정을 넓히면 정렬 결과가 같은데도 `changed=true`가 되어 불필요한 dirty·저장이 발생한다(phase 49 step4가 남긴 설계 결정).
- `sortDocument`/`sortParagraph`의 정렬 의미론(pair-following)을 다시 논의하거나 뒤집지 마라. 이유: phase 49 step4에서 확정된 결정이다.
- 소스 코드나 테스트를 함께 수정하지 마라(주석 1줄 제외). 이유: "실행 코드 무변경"이 이 step의 검증 가능성 그 자체다.
- `.claude/skills/claude-code-review-harness/SKILL.md`를 읽거나 수정하거나 커밋에 포함하지 마라. 이유: 사용자가 편집 중인 파일이다.
