# Step 4: logs-page — 실시간 로그 뷰어 페이지(라우팅 + App + TopBar + 컨트롤러 + 뷰 + css)

## 배경 / 요구사항

Step 3에서 Model 계약에 두 키가 추가됐다:
- `subscribeLogs(onLog, onStatus)` → `{ connected, unsubscribe }`. `onLog(record)`로 record(`{ seq, ts, level, message, line }`)를 접속 replay + 실시간으로 받고, `onStatus(bool)`로 연결 상태를 받는다.
- `getLogsDigest()` → `{ ok, items }`(24시간 창).

이 step은 **Z(관리자) 전용 실시간 로그 뷰어 페이지 `logs.do`**를 만든다(LOGS.md — "웹 페이지에서 실시간으로 발생하는 LOG를 확인"). 이중 강제:
1. **웹 라우트 가드**: `Z_ONLY_ROUTES`에 `logs.do` 추가(비-Z는 list.do로 리다이렉트).
2. **서버 게이트**: step2에서 이미 두 엔드포인트가 role Z를 강제한다(라우트 가드는 UX, 실제 강제는 서버 — ADR-004).

프론트 MVC(ADR-003): **View(순수 컴포넌트) ← Controller(훅) ← Model(계약)**. View/Controller는 transport를 모른다(EventSource는 httpModel 안에만).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC, 명령어(`npm run test:web`, `npm run build`, `npm run lint`).
- `/docs/ADR.md` — ADR-003(View←Controller←Model), ADR-004(라우트 가드는 UX·실제 Z 강제는 서버), ADR-005/007(SSE 자동 재연결).
- `/docs/LOGS.md`, `/docs/UI_GUIDE.md` — 실시간 로그 요구·디자인 토큰(주 블루 `--yh-blue`, 상태 배지 색, AI 슬롭 안티패턴, radius 2/4/6px, yh- prefix BEM).
- `web/src/app/routing.js` — **결선 지점(실측)**: `ROUTES`(L7, frozen)·`Z_ONLY_ROUTES`(L8, frozen)에 `'logs.do'` 추가. `resolveRoute`(L27~33)가 Z_ONLY_ROUTES를 비-Z에서 list.do로 보낸다(자동 적용).
- `web/src/app/routing.test.js` — 가드 테스트 컨벤션(`Z_ONLY_ROUTES`를 루프로 검증 — logs.do가 자동 커버됨). `ROUTES`에 대한 명시 단언 추가.
- `web/src/app/App.jsx` — **결선 지점(실측)**: `RouteView`(L17~30) 분기에 `else if (route === 'logs.do') page = <LogsPage />;` 추가 + import. TopBar는 login.do 외 공통 렌더(L26).
- `web/src/app/App.test.jsx` — 라우트 렌더/가드 테스트 컨벤션(`modelReturning(restore)`로 identity 주입, `data-route` 단언, Z 전용 가드 — `go('/userMgmt.do')` 선례).
- `web/src/view/TopBar.jsx` — **결선 지점(실측)**: `isZ &&` 블록(L27~32)의 '수신설정 관리'·'사용자 관리' 버튼 옆에 로그 뷰어 nav 버튼 추가. 데이터/네비게이션은 컨텍스트 경유(`navigate('logs.do')`).
- `web/src/view/RcvMgmtPage.jsx` + `web/src/controller/useRcvMgmtController.js` — **가장 단순한 페이지/컨트롤러 템플릿**: View는 훅만 소비, 훅은 `useAppContext().model`만 호출. `.yh-page`/`.yh-card` 골격.
- `web/src/controller/useViewController.js` L104~110 — **SSE 구독 컨트롤러 선례**: `useEffect`에서 `setLive(false)` → `model.subscribe(..., setLive)` → cleanup `sub.unsubscribe()`. live state. **이 패턴을 subscribeLogs로 본뜬다.**
- `web/src/view/ListPage.jsx` L168~175 — **연결 상태 UI 선례**: `className={\`yh-live ${live ? 'yh-live--on' : ''}\`}` + `data-testid="live-status"` + dot. **재사용**한다.
- `web/src/styles/yonhap.css` — yh- prefix BEM, 페이지 골격, 신규 블록은 **파일 끝에 append**하는 관행. `--yh-*` 토큰.

