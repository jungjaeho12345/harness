# Step 5: shell-diag

diag JSONL 방출기를 이식한다 — **Electron 셸의 diag 계약과 미러링**해 같은 verify 계약(step11)이 그대로 적용되게 한다. 이벤트 이름·payload 필드·**금지키 7종**·URL redaction 규율을 `client/diag.js`에서 1:1로 옮기고, 네이티브에 없는 **렌더러 계열 이벤트의 재매핑/생략 목록**을 확정해 문서에 잠근다.

## 읽어야 할 파일
- `client/diag.js` (정본 — `FORBIDDEN_KEYS = {body,sessionId,cookie,cookies,password,token,headers}` · `redactUrl`(origin+pathname · `file:`은 스킴+파일명 · `about:blank` 통과) · `redactDiagEvent`(평문 필드만 · url 키는 redact) · `formatDiagLine`(ts ISO + event + payload) · `createDiag({filePath, appendFileSync})`(filePath 없으면 no-op · 기록 실패 삼킴))
- `scripts/verify-client.mjs` (diag 이벤트 시나리오 A/B 단언 — 어떤 이벤트가 어떤 순서로·어떤 필드로 나와야 하는지의 정본)
- 셸이 실제로 내는 이벤트 이름 18종: `app-ready · app-window · config-loaded · config-saved · did-finish-load · did-navigate · ipc · load-failed · local-window · navigation · probe · render-process-gone · restart-required · second-instance · secure-origin-switch · setup-shown · unresponsive · window-open`
- `docs/porting-plan-cpp-spring.md` §6.2(diag JSONL 이벤트 이름·필드·금지키 7종 유지 · **렌더러 계열 4이벤트만 재매핑**)
- `phases/77-cpp-client-skeleton/index.json` decisions (6) · step1 신설 P4 ADR

## 작업
1. **TDD**: `DiagTest`를 먼저 쓴다 — redaction(금지키 제거·url 축약·`file:` 축약)·`formatDiagLine` shape(`{ts,event,...}` 한 줄 JSON)·`filePath` 없을 때 no-op·기록 실패 삼킴. red 확인 후 구현.
2. `client-qt/shell/`에 `Diag` — `CLIENT_DIAG_FILE`(또는 동형 env)이 있을 때만 append하는 검증 자동화 단일 출처. 파일 접근은 주입(테스트는 in-memory sink).
3. **금지키·redaction 불변식**: 금지키 7종은 payload에서 제거, url 키는 origin+pathname까지만, `file:`은 스킴+파일명만, `about:blank`는 통과. 평문(string/number/bool/null) 필드만 직렬화.
4. **이벤트 재매핑 목록 확정**(문서에 표로 — `docs/cutover-p4.md` §5):
   - **그대로 유지(셸 계열)**: `app-ready · config-loaded · config-saved · app-window · local-window · setup-shown · second-instance · probe · load-failed · restart-required · window-open · navigation · secure-origin-switch`(secure-origin은 http 비-loopback일 때만 · Qt에서 동형 판정 가능하면 유지, 불가하면 §5에 "네이티브 해당 없음"으로 기록).
   - **재매핑/생략(렌더러 계열)**: `did-finish-load · did-navigate · render-process-gone · unresponsive`(+ `ipc`) — Chromium 렌더러 개념이라 Qt에는 없음. Qt 창 로드 완료/네비게이션/크래시에 대응하는 이벤트가 있으면 **같은 이름으로 재매핑**하고, 없으면 생략하되 **verify 계약(step11)이 그 이벤트를 요구하지 않도록** 목록에 명시한다. 이 결정을 step11이 소비한다.
5. main.js가 이벤트를 **명시 구성**하듯(본문 필드가 payload에 올 수 없게), Qt 셸도 diag payload를 명시 조립한다 — 기사 본문·세션을 실수로 싣지 않는다.

## Acceptance Criteria
```
cmake --build client-qt/build
QT_QPA_PLATFORM=offscreen ctest --test-dir client-qt/build --output-on-failure   # DiagTest green
cd /home/user/harness && git diff --stat    # client-qt/shell·tests + docs/cutover-p4.md 만 바뀐다
```
- `DiagTest`가 금지키 7종 각각을 넣은 payload가 결과 라인에서 사라짐을 단언한다.
- `DiagTest`가 `url` 필드에 `https://h:3001/x?sid=SECRET#y`를 넣으면 결과가 `https://h:3001/x`(쿼리·해시 제거)임을 단언한다.
- 재매핑/생략 목록이 `docs/cutover-p4.md` §5에 표로 있고, 유지 이벤트의 이름이 Electron과 문자 그대로 같다.

## 검증 절차
1. redaction 테스트가 `body`·`sessionId`·`cookie`·`password`·`token`·`headers`·`cookies` 7종을 개별로 커버하는지 확인.
2. `file:///C:/Users/x/config.json` → `file:///config.json`(경로 비노출) 테스트가 있는지 확인.
3. 유지 이벤트 목록을 `scripts/verify-client.mjs`가 단언하는 이름과 대조해 문자 일치 확인.

## 금지사항
- 금지키 7종을 줄이거나 URL redaction을 느슨하게 하지 마라. 이유: diag는 검증 자동화의 단일 출처이면서 유출 표면이다 — 기사 본문·세션·토큰이 JSONL에 새면 안 된다(client/diag.js CRITICAL).
- 유지 이벤트의 이름을 임의로 바꾸지 마라. 이유: 같은 이름이어야 기존 verify 계약이 재사용된다(AC ②의 전제).
- diag 기록 실패가 앱을 죽이게 하지 마라. 이유: 진단이 본말전도로 앱을 내리면 안 된다 — 실패는 삼킨다(client/diag.js).
