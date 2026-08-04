# Step 4: submit-save-gate

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `CLAUDE.md` — TDD(테스트 먼저), DB 비파괴
- `docs/ADR.md` — ADR-003(View ← Controller ← Model), ADR-004(신뢰 경계=서버), ADR-008(송고 성공 시 즉시 배부 — 스풀 기록은 되돌릴 수 없다)
- `docs/ARCHITECTURE.md` — 데이터 흐름([쓰기]·[배부])
- `docs/news.md` 148~151행 — 송고/보류/KILL 후 작성페이지 초기화, 성공 시 상태 메시지 미표시, 편집 저장은 잠금 보유 세션만
- `web/src/controller/useWriteController.js` — **이 step이 수정하는 유일한 프로덕션 파일**. `toSaveDto`(L68~75), `save`(L288~296), `saveMapping`(L312~321), **`submit`(L326~345)**
- `web/src/model/httpModel.js` L88~118 — `request`는 reject하지 않고 실패를 `{ ok:false, reason }`으로 정규화한다(`network-error`/`invalid-response` 포함)
- `web/src/test/fakeModel.js` — `saveArticle`(잠금 보유 탭이 아니면 `{ ok:false, reason:'not-holder' }`), `applyAction`
- `web/src/controller/useWriteController.test.jsx` — 기존 submit 테스트(신규 탭 / 편집 탭 / clientId 전달)

## 배경 (이 step 안에서 자기완결)

`submit(action, override)`의 **편집 경로**(L338~339)는 이렇게 되어 있다:

```js
await model.saveArticle(toSaveDto(tab, override), tab.clientId);   // 결과를 보지 않는다
const r = await model.applyAction(tab.articleId, action);
```

저장이 실패해도(401/403/not-holder/네트워크 단절) 그대로 상태 전이가 진행된다. 결과:

- **옛 본문으로 송고·배부된다** — 송고 성공 훅이 즉시 스풀 파일을 쓰므로(ADR-008) 되돌릴 수단이 없다.
- `applyAction`이 성공하면 잠금 해제 + 탭 리셋이 일어나고, 호출부(WriterPage)는 `clearDraft(key)`까지 실행해 **편집분이 초안까지 지워진다**.
- phase 52가 세션 재검증(비활성/강등 즉시 반영)을 도입해 저장이 401/403으로 실패할 가능성은 오히려 늘었다.

이 step은 컨트롤러에서 **전이를 막는다**. 사용자 안내(alert)는 View 책임이라 step 6에서 한다 — 이 step은 반환 계약만 확정한다.

## 작업

### 1) 착수 전 실측

```bash
npm run test:web
npm run lint
```

### 2) 테스트 먼저 (TDD — red 확인 필수)

`web/src/controller/useWriteController.test.jsx`에 케이스를 추가한다(기존 `setup`/`FULL` 픽스처 재사용, `vi.spyOn(model, 'saveArticle')`로 실패 주입).

결함 재현 케이스(구현 전 red여야 한다):

1. 편집 탭에서 `saveArticle`이 `{ ok:false, reason:'not-holder' }` → `submit('send')` 호출 시 `applyAction`이 **호출되지 않고**, `unlockArticle`도 호출되지 않으며, 탭이 리셋되지 않는다(`activeTab.articleId === 'AKR1'`, 본문 필드 그대로). 반환값은 `{ ok:false, reason:'save-failed', saveReason:'not-holder' }`.
2. `saveArticle`이 `{ ok:false, reason:'network-error' }`(httpModel 정규화 값) → 동일하게 전이 없음, `saveReason:'network-error'`.
3. `saveArticle`이 `undefined`/`null`을 반환(비정상 모델) → 전이 없음, `reason:'save-failed'`(`saveReason`은 `null` 또는 미정의 — 단언을 과하게 좁히지 마라).
4. `saveArticle`이 `{ ok:'yes' }`처럼 truthy지만 `true`가 아닌 값 → 전이 없음(성공 판정은 `=== true`).

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

5. 저장 성공 → `applyAction(articleId, action)` 호출 → 성공 시 `unlockArticle(articleId, clientId)` + 탭이 빈 새 기사 탭으로 리셋(기존 테스트 그대로).
6. 신규 탭(`articleId` 없음) 경로는 무변경 — `saveArticle(dto, clientId, action)` 1회, `applyAction` 미호출, 성공 시 리셋. 저장 실패 시에는 리셋되지 않는다(기존 동작).
7. `save`·`saveAsNew`·`saveMapping`의 동작·반환이 그대로다(특히 `saveMapping`은 이미 `r.ok`를 확인한다 — 건드리지 마라).
8. 저장 성공 + `applyAction` 실패(`{ ok:false, reason:'forbidden-transition' }`) → 잠금 해제·탭 리셋 없이 **applyAction의 결과를 그대로 반환**한다(기존 계약 유지 — `save-failed`로 바꾸지 마라).

