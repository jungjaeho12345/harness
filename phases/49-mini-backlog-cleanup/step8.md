# Step 8: mgmt-error-feedback

## 목표

**관리 화면 3종(배부 대상/수신 설정/사용자)에서 실패가 무음으로 사라지는 문제**를 없앤다.

현재:
- `RcvMgmtPage`·`UserMgmtPage`는 **에러 표시가 아예 없다**. 생성/수정/삭제가 `{ ok:false, reason }`으로 거부돼도 폼이 초기화되고 아무 메시지도 뜨지 않는다(사용자는 성공한 줄 안다).
- 세 화면 모두 **목록 조회(refresh) 실패**를 무시한다 — 권한 없음·서버 장애·네트워크 단절 시 그냥 "빈 표"로 보인다.
- `DistMgmtPage`만 쓰기 실패 메시지를 갖고 있다(`data-testid="dist-error"`).

직전 step에서 `httpModel.request`가 네트워크/비JSON 실패도 `{ ok:false, reason:'network-error' | 'invalid-response' }`로 정규화하므로, **이제 화면은 모든 실패를 같은 방식으로 표시할 수 있다.**

이 step은 **View 3파일만** 수정한다 — 컨트롤러/Model/백엔드 무접촉(컨트롤러 3종은 이미 응답 `r`을 그대로 반환한다).

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`(프론트 MVC), `docs/ADR.md` **ADR-004**(인가 강제는 서버 — 프론트 표시는 안내일 뿐)·**ADR-008**(배부 대상은 삭제 없이 비활성), `docs/UI_GUIDE.md`(있으면 알림/문구 톤), `docs/RCV.md`(수신 설정 화면 사양).
- `web/src/view/DistMgmtPage.jsx` — **전체(모범 패턴)**. `REASON_MESSAGE` 맵 + `reasonMessage(reason)` 폴백(L15~28), `const [error, setError] = useState('')`, `useEffect(() => { refresh(); }, [refresh])`(L37), `onSubmit`에서 `r.ok`면 `reset()` 아니면 `setError(reasonMessage(r && r.reason))`(L52~58), `{error && <p role="alert" data-testid="dist-error">{error}</p>}`(L103).
- `web/src/view/RcvMgmtPage.jsx` — **전체**. `onCreate`(L21~25)가 `await createConfig(form)` 결과를 **보지 않고** `setForm(BLANK)`한다. 삭제 버튼(L100)도 결과를 보지 않는다.
- `web/src/view/UserMgmtPage.jsx` — **전체**. `onSubmit`(L31~41)이 결과를 보지 않고 `setForm(BLANK); setEditing(false)`한다. **비밀번호는 어떤 응답에도 없다 — 화면·메시지에 절대 노출 금지**(파일 상단 CRITICAL).
- `web/src/controller/useDistMgmtController.js`·`useRcvMgmtController.js`·`useUserMgmtController.js` — **읽기만(수정 금지)**. 셋 다 `refresh`/`create`/`update`/`delete`가 서버 응답 `r`을 그대로 반환하고, 쓰기 후 `await refresh()`를 부른다.
- `web/src/model/httpModel.js` — 직전 step에서 추가된 정규화 토큰 `'network-error'`·`'invalid-response'`(문자열 값으로만 참조한다 — import 금지).
- 사유 토큰 출처(읽고 목록을 확정하라):
  - `server/index.js`의 `STATUS_BY_REASON`(L84~104)과 전역 에러 핸들러(`{ ok:false, reason:'internal-error' }`, L838~841).
  - `src/services/receiverConfigService.js`(게이트 사유만), `src/services/userService.js`, `src/services/authorization.js`(`unauthenticated`·`forbidden`·`unknown-capability` 등).
- 테스트: `web/src/view/DistMgmtPage.test.jsx`, `RcvMgmtPage.test.jsx`, `UserMgmtPage.test.jsx`(기존 스타일: fakeModel 주입 + `screen.getBy*` 단언).

## 작업

### 공통 규약(세 화면 동일하게)

1. **에러 영역**: `{error && <p role="alert" data-testid="{prefix}-error">{error}</p>}` — prefix는 `dist`(기존)·`rcv`·`user`. 폼 안, 제출 버튼 아래(dist와 같은 위치)에 둔다.
2. **사유 → 문구 맵**: 각 파일에 `REASON_MESSAGE` 상수 + `reasonMessage(reason)` 폴백 함수(`요청을 처리하지 못했습니다 (${reason}).`)를 둔다. dist와 **동형 구조**로 만들되, 화면별 사유는 그 화면 것만 담는다(공용 모듈로 추출하지 마라 — 화면마다 문구가 다르고 3개뿐이다).
3. **최소 공통 사유**(세 화면 공통으로 반드시 포함):
   - `unauthenticated` → 로그인 안내
   - `forbidden` → 관리자(Z) 전용 안내
   - `internal-error` → 서버 오류 안내
   - `network-error` → "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요."
   - `invalid-response` → "서버 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."
   - 그 밖에 각 화면 서비스가 실제로 돌려주는 사유(위 "사유 토큰 출처"를 읽고 확정 — 지어내지 마라).
4. **조회(refresh) 실패 표시**: 화면 진입 `useEffect`에서 `refresh()`의 반환을 확인해 실패면 에러 영역에 표시한다. 반환이 없거나 `ok !== true`면 실패로 본다.
   - `useEffect` 안에서 async를 쓸 때 **정리(cleanup) 후 setState 금지** — 언마운트 이후 상태 갱신이 나지 않게 처리하라(기존 테스트 경고 발생 금지).
5. **쓰기 실패 시 폼 유지**: 실패하면 입력값을 지우지 않는다(고쳐서 재제출할 수 있게 — dist의 기존 정책과 동일). 성공했을 때만 초기화한다.
6. **에러 표시/클리어 타이밍 — 사용자 트리거 조작의 "최종 응답"에서만 한다.**
   - **CRITICAL(구조 주의)**: 컨트롤러의 `createTarget`/`updateTarget`/`deactivateTarget`/`createConfig`/`deleteConfig`/`createUser`/`updateUser`는 **내부에서 `await refresh()`를 호출한 뒤** 원래 쓰기 응답 `r`을 반환한다. 즉 한 번의 버튼 클릭에 응답이 2개(쓰기 + 내부 재조회) 발생한다.
   - 따라서 **에러 판정은 뷰가 받은 최종 반환값(쓰기 응답)으로만** 한다. 내부 재조회 결과를 뷰가 따로 관찰해 에러를 덮어쓰거나 지우면, **쓰기 실패 메시지가 곧바로 사라지는** 회귀가 생긴다(아래 TDD 케이스 5가 잠근다).
   - 진입 시 조회(`useEffect`의 `refresh()`)만 "조회 실패" 메시지를 띄운다. 쓰기 핸들러 안에서 별도의 `refresh()`를 추가로 부르지 마라(컨트롤러가 이미 한다).
   - 클리어는 **성공한 조작의 응답에서만**(성공 시 `setError('')`) 하고, 수정 진입(`startEdit`)·폼 리셋 같은 사용자 조작에서도 지운다(dist의 기존 동작).

### 화면별

- **DistMgmtPage**: (a) `REASON_MESSAGE`에 `internal-error`/`network-error`/`invalid-response` 추가, (b) 목록 조회 실패 표시 추가. 나머지(폼/비활성/표) **불변**.
- **RcvMgmtPage**: 에러 state + 표시 영역 + 사유 맵 신설. `onCreate`는 성공일 때만 `setForm(BLANK)`, 실패면 메시지. 삭제 버튼도 결과를 받아 실패 시 메시지. 조회 실패 표시.
- **UserMgmtPage**: 위와 동형. 실패 시 `setForm(BLANK)`/`setEditing(false)`를 **하지 않는다**(수정 중 상태 유지). 성공 시에만 초기화.
  - **CRITICAL**: 에러 메시지에 `form.password`나 서버 응답의 임의 필드를 넣지 마라. 사유 토큰만 문구로 매핑한다.

## TDD — 테스트 먼저

각 `*MgmtPage.test.jsx`에 red→green으로 추가한다(fakeModel이 `{ ok:false, reason }`을 돌려주도록 주입).

1. **쓰기 실패 표시**: rcv 생성 실패(`{ ok:false, reason:'forbidden' }`) → `getByTestId('rcv-error')`에 권한 문구, **폼 입력값이 유지**된다.
2. **쓰기 실패 표시(user)**: 사용자 생성 실패 → `user-error` 표시 + 폼 유지 + `editing` 상태 유지(수정 경로).
3. **조회 실패 표시**: 세 화면 각각 진입 시 목록 조회가 `{ ok:false, reason:'network-error' }`를 주면 **에러 영역에 네트워크 문구가 뜬다**(단언은 에러 문구 표시에 한정한다 — 표의 내용은 이 step의 관심사가 아니다).
4. **성공 시 에러 없음/초기화**: 성공하면 에러 영역이 사라지고 폼이 초기화된다(기존 동작 회귀 가드).
5. **쓰기 실패 메시지가 내부 자동 재조회 후에도 남는다(타이밍 회귀 가드)**: 쓰기(`createConfig`/`createUser` 등)는 `{ ok:false, reason:'forbidden' }`, 그 직후 컨트롤러가 내부적으로 부르는 목록 조회는 `{ ok:true, items:[...] }`를 주도록 fakeModel을 구성한다 → 클릭 후 `findByTestId('{prefix}-error')`가 **계속 표시**돼야 한다(성공한 내부 재조회가 실패 메시지를 지우지 않는다).
6. **알 수 없는 사유 폴백**: 맵에 없는 사유(`'weird-reason'`)는 `요청을 처리하지 못했습니다 (weird-reason).` 형태로 표시된다.
7. **비밀번호 비노출(user)**: 실패 메시지·DOM 어디에도 입력한 비밀번호 문자열이 나타나지 않는다(`expect(container.textContent).not.toContain('secret-pw')`).
8. 기존 3개 화면 테스트 전량 green.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web        # 87 files, 실패 0 (기준선 1944 pass + 신규 케이스)
npm test                # 620/620 green — 백엔드 무접촉 증명(step0 이후 기준선)
```

