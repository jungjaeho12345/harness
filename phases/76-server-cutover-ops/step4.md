# Step 4: client-server-target

## 읽어야 할 파일

- `phases/76-server-cutover-ops/index.json` — scope·decisions (6)(7).
- `docs/ADR.md` — **ADR-011**(Electron 접속형 셸 — 백엔드·DB 미내장, 원격 페이지에 Node 권한 0).
- `client/lib/serverUrl.js` — `normalizeServerUrl`(자격·미허용 스킴 거부 · `new URL`만) · `healthUrl`/`appUrl`/`resolveFinalOrigin`. 서버 주소 판정 단일 출처.
- `client/lib/clientConfig.js` — `parseConfig`(화이트리스트 `{schemaVersion, serverUrl, bounds}` · throw 금지 · 비밀 필드 없음).
- `client/main.js` 171~181행 — 부팅 시 `bootConfig.serverUrl`이 있으면 앱 창을, 없으면 `setup` 화면을 연다. **여기가 배포 기본값이 들어갈 자리다.**
- `test/client-shell-core.test.js` · `test/client-secure-origin.test.js` — 순수 클라 로직의 기존 단위 테스트 형태(`node --test`, `npm test`가 스캔).

## 배경 / 목적

병행 운영 창에서 **패키지 클라이언트를 Spring 서버로 미리 가리키는** 배포 편의를 더한다. 신규/초기화 설치에서 사용자가 매번 주소를 치지 않고 배포가 `NEWS_SERVER_URL`로 기본 대상을 준다. **저장된 serverUrl이 있으면 그것을 존중**하고(사용자·이전 설정 우선), 없을 때만 env 기본값을 **기존 정규화·프로브·fail-safe 경로로** 적용한다. 신뢰 경계·권한 모델은 바꾸지 않는다.

## 작업

TDD로 진행한다.

1. **순수 리졸버 + 테스트 먼저.** `client/lib/clientConfig.js`(또는 인접 순수 모듈)에 추가:

```js
// 부팅 시 실효 서버 주소를 정한다: 저장값 우선, 없으면 배포 env 기본값(정규화 통과 시)만.
//   savedServerUrl: parseConfig 결과의 serverUrl(null 가능 · 이미 정규화된 origin)
//   envServerUrl:   process.env.NEWS_SERVER_URL (미설정 시 undefined/'')
// 반환: 실효 origin 문자열 | null(둘 다 없거나 env가 유효하지 않음)
// CRITICAL: env 기본값도 normalizeServerUrl을 반드시 경유한다 — 자격 포함·미허용 스킴은 거부(null).
//   저장값이 있으면 env를 보지 않는다(사용자 설정 우선).
export function resolveBootServerUrl({ savedServerUrl, envServerUrl }) { /* ... */ }
```

   테스트(`test/client-server-target.test.js` 신설 · `node --test`):
   - 저장값이 있으면 env가 있어도 저장값을 돌려준다.
   - 저장값이 없고 env가 유효하면 정규화된 origin을 돌려준다.
   - 저장값·env 둘 다 없으면 null.
   - env에 자격(`user:pass@`)·미허용 스킴이 있으면 null(정규화 거부) — 잘못된 배포값이 조용히 접속불능을 만들지 않는다.

2. **셸 결선(최소).** `client/main.js`에서 부팅 실효 주소를 `resolveBootServerUrl({ savedServerUrl: cfg.serverUrl, envServerUrl: process.env.NEWS_SERVER_URL })`로 계산해, 값이 있으면 지금처럼 `probeOrigin`→앱 창 경로로, 없으면 `setup` 화면으로 간다. **프로브·fail-safe(하향 미승격)·secure-origin 스위치 판정은 기존 경로를 그대로 쓴다** — 새 네트워크 호출·재시도·타이머를 추가하지 마라(ADR-008/ADR-011).

3. env 기본값을 **config.json에 자동 저장하지 마라**(기본값은 매 부팅 env에서 온다 — 저장하면 env를 내려도 남는다). 실제 저장은 사용자가 `setup`에서 확정할 때만 일어난다(기존 동작).

## Acceptance Criteria

```bash
# Node만 필요 — 컨테이너에서 그대로 돈다
node --test test/client-server-target.test.js
npm test        # 신설 포함 전체 무회귀
npm run lint
```

## 검증 절차

1. 위 AC를 실행한다(컨테이너 실행 가능).
2. 아키텍처 체크리스트:
   - env 기본값이 `normalizeServerUrl`을 경유하는가(자격·미허용 스킴 거부)?
   - 저장된 serverUrl이 env보다 우선하는가?
   - 새 네트워크 호출·재시도·타이머·주기 프로브가 없는가(ADR-008/011)?
   - 세션·쿠키·토큰을 config·env·로그에 담지 않는가(비밀 필드 금지)?
3. step 4를 업데이트한다(completed→summary / error→error_message / blocked→blocked_reason).

## 금지사항

- env 기본값을 config.json에 자동 저장하지 마라. 이유: env를 내려도 옛 대상이 남아 재지정이 불가능해진다 — 기본값은 매 부팅 env에서 재계산한다.
- 정규화를 건너뛰지 마라. 이유: 자격 포함·미허용 스킴 배포값이 신뢰 경계 밖 파일/env로 새거나 조용히 접속불능을 만든다.
- 새 프로브·재시도·타이머를 추가하지 마라. 이유: ADR-008(주기 확인 금지)·ADR-011(접속형 셸) 위반.
- 서버(`server/**`·`server-spring/**`)·계약을 고치지 마라. 이유: 이 step은 클라이언트 셸 레이어 하나만 다룬다.
- 기존 테스트를 깨뜨리지 마라.
