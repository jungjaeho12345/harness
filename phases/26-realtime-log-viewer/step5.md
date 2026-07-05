# Step 5: web-log-viewer — Controller 훅 + View 컴포넌트 + 라우트 배선(실시간 로그 표시)

## 배경 / 요구사항

`docs/LOGS.md`: "웹 페이지에서 실시간으로 발생하는 LOG를 확인할 수 있다." step4의 Model 계약(`subscribeLogs`/`queryLogDigest`)을 소비해 **실시간 로그 뷰어 페이지**를 만든다. 프론트 MVC(ADR-003): View(순수 컴포넌트) ← Controller(훅) ← Model(주입형 계약). 실시간 배선은 이미 httpModel(EventSource) 뒤에 격리돼 있으므로, 이 step은 그 계약만 사용한다. 테스트는 fakeModel 주입.

구성:
- **Controller 훅** `useLogViewController` — `model.subscribeLogs`로 구독, 최근 라인을 **경계 있는 in-memory 배열**로 유지(무한 증가 금지), 연결 상태(`live`) 보유, 언마운트 시 `unsubscribe`. (선택) `queryLogDigest`로 다이제스트 pull.
- **View** `LogViewerPage` — 순수 표시 컴포넌트(라인 목록·레벨 배지·연결 상태·빈 상태). 내부 transport 호출 없음(props/훅 경유).
- **라우트** `logs.do` — SPA 라우팅에 추가(로그인 세션 필요, TopBar 링크).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC, SSE 무효화→재조회 대비 **로그는 컨텐츠 push**(무효화 아님)라는 차이, 명령어(`npm run test:web`).
- `/docs/ADR.md` — ADR-003(View←Controller←Model·fakeModel 주입), ADR-005(EventSource 자동 재연결·연결 상태 표시).
- `/docs/UI_GUIDE.md` — yonhap.css 디자인 토큰(카드/표/배지/색·AI 슬롭 안티패턴 금지·상태 배지 색). 로그 레벨 배지는 절제된 색만(글로우/그라데이션 금지).
- `/docs/news.md` L34~42 — 페이지/`.do` 라우팅·정의되지 않은 경로는 login.do·상단 사용자 정보.
- `/home/user/harness/web/src/controller/useViewController.js` — **결선 지점**: L104~110 `model.subscribe(filter, () => refresh(), setLive)` 구독→언마운트 해제·`live` 상태 패턴. **이 패턴을 로그 구독에 응용**(단, 로그는 재조회가 아니라 수신 라인 append). `useAppContext()`로 `model`/`identity` 취득.
- `/home/user/harness/web/src/controller/useViewController.test.jsx` — 훅 테스트 컨벤션(fakeModel 주입·act·구독 흐름).
- `/home/user/harness/web/src/view/StatusBar.jsx` — 순수 표시 컴포넌트 컨벤션(props만·내부 effect 없음·`data-testid`). LogViewerPage 라인/배지 렌더 참고.
- `/home/user/harness/web/src/view/ListPage.jsx` — 페이지 컴포넌트가 컨트롤러 훅을 쓰는 구조(참고). (읽기만 — 수정하지 마라.)
- `/home/user/harness/web/src/view/statusBadge.js` — 상태 배지 매핑 순수 함수 컨벤션(레벨→클래스/색 매핑에 응용).
- `/home/user/harness/web/src/app/routing.js` — **결선 지점**: `ROUTES`(L7)에 `'logs.do'` 추가. `Z_ONLY_ROUTES`에는 **넣지 않는다**(any authenticated). `resolveRoute`(L27~33)가 로그인 세션 없으면 login.do로 보낸다(기존 로직 그대로 적용됨).
- `/home/user/harness/web/src/app/App.jsx` — **결선 지점**: `RouteView`(L17~30)에 `else if (route === 'logs.do') page = <LogViewerPage />;` + import 추가. TopBar는 login.do 외 공통 렌더됨.
- `/home/user/harness/web/src/view/TopBar.jsx` — **결선 지점**: 로그 뷰어로 가는 네비 링크 추가(기존 링크 패턴 따름·역할 무관 노출). (Z 전용 링크 패턴은 참고만.)
- `/home/user/harness/web/src/app/routing.test.js`, `web/src/app/App.test.jsx` — 라우팅/앱 셸 테스트 컨벤션.
- `/home/user/harness/web/src/styles/yonhap.css` — 디자인 토큰(신규 `.yh-log-*` 클래스는 토큰 사용, 안티패턴 금지).

