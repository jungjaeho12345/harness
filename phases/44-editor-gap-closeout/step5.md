# Step 5: continue-view-test

## 목표

ListPage 우클릭 컨텍스트 메뉴 4종(후속기사작성·재송·번역·계속기사작성) 중 **'계속기사작성'만 뷰(ListPage) 레벨 통합 테스트가 부재**하다. 후속기사작성 테스트(ListPage.test.jsx L381)와 동형으로 '계속기사작성' 테스트 1건을 추가한다. **테스트만 추가 — 프로덕션 코드는 변경하지 않는다.**

## 읽어야 할 파일

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — View←Controller←Model, `deriveArticle`는 컨트롤러 경유).
- `web/src/view/ListPage.test.jsx` — **L381~398 후속기사작성 테스트**(동형 템플릿):
  ```
  it('우클릭 후속기사작성 → deriveArticle(followUp) 후 새 기사로 편집 진입한다', async () => {
    const navigate = vi.fn();
    const model = createFakeModel({ articles: [{ articleId: 'AKR9', title: 't', status: 'DPS', lockYN: 'N' }] });
    const derive = vi.spyOn(model, 'deriveArticle');
    render(<AppContext.Provider value={{ model, identity: { userId: 'kim', name: '김기자', role: 'D', department: '정치' }, navigate, replace: vi.fn(), setSession: vi.fn() }}><ListPage /></AppContext.Provider>);
    await userEvent.click(screen.getByRole('button', { name: '부서별 송고' }));
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1));
    fireEvent.contextMenu(bodyRows(container)[0]);
    await userEvent.click(screen.getByRole('menuitem', { name: '후속기사작성' }));
    await waitFor(() => expect(derive).toHaveBeenCalledWith('AKR9', 'followUp'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('writer.do', expect.objectContaining({ articleId: expect.not.stringMatching('AKR9') })));
  });
  ```
  파일 상단 import·헬퍼(`setup`/`bodyRows`/`createFakeModel`/`AppContext`)와 재송(L400~411)·번역(L413~428) 테스트도 확인.
- `web/src/view/ListPage.jsx` — **L100~119 `onSelect` 스위치**(`case 'followUp': createFollowUp(article)`, **`case 'continue': createContinue(article)`**). 계속기사작성은 `continue` 키.
- `web/src/view/ContextMenu.jsx` — **L68~69**(`{ key: 'followUp', label: '후속기사작성', enabled: canWrite }`, `{ key: 'continue', label: '계속기사작성', enabled: canWrite }`). 메뉴 라벨 = `'계속기사작성'`, 작성권한(R/D/Z)에서 활성.
- `web/src/controller/useViewController.js` — **L195~197 `createContinue`**(`const r = await model.deriveArticle(article.articleId, 'continue');` → 새 기사로 편집 진입). 모드 인자는 `'continue'`.
- `web/src/test/fakeModel.js` — L161~166 `deriveArticle(articleId, mode)`(continue=본문 복사·followUp=빈 본문, **원본 비변경** 비파괴 모사). 새 articleId를 만들어 push.
- `web/src/model/contract.test.js` — L153~158(`deriveArticle('AKR1','continue')`가 원본 미변경으로 새 기사 생성 — 모델 레벨은 이미 커버, 뷰 레벨만 부재).

## 배경 (자기완결)

'계속기사작성'은 후속기사작성과 **동일 경로·다른 모드**다: 우클릭 → ContextMenu `continue` 항목(라벨 '계속기사작성', canWrite 활성) → ListPage `onSelect('continue')` → `createContinue(article)` → `model.deriveArticle(id, 'continue')` → 새 기사(원본 비파괴)로 `navigate('writer.do', { articleId: <새 id> })`. 모델 레벨(contract.test.js L158)·컨트롤러 레벨(useViewController.test.jsx L266)은 이미 테스트가 있으나 **뷰(ListPage) 레벨만 부재**하다. 이 step이 그 공백을 후속기사작성 테스트 동형으로 메운다.

## TDD — 추가할 테스트 (`web/src/view/ListPage.test.jsx`)

