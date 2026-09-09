# Step 4: shell-config-probe

shell 레이어의 **순수 정책 모듈 2종**을 이식한다: (a) 서버 주소 정규화 + `/api/health` 응답 판정(`client/lib/serverUrl.js` 동형) (b) config.json 화이트리스트 입출력(`client/lib/clientConfig.js` 동형). **네트워크 I/O·파일 I/O는 주입 의존성 뒤로 격리**하고 순수 판정만 단위 테스트한다.

## 읽어야 할 파일
- `client/lib/serverUrl.js` (정본 — `normalizeServerUrl`·`healthUrl`·`appUrl`·`isSameOrigin`·최종 origin 승격 fail-safe. 스킴 보정·`host:port` 오인·자격증명 거부·IPv6·유니코드 호스트 규칙)
- `client/lib/clientConfig.js` (정본 — 화이트리스트 shape `{schemaVersion, serverUrl, bounds:{width,height,x,y,maximized}}` · `parseConfig`는 throw 금지 · 화이트리스트 밖 키 폐기 · tmp→rename 원자적 쓰기 · MIN_WIDTH/HEIGHT)
- `docs/ADR.md` ADR-011(접속형 셸 · health `{ok:true}` 본문까지 확인 · 리다이렉트 최종 origin 승격 fail-safe · config에 세션·자격증명 필드 없음) + step1 신설 P4 ADR
- `docs/porting-plan-cpp-spring.md` §6.2(셸 계약 이식 필수 항목 — 프로브·config)
- `phases/77-cpp-client-skeleton/index.json` decisions (5)(7) · `client-qt/CMakeLists.txt`(step3 골격 — `shell/` 타깃)

## 작업
1. **TDD**: `client-qt/tests/`에 `ServerUrlTest`·`ClientConfigTest`를 먼저 쓴다. 케이스는 `client/lib/serverUrl.js`·`clientConfig.js`의 동작 명세와 그에 대응하는 웹 테스트(있으면 `client/**` 테스트)를 입출력 표로 추출한다. red 확인 후 구현.
2. `client-qt/shell/`에 순수 판정 함수/클래스:
   - `normalizeServerUrl(input) -> {ok, origin} | {ok:false, reason}` — 스킴 보정·`ALLOWED_SCHEMES={http,https}`·자격증명(`user`/`pass`) 거부·경로/쿼리/해시 폐기·`new URL` 상당(Qt `QUrl`)만 사용(문자열 조립 금지).
   - `healthUrl(origin)`·`appUrl(origin)`·`isSameOrigin(url, origin)`(파싱 실패 = fail-closed).
   - **health 판정**: 응답 본문이 `{ok:true}`인지까지 확인해야 승격(200만으로 승격 금지). 프로브 **실행**(네트워크)은 주입된 HTTP 클라이언트 뒤로 두고, 이 step은 **응답→승격 판정 순수 함수**와 리다이렉트 최종 origin fail-safe(비정상 스킴·자격증명·https→http 하향은 미승격)를 이식·테스트한다.
   - `parseConfig(raw)`(throw 금지 · 화이트리스트) · `serializeConfig` · `configPath(userDataDir)`(Qt `QStandardPaths::AppConfigLocation` 하위 `기사작성기/config.json`) · 원자적 쓰기 계획(tmp→rename — 실제 fs는 주입).
3. **프로브는 사용자 액션당 1회**다(ADR-008 · 앱 내 타이머·주기 통신 0). 자동 폴링·재시도 루프를 만들지 마라.

## Acceptance Criteria
```
cmake --build client-qt/build
QT_QPA_PLATFORM=offscreen ctest --test-dir client-qt/build --output-on-failure   # ServerUrlTest·ClientConfigTest green
cd /home/user/harness && git diff --stat    # client-qt/shell·tests 만 바뀐다
```
- `normalizeServerUrl`가 `"192.168.0.10:3001"`(스킴 없음)·`"localhost:3001"`(host:port 오인)·`"ftp://x"`(unsupported-scheme)·`"http://u:p@h"`(credentials)·빈문자열(empty)를 웹 정본과 같은 `{ok/reason}`으로 판정한다(테스트가 이를 단언).
- `parseConfig`가 깨진 JSON·화이트리스트 밖 키·세션ID 필드를 넣은 입력에 **throw 없이** 안전 기본값/폐기로 응답한다.

## 검증 절차
1. `serverUrl.js`의 각 reason 토큰(empty·unsupported-scheme·invalid·credentials·no-host)과 승격 fail-safe 분기가 C++ 테스트에 1:1로 있는지 확인.
2. config에 `sessionId`/`password`/`token` 키를 넣은 입력이 결과에서 사라지는 테스트가 있는지 확인(보안 불변식).
3. 프로브 실행 코드에 타이머/`while` 폴링이 없는지 확인(ADR-008).

## 금지사항
- config에 세션·자격증명·쿠키·토큰 필드를 추가하지 마라. 이유: config.json은 신뢰 경계 밖 파일이다 — 자격증명이 평문으로 남으면 유출 표면이 된다(decisions (7)).
- origin을 문자열 자르기/정규식으로 조립하지 마라. 이유: 포트 생략·IPv6·유니코드에서 조용히 틀린 origin이 나오고 그 값이 동일 출처 판정(새 창 허용)의 입력이 된다 — `QUrl`만 써라(serverUrl.js CRITICAL 주석).
- health를 200만으로 승격하지 마라. 이유: 임의 웹서버가 "정상"으로 저장된다 — `{ok:true}` 본문까지 확인해야 한다(ADR-011).
- 프로브에 주기 타이머·자동 재시도를 넣지 마라. 이유: 앱 내 타이머·egress 0 원칙(ADR-008).