## 작업

TDD로 진행한다(`vitest`, `npm run test:web`). **먼저 훅/뷰/라우팅 테스트를 작성**하고 통과 구현을 만든다. 이 step은 Controller+View+라우트 배선(프론트 표시 레이어)만 — Model 계약은 step4에서 이미 완료.

### 1. Controller — `web/src/controller/useLogViewController.js`

- `useLogViewController()`:
  - `const { model } = useAppContext();`
  - `const [lines, setLines] = useState([]);` — 수신 엔트리 배열. **상한(예: 최근 500개 — 상수)**을 두고 초과 시 앞을 버린다(무한 증가 금지 — 브라우저 메모리 보호).
  - `const [live, setLive] = useState(false);` — SSE 연결 상태.
  - `useEffect`로 `const sub = model.subscribeLogs((entry) => setLines((prev) => bounded(prev, entry)), setLive); return () => { setLive(false); sub.unsubscribe(); };` (deps: `[model]`).
  - (선택) `digest` 상태 + `loadDigest(date)` 콜백 → `model.queryLogDigest(date)`로 pull. 필수는 아니며 두면 읽기 전용.
  - `bounded(prev, entry)` 같은 append+상한 로직은 순수 헬퍼로 분리해 단위 테스트하면 좋다(재량).
  - 반환: `{ lines, live, /* digest, loadDigest */ }`.

### 2. View — `web/src/view/LogViewerPage.jsx`

- `LogViewerPage`는 `useLogViewController()`를 호출해 표시한다(ListPage 패턴). 렌더:
  - 연결 상태 표시(`live` → "연결됨/끊김" 배지, `data-testid` 부여).
  - 로그 라인 목록: 각 엔트리의 `line`(step0 포맷 문자열 `[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지`)을 **모노스페이스/표 형태**로 렌더. 레벨별 배지/색은 yonhap.css 토큰으로 절제(ERROR=레드 계열, WARN=앰버, INFO=회색 — UI_GUIDE 상태 배지 팔레트 재사용). 라인 텍스트는 그대로 표시(서버가 이미 포맷).
  - 빈 상태("아직 로그가 없습니다") 안내.
  - 신규 라인은 아래로 append(최신 하단) 또는 상단 — 재량이되 일관되게. 자동 스크롤은 선택(과하면 생략).
- **순수 표시 컴포넌트로 유지**: 내부에서 직접 `fetch`/`EventSource`를 부르지 마라(훅/모델 경유). XSS 방지: 라인은 React 텍스트 노드로 렌더(`dangerouslySetInnerHTML` 금지).

### 3. 라우트 배선

- `web/src/app/routing.js`: `ROUTES`에 `'logs.do'` 추가(`Z_ONLY_ROUTES` 제외). 비로그인은 기존 `resolveRoute`가 login.do로 보낸다.
- `web/src/app/App.jsx`: `RouteView`에 `logs.do → <LogViewerPage />` 분기 + import.
- `web/src/view/TopBar.jsx`: 로그 뷰어 네비 링크 추가(기존 링크 컨벤션·역할 무관 노출).

### 4. 스타일

- `web/src/styles/yonhap.css`에 `.yh-log-*`(목록/라인/레벨 배지/상태) 클래스를 **디자인 토큰**으로 추가한다. UI_GUIDE AI 슬롭 안티패턴(글로우·그라데이션·과한 radius·보라색) 금지. 모노스페이스 라인·얇은 구분선·절제된 배지 색.