## 작업

TDD로 진행한다(vitest). **테스트를 먼저 작성**하고 통과하는 결선을 만든다. 이 step은 프론트 "Z 전용 페이지 추가" 수직 슬라이스다(라우팅→App→TopBar→컨트롤러→뷰→css). 백엔드/model은 건드리지 않는다.

### 1. 라우팅 — `web/src/app/routing.js`

- `ROUTES`에 `'logs.do'` 추가(frozen 배열에 원소 추가).
- `Z_ONLY_ROUTES`에 `'logs.do'` 추가. → `resolveRoute`가 비-Z를 자동으로 list.do로 보낸다(로직 추가 불필요).

### 2. App 라우트 스위치 — `web/src/app/App.jsx`

- `import { LogsPage } from '../view/LogsPage.jsx';` 추가.
- `RouteView`에 `else if (route === 'logs.do') page = <LogsPage />;` 분기 추가.

### 3. TopBar nav — `web/src/view/TopBar.jsx`

- `isZ &&` 블록 안에 로그 뷰어 진입 버튼 추가(라벨 예: `실시간 로그`):
  ```jsx
  <button type="button" className="yh-btn" onClick={() => navigate('logs.do')}>실시간 로그</button>
  ```
  - **비-Z에게는 노출하지 않는다**(기존 isZ 조건 안에).

### 4. 컨트롤러 — `web/src/controller/useLogsController.js` (신규)

- `useAppContext().model`만 호출한다(transport 직접 호출 금지). `useViewController`의 구독 패턴을 본뜬다:
  ```js
  const MAX_LINES = 2000; // 클라이언트 메모리 캡(링) — 무한 append 금지.
  export function useLogsController() {
    const { model } = useAppContext();
    const [lines, setLines] = useState([]);   // record[] (최신이 뒤)
    const [live, setLive] = useState(false);
    const maxSeqRef = useRef(-Infinity);      // 재연결 replay 중복 제거(step2 replay + step0 seq 단조성) — ref라 effect 재실행에도 유지
    useEffect(() => {
      setLive(false);
      const sub = model.subscribeLogs((record) => {
        // dedup 판정은 setState 업데이터 밖에서 — 업데이터는 순수하게 유지(StrictMode 이중 호출 시 record 유실 방지).
        if (record.seq <= maxSeqRef.current) return;   // 이미 본 seq(재연결 replay) → 무시
        maxSeqRef.current = record.seq;
        setLines((prev) => {
          const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev;
          return [...next, record];
        });
      }, setLive);
      return () => { setLive(false); sub.unsubscribe(); };
    }, [model]);
    return { lines, live };
  }
  ```
  - **클라이언트 메모리 캡 필수**: `lines`가 `MAX_LINES`를 넘으면 오래된 것부터 버린다(링). 무한 append 금지.
  - **재연결 중복 제거**: record `seq`(step0에서 단조 증가·step2가 접속마다 replay)를 이용해 이미 본 seq는 무시한다. Last-Event-ID 프로토콜은 쓰지 않는다(과설계 — seq 비교로 충분).
  - **dedup 상태는 `useRef`로**: maxSeq를 setState 업데이터 안에서 변이하지 마라. 이유: 비순수 업데이터가 되어 React StrictMode(이중 호출) 도입 시 정상 record가 중복으로 오인·유실된다. 판정과 ref 갱신은 업데이터 밖에서 한다(위 스니펫).
  - **서버 재시작 시나리오(참고 논거)**: 재시작 시 seq는 1부터 리셋되지만 세션도 in-memory라 재연결이 401로 끝나(fail-closed) stale maxSeq로 새 로그가 무시되는 문제는 현재 구조상 발생하지 않는다. 향후 세션을 영속화하면 ready 이벤트에 서버 epoch를 실어 클라 dedup을 리셋하는 보강이 필요하다(이 phase 범위 밖 — 회귀 방지를 위해 기록).
  - 다이제스트(`getLogsDigest`)는 실시간 뷰어의 필수 요소가 아니다 — 이 컨트롤러에 넣지 않는다(운영 루틴 pull 전용). 추가하려면 별도 phase.