### 3) 구현 — `web/src/controller/useWriteController.js`만 수정

`submit`의 편집 경로만 바꾼다:

```js
const saved = await model.saveArticle(toSaveDto(tab, override), tab.clientId);
if (!saved || saved.ok !== true) {
  return { ok: false, reason: 'save-failed', saveReason: (saved && saved.reason) ?? null };
}
const r = await model.applyAction(tab.articleId, action);
// 이하 기존 그대로
```

핵심 규칙(설계 의도 — 벗어나지 마라):

- 성공 판정은 **`saved.ok !== true`** 로 한다(truthy 판정 금지 — 서버/모델이 이상값을 줄 때 조용히 전이하면 안 된다).
- 실패 시 `applyAction`·`unlockArticle`·`resetTabToBlank`를 **전부 건너뛴다**. 탭·본문·`clientId`·초안은 그대로 남는다.
- 자동 재시도·자동 재저장을 넣지 마라(사유가 not-holder/forbidden이면 영구 실패, network-error면 중복 저장 위험).
- 반환 shape `{ ok:false, reason:'save-failed', saveReason }`은 **step 6(View 안내)이 소비하는 계약**이다. 키 이름을 바꾸지 마라.
- `saveMapping`·`save`·`saveAsNew`·신규 생성 경로는 수정하지 않는다.
- 왜 전이를 막는지(옛 본문 송고·배부 + 초안 삭제로 편집분 영구 소실, 배부는 스풀 기록이라 되돌릴 수 없음)를 주석으로 남겨라.

## Acceptance Criteria

```bash
npm run test:web    # 기준선 + 신규 케이스, fail 0
npm run lint        # clean
npm run build       # 번들 빌드 성공
npm test            # 백엔드 무접촉 확인 — 751 그대로 green
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증(확인 후 반드시 원복): 새 가드를 제거하면 케이스 1~4가 red가 되는가? 성공 판정을 `saved && saved.ok`(truthy)로 바꾸면 케이스 4가 red가 되는가?
3. 아키텍처 체크리스트:
   - 수정 범위가 `web/src/controller/useWriteController.js` + 그 테스트뿐인가? (`WriterPage.jsx`·`fakeModel.js`·`httpModel.js`·`server/`·`src/` 변경 0건)
   - 컨트롤러가 View를 import하지 않는가?(의존 방향 View ← Controller ← Model)
   - 컨트롤러에 `window.alert` 같은 UI 부수효과를 새로 추가하지 않았는가?(안내는 step 6)
4. 결과에 따라 `phases/53-integrity-fixes/index.json`의 step 4를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "submit 편집 경로 가드·반환 계약({ ok:false, reason:'save-failed', saveReason })·테스트 증감 요약 — step6이 소비할 계약을 반드시 명시"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- 저장 실패를 무시하고 `applyAction`을 호출하지 마라. 이유: 송고는 즉시 배부(스풀 파일 기록)를 일으키고(ADR-008) 되돌릴 수단이 없다 — 옛 본문이 외부로 나간다.
- 저장 실패 시 탭을 리셋하거나 잠금을 해제하지 마라. 이유: 그 순간 편집분이 화면에서 사라지고 호출부가 초안까지 지운다(복구 불가).
- 자동 재시도 루프를 넣지 마라. 이유: not-holder/forbidden은 재시도해도 영구 실패이고, 네트워크 실패 재시도는 중복 저장(중복 이력·중복 배부 후보)을 만든다.
- `save`/`saveMapping`/`saveAsNew`/신규 생성 경로의 동작을 바꾸지 마라. 이유: 이번 감사 지적은 **편집 송고 경로 한 곳**이며, 다른 경로 변경은 검증 범위를 넓힌다.
- 컨트롤러에서 `window.alert`/`confirm`을 호출하지 마라. 이유: 사용자 피드백은 View(step 6) 책임이다. (기존 `openArticle`의 '편집중입니다.' 알림은 이 step에서 건드리지 않는다 — step 5 소관.)
- 반환 키 이름(`reason`/`saveReason`)을 바꾸거나 사유 문자열을 사람이 읽는 문장으로 만들지 마라. 이유: step 6이 토큰으로 분기해 문구를 만든다(문구는 View 소유).
- 기존 테스트를 깨뜨리지 마라.