`git diff --name-only`는 뷰 3파일 + 테스트 3파일(최대 6개)이어야 한다. `web/src/controller/`·`web/src/model/`·`src/`·`server/`가 포함되면 범위 위반이다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 접근성/일관성 확인: 세 화면의 에러 영역이 모두 `role="alert"`이고 testid 규칙(`{prefix}-error`)이 일관적인가.
3. 타이밍 확인: 쓰기 실패 메시지가 **컨트롤러 내부 재조회 성공 뒤에도 남는지**(TDD 케이스 5) 실제로 red→green을 거쳤는지 확인한다. 뷰가 조회 결과로 에러를 지우는 코드를 넣었다면 그 케이스가 red가 된다.
4. 아키텍처 체크리스트:
   - View만 수정했는가(컨트롤러/Model/서버 무접촉)?
   - 인가 판단을 프론트에서 하지 않았는가?(ADR-004 — 화면은 서버가 준 사유를 **표시만** 한다. `if (role !== 'Z')` 같은 분기를 새로 만들지 마라)
   - 사유 토큰을 지어내지 않고 서버/서비스 실제 값에서 확정했는가?
5. `phases/49-mini-backlog-cleanup/index.json`의 step8을 갱신한다(`completed` + `summary` 등).

## 금지사항

- 실패를 `window.alert`로 띄우지 마라. 이유: 세 화면의 기존 패턴은 인라인 `role="alert"` 영역이다(dist 선례) — 모달 alert는 테스트·UX가 갈라지고 연속 실패 시 사용자를 가둔다.
- 사유 문자열을 화면에 **원문 그대로** 노출하는 것 이상으로 서버 응답 필드를 렌더하지 마라(스택·경로·내부 메시지 금지). 이유: 서버는 내부 정보를 노출하지 않는 사유 토큰만 준다 — 다른 필드를 그리면 그 방어가 무의미해진다.
- 사용자 관리 화면에 비밀번호(입력값·응답값)를 표시·보관·로그하지 마라. 이유: "비밀번호는 어떤 응답에도 없다"가 이 화면의 CRITICAL 계약이다.
- 컨트롤러(`use*MgmtController.js`)를 수정하지 마라. 이유: 이미 응답을 그대로 반환한다 — 화면 표시 정책은 View 책임이다(파일 주석에 명시).
- `httpModel`/`contract.js`를 수정하지 마라. 이유: 직전 step에서 확정된 계약이다 — 여기서 또 바꾸면 두 step의 회귀 원인이 섞인다.
- 실패 시 **뷰에서 목록 state를 추가로 비우지 마라**(`setItems([])` 류를 새로 넣지 마라). 이유: 조회 실패는 "모른다"이지 "없다"가 아니다 — 메시지만 덧붙이는 편이 안전하다. (컨트롤러가 `(r && r.items) || []`로 이미 빈 배열 폴백을 하는 **기존 동작은 이 step의 범위 밖**이다 — 그것까지 바꾸려 들지 마라. TDD 케이스 3의 단언도 표 내용이 아니라 에러 문구 표시로 한정한다.)
- 재시도 버튼·자동 폴링을 새로 만들지 마라. 이유: 범위는 "실패를 알린다"이며, 자동 재요청은 중복 쓰기 위험과 부하를 만든다.
- 기존 테스트를 깨뜨리지 마라(기준: web 87 files / 1944 pass 이상, lint·build clean, 백엔드 620/620 green 유지).