### 5. 뷰 — `web/src/view/LogsPage.jsx` (신규)

- `.yh-page` + `.yh-card` 골격. `useLogsController()`만 소비(순수 뷰).
- **연결 상태**: ListPage L168~175의 `yh-live`/`yh-live--on`/`data-testid="live-status"` 패턴 재사용(`live` 반영).
- **로그 목록**: 스크롤 가능한 영역(`data-testid="log-view"`)에 `lines`를 렌더. 각 라인은 `record.seq`를 key로, `record.line`(이미 `[YYYY-MM-DD HH:MM:SS] [LEVEL] 메시지` 포맷) 텍스트를 표시. 레벨별 클래스(예: `yh-log__line yh-log__line--error`)로 색 구분.
- **자동 스크롤**: `useRef` + `useEffect([lines])`로 새 로그 도착 시 스크롤 컨테이너를 맨 아래로(`el.scrollTop = el.scrollHeight`).
- 빈 상태: 로그가 없으면 "로그 없음/대기 중" 안내.
- 로그 라인은 등폭 폰트 권장(가독성) — 스타일에서 지정.

### 6. 스타일 — `web/src/styles/yonhap.css` (파일 끝 append)

- `.yh-logs`(페이지/카드 보조), 스크롤 컨테이너, `.yh-log__line`과 레벨 변형(`--debug/--info/--warn/--error`) 색을 `--yh-*` 토큰으로:
  - ERROR = `--yh-red`(포인트 레드), WARN = 앰버(`#d97706`, 상태 배지 참고), INFO = `--yh-ink`, DEBUG = `--yh-gray-mid`.
  - 등폭 폰트, 좁은 행간(신문형 밀도), 얇은 구분선(`--yh-gray-line`).
- **UI_GUIDE.md 안티패턴 금지**: glass blur·gradient text·글로우 애니메이션·보라/인디고·균일한 큰 rounded 금지. radius는 2/4/6px, transition은 `--yh-transition` 수준만.

### 7. 테스트 (먼저 작성)

- **routing.test.js**: `ROUTES`가 `'logs.do'`를 포함하고, `Z_ONLY_ROUTES` 루프 단언이 `logs.do`를 포함(비-Z → list.do, Z → logs.do)함을 확인(기존 루프가 자동 커버 — `ROUTES` 명시 단언 추가).
- **App.test.jsx**: Z 사용자가 `/logs.do`에서 `LogsPage`(`data-route="logs.do"`) 렌더. 비-Z(R) 사용자가 `/logs.do` 접근 시 `list.do`로 가드됨(userMgmt 가드 테스트 패턴 재사용).
- **TopBar**(App.test.jsx 또는 신규 TopBar 테스트): Z에게 `실시간 로그` 버튼이 보이고, 비-Z에게는 안 보임(기존 '수신설정 관리' 노출 패턴과 동일). 현재 TopBar 전용 테스트 파일이 없으면 App.test.jsx에 렌더 단언으로 추가하거나 `web/src/view/TopBar.test.jsx`를 신규 작성.
- **LogsPage.test.jsx**(신규): `createFakeModel({ logs: [record...] })`를 `AppContext`로 주입해 렌더 → 시드 로그 라인이 표시(replay). `subscribeLogs`가 `onStatus(true)`를 부르므로 `live-status`가 연결됨 상태. **(필수)** `MAX_LINES` 링 캡: MAX_LINES를 초과하는 시드 replay 시 lines가 MAX_LINES로 잘리고 오래된 라인부터 버려짐을 단언(테스트 용이성을 위해 MAX_LINES를 export해 참조하거나, 초과분 시드로 잘림만 단언해도 좋다 — 재량). **(필수)** seq 중복 제거: 같은 seq record를 중복 시드해도 한 번만 렌더됨을 단언 — fakeModel replay를 활용.
  - 렌더 하네스는 App.test.jsx의 `AppContext.Provider`/`render` 패턴을 따르되, LogsPage가 `useAppContext().model`을 쓰므로 context에 model(+ identity)을 제공한다.