L381 후속기사작성 테스트 **바로 아래**(또는 그 근처, 우클릭 액션 describe 안)에 동형 1건 추가:

```js
it('우클릭 계속기사작성 → deriveArticle(continue) 후 새 기사로 편집 진입한다', async () => {
  // L381 후속기사작성 테스트와 동형 — 차이는 (1) 메뉴 항목 '계속기사작성', (2) 모드 'continue'.
  // navigate 스텁 + createFakeModel + deriveArticle 스파이. 원본(AKR9) 비파괴 → 새 articleId로 writer.do 진입.
});
```

단언(후속기사작성과 동형, 모드만 교체):
- `fireEvent.contextMenu(bodyRows(container)[0])` 후 `screen.getByRole('menuitem', { name: '계속기사작성' })` 클릭.
- `await waitFor(() => expect(derive).toHaveBeenCalledWith('AKR9', 'continue'));` — **모드 인자 `'continue'`**(followUp 아님).
- `await waitFor(() => expect(navigate).toHaveBeenCalledWith('writer.do', expect.objectContaining({ articleId: expect.not.stringMatching('AKR9') })));` — 새 기사로 편집 진입(원본 id 아님).
- identity role은 작성권한(R/D/Z 중 하나 — 템플릿의 `role: 'D'` 재사용) — canWrite 활성 전제.
- seed 기사 상태(`status: 'DPS'`)·메뉴 진입(`'부서별 송고'`)은 템플릿과 동일(계속기사작성도 canWrite면 노출 — 상태 게이트 없음, ContextMenu L69).

> **구현 팁**: `render` 반환의 `container`를 받아 `bodyRows(container)`를 쓴다(템플릿이 `const { container } = render(...)`로 받는 형태면 그대로). `createFakeModel`·`AppContext`·`bodyRows`는 파일에 이미 import/정의됨 — 새 import 불필요.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(client 전용 — 테스트 추가만. `npm test`(node --test) 불필요 — 백엔드 파일 미변경.)

## 회귀 가드 / 불변식

- **테스트 전용**: `ListPage.jsx`·`ContextMenu.jsx`·`useViewController.js`·`fakeModel.js` 등 프로덕션 코드는 **diff에 없어야 한다**(테스트 파일 1개만 변경).
- **모드 정확성**: `deriveArticle` 스파이 단언은 `'continue'`여야 한다(`'followUp'`이면 복붙 실수 — 반드시 교체 확인).
- **비파괴**: fakeModel `deriveArticle`이 원본 미변경으로 새 id를 만드는 계약을 검증(원본 AKR9 아닌 새 articleId로 navigate).
- 기존 ListPage 테스트(후속/재송/번역 포함) 전부 그린 유지.

## 커밋 계획

- **feat**(테스트 보강): `test(44-editor-gap-closeout): step5 — ListPage 계속기사작성 우클릭 뷰 통합 테스트 추가(deriveArticle continue)` — `ListPage.test.jsx` 1파일. (conventional commits `test:` 사용; 프로젝트 관례가 `feat:`뿐이면 `feat(...)`로 대체 가능하나 프로덕션 코드 없음을 메시지에 명시.)
- **chore**: `chore(44-editor-gap-closeout): step5 status — completed` — index.json step5(phase 44 전체 완결).

## 금지사항

- 프로덕션 코드를 변경하지 마라. 이유: 계속기사작성 경로는 이미 결선·동작하며(ListPage L107·useViewController L196·ContextMenu L69) 뷰 테스트만 부재다 — 코드 변경은 범위 밖이고 회귀 표면을 넓힌다.
- 모드 인자를 `'followUp'`으로 두지 마라(복붙 실수). 이유: 계속기사작성은 `'continue'` — `deriveArticle('AKR9','continue')`를 단언해야 실제 계약을 검증한다.
- 새 헬퍼/모델 시드 형식을 만들지 마라. 이유: L381 템플릿의 `createFakeModel`/`AppContext`/`bodyRows`를 그대로 재사용해 일관성을 유지한다.
- 기존 테스트를 깨뜨리지 마라.