### 5. 테스트 (먼저 작성)

- `useLogViewController` 훅 테스트(fakeModel 주입): 구독 시 `live=true`, fakeModel이 밀어넣은 라인이 `lines`에 쌓이고, 상한 초과 시 오래된 라인이 제거되며, 언마운트 시 `unsubscribe`가 호출된다.
- `LogViewerPage` 뷰 테스트: 주입 라인들이 `line` 문자열로 렌더되고, 레벨 배지/연결 상태가 표시되며, 빈 상태 안내가 나온다. `dangerouslySetInnerHTML` 미사용(텍스트 렌더).
- `routing.test.js`: `logs.do`가 `ROUTES`에 있고 `Z_ONLY_ROUTES`에 없으며, 비로그인 신원에서 `resolveRoute('logs.do', null) === 'login.do'`, 로그인 신원(R/D/Z)에서 `logs.do` 유지.
- `App.test.jsx`: `logs.do` 라우트가 `LogViewerPage`를 렌더한다(fakeModel 주입).

## Acceptance Criteria

```bash
npm run build && npm run lint && npm run test:web
```

기대 단언(요약):
- `useLogViewController`가 `subscribeLogs`로 구독해 라인을 상한 있게 누적하고 연결 상태를 반영하며 언마운트 시 해제한다.
- `LogViewerPage`가 실시간 라인(포맷 문자열)·레벨 배지·연결 상태·빈 상태를 순수 렌더한다(transport 직접 호출/`dangerouslySetInnerHTML` 없음).
- `logs.do` 라우트가 인증 세션에서 진입 가능하고 비로그인은 login.do로 리다이렉트된다.
- 기존 라우팅/앱 셸/뷰 테스트가 회귀 없이 통과한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: View는 순수(훅/모델 경유·직접 transport 없음)·Controller가 구독/해제/상한 관리·라인 상한(메모리 보호)·`dangerouslySetInnerHTML` 없음·라우트 세션 게이트(비로그인 login.do)·Z 전용 아님·yonhap.css 토큰/안티패턴 준수·MODEL 계약(step4)만 사용.
3. 결과에 따라 `phases/26-realtime-log-viewer/index.json`의 step 5를 갱신(completed+summary / error / blocked).

## 금지사항

- View 컴포넌트에서 직접 `fetch`/`EventSource`를 호출하지 마라. 이유: transport는 httpModel 뒤에만(ADR-003) — View는 훅/모델 경유.
- 로그 라인을 `dangerouslySetInnerHTML`로 렌더하지 마라. 이유: 로그 메시지는 임의 텍스트라 XSS 표면 — React 텍스트 노드로만 렌더.
- `lines` 배열을 상한 없이 무한 append하지 마라. 이유: 장시간 열어두면 브라우저 메모리가 폭증한다 — 최근 N개 상한.
- 언마운트 시 `unsubscribe`를 빠뜨리지 마라. 이유: EventSource 연결 누수(재연결 폭주).
- `logs.do`를 `Z_ONLY_ROUTES`에 넣지 마라. 이유: server(step1) 인증 경계와 정합(any authenticated) — 프론트 가드는 UX일 뿐 실제 강제는 서버.
- UI_GUIDE 안티패턴(글로우/그라데이션 텍스트/보라색/균일 큰 radius)을 쓰지 마라. 이유: 도구형 신문 UI 일관성.
- Model 계약(`subscribeLogs`/`queryLogDigest`)을 이 step에서 바꾸지 마라. 이유: step4에서 확정 — 여기선 소비만(레이어 분리).
- 기존 `subscribe`(무효화)·목록/작성 페이지 로직을 건드리지 마라. 이유: 로그 뷰어는 독립 페이지 — 회귀 표면 최소화.