## Acceptance Criteria

```bash
npm run test:web      # vitest — 라우팅/App/TopBar/LogsPage 신규 단언 + 전체 회귀
npm run build         # Vite 프로덕션 빌드
npm run lint          # ESLint
```

기대 단언(요약): `logs.do`가 ROUTES·Z_ONLY_ROUTES에 있고 비-Z는 list.do로 가드·Z는 logs.do 렌더·TopBar 로그 버튼이 Z에게만 노출·LogsPage가 스트림 record를 라인으로 표시(자동 스크롤·클라 메모리 캡·seq 중복 제거)·연결 상태 표시·transport는 model 뒤에만(EventSource 직접 호출 없음).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: `logs.do`가 Z_ONLY_ROUTES에 있음(라우트 가드)·서버 Z 게이트 이중 강제(step2)·View는 useLogsController만 소비(순수)·Controller는 model.subscribeLogs만 호출(EventSource 직접 호출 없음, ADR-003)·useEffect cleanup에서 unsubscribe·클라 메모리 캡(MAX_LINES 링)·seq 중복 제거·css는 yonhap.css 끝 append + UI_GUIDE 토큰/안티패턴 준수.
3. 결과에 따라 `phases/26-log-viewer/index.json`의 step 4를 갱신(completed+summary / error / blocked). summary에 신규 파일(LogsPage.jsx·useLogsController.js)·routing/App/TopBar 결선·MAX_LINES 캡을 남긴다.

## 금지사항

- `Z_ONLY_ROUTES`에서 `logs.do`를 빼거나 라우트 가드만 믿고 서버 게이트를 약화(우회)하지 마라. 이유: 라우트 가드는 UX일 뿐 — 실제 Z 강제는 서버(ADR-004). 둘 다 유지해 이중 강제.
- `useLogsController`/`LogsPage`에서 `EventSource`/`fetch`를 직접 호출하지 마라. 이유: transport는 httpModel(model) 뒤에만(ADR-003) — View/Controller는 transport 비의존.
- 로그 `lines` state에 상한 없이 무한 append하지 마라. 이유: 장시간 켜두면 브라우저 메모리 폭증 — `MAX_LINES` 링 캡 필수.
- 재연결 시 replay를 중복 누적하지 마라. 이유: 서버가 접속마다 버퍼를 다시 보낸다(step2) — record `seq`로 이미 본 항목을 거른다.
- `useEffect` cleanup에서 `sub.unsubscribe()`를 빠뜨리지 마라. 이유: 페이지 이탈/언마운트 시 EventSource 누수·좀비 구독.
- 새 로그 record의 텍스트를 클라이언트가 재포맷하지 마라. 이유: 포맷 단일 출처는 서버 logService(`record.line`) — 클라는 표시만(레벨 색 구분은 `record.level` 기준 클래스만).
- UI_GUIDE 안티패턴(glass blur/gradient text/글로우/보라·인디고/균일한 큰 rounded)을 쓰지 마라. 이유: 디자인 규율 위반.
- `server/`·`src/`·model 계약(contract/httpModel/fakeModel)을 이 step에서 수정하지 마라. 이유: 이 step은 프론트 페이지 결선만 — 서버는 step2, model은 step3 완료.
- 새 npm 패키지를 추가하지 마라. 이유: zero-dep 확정.
- 기존 테스트를 깨뜨리지 마라(특히 routing.test.js의 Z_ONLY_ROUTES 루프·App.test.jsx 가드).
