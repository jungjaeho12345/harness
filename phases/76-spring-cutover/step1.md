# Step 1: adr-cutover-architecture

## 읽어야 할 파일

- `phases/76-spring-cutover/index.json` — `decisions` (1)(2)(5)(6)(7) · `open_questions` (1)(2)(3)(4)(7)(8) · `baseline`의 실측 (A)~(H)
- `docs/cutover-p3.md` §0 조사표 — **step0이 채운 값**(특히 5번 `RCV_SPOOL_DIR`, 1번 `PORT`, 3번 `SPA_DIR`)
- `docs/ADR.md` — **ADR-008**(파일 스풀 outbound · tick pull · 앱 내 타이머/egress 금지) · **ADR-009**(CSRF Origin allowlist) · **ADR-011**(Electron 접속형 셸) · **ADR-012**(데이터 폴더당 단일 인스턴스) · **ADR-013**(Spring 포팅 모듈) · **ADR-014**(egress 예외의 축) · **ADR-015**(SSE 와이어 지점) · **ADR-016**(MySQL 8.0 — 특히 트레이드오프 ⑦)
- `docs/porting-plan-cpp-spring.md` §7 P3 행(180행)·되돌림 지점(187행)·§10 열린 질문 2
- `client/lib/serverUrl.js`(`appUrl`·`healthUrl`·`normalizeServerUrl`) · `client/main.js` 295~310행 · `client/lib/clientConfig.js`
- `server/index.js` 1369~1389행(FTP watcher) · `server/ftpWatcher.js` 전문 · `src/db/instanceLock.js`
- `server-spring/src/test/java/harness/news/config/Adr008DisciplineTest.java` — 5군 Rule과 **예외 목록**(주기 실행 0 · 비동기 0 · 네트워크 2 · 파일 쓰기 2 · 외부 프로세스 0)

## 배경

이 phase의 코드는 전부 **한 묶음의 아키텍처 결정**에서 나온다. 그 결정을 코드보다 먼저 문서로 못 박지 않으면, 뒤 step들이 각자 다른 전제로 움직인다(73이 ADR-014를 step2의 선행 조건으로 둔 선례 · 74가 ADR-015를 step0에 둔 선례).

특히 셋은 **틀리면 되돌릴 수 없다**: ① SPA를 어디서 서빙하는가(고르는 순간 `web/**`·`client/**` 수정 여부가 갈린다) ② 병행 운영의 의미(고르는 순간 데이터 분기 위험의 크기가 갈린다) ③ FTP 수집을 어디에 두는가(고르는 순간 `Adr008DisciplineTest` 예외 목록을 여는지가 갈린다).

**이 step은 코드를 0줄 쓴다.** 산출물은 `docs/ADR.md`에 **순수 추가**되는 ADR-017 하나와 `docs/cutover-p3.md`의 §1이다.

## 작업

### A. ADR-017 신설 — `docs/ADR.md` 끝에 **순수 추가**

제목 형식은 기존 ADR과 같게 한다. 예:

> `### ADR-017: 서버 전환은 같은 host:port의 원자적 교체 — Spring이 SPA를 동일 출처로 서빙하고, Node는 코드로 남아 롤백 레버와 패리티 대조군을 겸한다`

본문은 기존 ADR과 같은 4문단 구조(**결정 / 이유 / 트레이드오프**)로 쓰고, **모든 근거에 실측 출처(파일·행)를 붙인다**. 결정에 반드시 담을 5항:

1. **SPA 동일 출처 서빙을 Spring으로 이식한다.** 근거: `client/main.js` 303행 `win.loadURL(appUrl(origin))` + `client/lib/serverUrl.js`의 `appUrl(origin) = ${origin}/` — **Electron 클라는 화면을 갖고 있지 않다**. `web/src/model/httpModel.js`는 `/api/...` 상대 경로만 쓰고 `web/src/app/routing.js`는 `.do` 7경로를 쓴다. 서빙 방식은 **리소스 핸들러**(73의 `/uploads/**` 선례 — `HandlerInventoryTest`가 못 보는 자리에 **정직하게** 둔다)이고, `SPA_DIR` 미설정이 기본(=비활성)이며, **파일시스템 경로 방식**이다(jar 임베드 금지 — open_questions (7)).
2. **전환은 원자적이고 병행 쓰기는 금지한다 — 그리고 이 전환은 오늘 있는 기계적 보호를 _제거_ 한다(회귀로 명문화하라).** 같은 host:port(운영 실측 `PORT=3001`)를 쓰므로 두 프로세스가 동시에 뜰 수 없고, 그 포트 배타가 컷오버 순간의 상호배제다. **그러나 그것으로 ADR-012를 대체했다고 적지 마라 — 두 보호의 범위가 다르다.** 실측(`src/db/instanceLock.js` **1~6행**): Node의 잠금은 **포트가 아니라 `DATA_DIR`(=같은 `news.db`) 범위**이고 근거는 「세션 스토어(ADR-004)·SSE(ADR-005)·**배부 스풀 기록(ADR-008)** 이 전부 프로세스 로컬이라 둘이 뜨면 split-brain」이다. 즉 Node에서는 **포트를 달리해도** 같은 데이터 폴더로 두 번째 인스턴스가 뜨지 못했다(전용 파일 `<dataDir>/instance-lock.db`의 `BEGIN EXCLUSIVE`를 프로세스 수명 동안 유지). Spring에는 그 잠금이 **없다** ⇒ **다른 포트로 Spring을 2개 띄우면 같은 MySQL·같은 `uploads`·같은 `DIST_SPOOL_DIR`에 둘이 붙고, tick이 양쪽에서 돌면 중복 배부가 난다.** ADR-017은 이것을 **"이 전환이 잃는 것"으로 명시**하고, 그 크기를 **step7이 실측**하며(두 인스턴스에 tick을 걸어 중복 스풀이 실제로 생기는지), 그동안의 방어는 **절차**(런북 §0 낭독 · §10 분기 · '서로 다른 포트로 두 서버를 동시에 띄우는 구성 금지')다. **자동 게이트가 있는 척하지 마라.** 대안(MySQL `GET_LOCK`)은 open_questions (9)에 기본 결정("이 phase는 넣지 않는다")과 근거 셋과 함께 있다 — ADR 본문에 그 링크를 걸어라.
3. **Node 서버 코드는 삭제하지 않는다.** 은퇴 = 운영 중단. 삭제하면 (i) 로드맵 187행의 되돌림 지점 (ii) `--parity`의 **대조군** (iii) `test/**` 1328건의 기반을 함께 잃는다. 삭제 시점의 전제 조건 목록은 step10의 런북이 소유한다.
4. **FTP 스풀 수집은 앱 밖 스위퍼가 받는다.** 근거: `server/index.js` 1369~1389행의 watcher가 부르는 진입점은 `controllers.collection.receive(sourceId, payload)`이고 이는 HTTP 라우트 `POST /api/collection/receive`와 **같은 서비스 진입점**이다. Spring에 `WatchService`를 넣으면 `Adr008DisciplineTest`의 '주기 실행'(예외 0)·'비동기·재시도'(예외 0) 두 군을 열어야 하고, 그것은 ADR-008의 '앱은 스스로 깨어나지 않는다'를 뒤집는다. 스위퍼는 **배부 tick과 대칭**이다. **step0 조사표 5번이 '미사용'이면 이 항목의 발효는 컷오버가 아니라 Node 은퇴의 전제로 내려간다** — 그 분기를 ADR 본문에 조건절로 적어라.
5. **업로드 디렉토리는 두 서버가 공유하고, `DATA_DIR`은 컷오버 후에도 같은 값을 쓴다.** 근거: DB에는 파일명만 있고 파일은 디스크에 있다 — 공유하지 않으면 롤백 후 이미지가 전부 깨진다. **공유가 안전한 근거도 함께 적어라(② 검토 반영)**: 저장명은 **서버가 발급하는 32-hex**이고 생성은 **`CREATE_NEW`**(phase 73 · `UploadNames`·`UploadStore`)라 **두 서버가 같은 폴더에 써도 이름이 충돌하지 않으며 기존 파일을 덮어쓰지 않는다**. 즉 공유의 위험은 '충돌'이 아니라 '고아'뿐이다 — 대가는 **롤백 시 Spring이 올린 파일이 참조 없는 고아로 남는 것**(무해하되 디스크에 남는다)이며 그 사실을 명시한다. **이 근거를 실측으로 재확인하라**(32-hex 발급 지점과 `CREATE_NEW` 사용을 코드에서 직접 확인 — 추정으로 적지 마라).

**트레이드오프 문단**에 반드시 담을 것:

- **이 전환은 ADR-012의 보호를 잃는다**(위 결정 2). 포트 배타에 기대는 상호배제는 **다른 포트로 띄우면 즉시 무효**이고, Node에는 있던 `DATA_DIR` 범위 잠금이 Spring에는 없다. 잃는 것의 구체적 형태(중복 tick → 중복 스풀)와 그 실측 위치(step7)를 적어라.
- **SPA 문서에 CSP를 붙이지만 `/api` 응답과 나머지 보안 헤더 10종은 여전히 없다**(excluded (d)의 분할 재판정). 반쯤 붙은 상태라는 사실과, 그 경계를 잠그는 테스트가 있다는 사실을 함께 적어라.
- SPA 서빙을 붙이면 `RequestLogFilter`가 정적 요청까지 로그 링 버퍼에 싣는다 — **Node도 같은지 실측해 적어라**(다르면 divergence로 기록. 추측 금지).
- 폴백 규칙(`Accept: text/html` 게이트)은 **Node의 규칙을 그대로 베낀 것**이고, Node가 그 규칙을 고르며 감수한 함정(확장자 판정 기각 등)도 함께 승계한다.
- FTP 수집을 앱 밖으로 옮기면 **파일 → HTTP 왕복이 한 단계 늘고**, 스위퍼가 죽으면 아무도 모른다(Node watcher는 서버와 생명주기를 공유했다). 감시 책임이 운영으로 넘어간다.
- 이 phase는 `helmet` 등가 보안 헤더 중 **10종과 `/api`·`/uploads` 응답의 CSP를 또 미룬다**(excluded (d) ② — **3연속 이월**임을 명시. CSP 1종은 SPA 응답에 한해 **이 phase가 붙인다**. 위 40행 항목과 같은 수치·같은 표현을 쓰고, step10 forward_notes와도 어긋나지 않게 하라 — 세 자리의 숫자가 다르면 그중 둘은 거짓말이다).

**ADR-007·ADR-008·ADR-012·ADR-013·ADR-016의 본문을 고치지 마라.** 각 문장은 그 시점의 결정·실측 기록이고 소급 수정은 이력을 오염시킨다(ADR-014가 확립한 규율). ADR-017은 **적용 범위를 새로 선언**할 뿐이다.

### B. `docs/cutover-p3.md` §1 — 결정 요약표

운영자가 읽을 형태로 5결정을 1행씩 요약하고, 각 행에 **"이 결정이 깨지면 무엇이 무너지는가"** 를 적는다. ADR 전문 링크를 건다.

### C. open_questions 갱신

step0 조사표가 답한 질문((3) FTP 사용 여부 등)은 `phases/76-spring-cutover/index.json`의 `open_questions`에서 **"해소 — 답: …"** 으로 갱신한다(지우지 마라 — 무엇이 왜 열려 있었는지가 기록이다).

## Acceptance Criteria

```bash
# 1) ADR 추가가 순수 추가인가 — 삭제 0행
git diff -U0 -- docs/ADR.md | grep -c '^-[^-]'          # 0 이어야 한다

# 2) 코드가 0줄 바뀌었다
git diff --stat -- server-spring tools scripts src server web client test contract   # 무출력

# 3) 회귀 없음(코드 0줄이므로 구조적이지만, 실행해서 확인한다)
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
node scripts/spring-contract.mjs --parity
node scripts/spring-contract.mjs --db mysql --parity
```

- 1번이 **0**이어야 한다. `core.autocrlf` 때문에 `git show` 접두사 비교는 쓸 수 없다 — `git diff -U0`의 삭제행 계수로 판정하라(74 선례).
- 3번의 두 `--parity`가 각각 **313관측 diffs 0**.
- ADR-017 본문의 **모든 실측 주장에 파일·행 출처**가 붙어 있다.
- **변이 전건 결과표**: 이 step은 게이트를 만들지 않는다 → "변이 0건" 명시 기록. 다만 **ADR 순수 추가 판정의 비공허성**은 실증하라: ADR 기존 문단 한 줄을 임시로 지워 위 커맨드 1이 0이 아닌 값을 내는지 보고 **원복**한다(기대 red / 실제 ? / 원복 확인).

## 검증 절차

1. ADR-017을 쓴 뒤 **다른 사람이 읽는다고 가정하고** 5결정 각각에 "왜 다른 선택지가 아닌가"가 있는지 확인한다. 없으면 그 결정은 추측이다.
2. 실측 주장(예: "Spring에 단일 인스턴스 잠금이 없다")을 **그 자리에서 다시 재라**: `grep -rn "InstanceLock\|EXCLUSIVE" server-spring/src/main/java` 가 0건인지.
3. `docs/cutover-p3.md` §1 표의 각 행을 뒤 step 번호와 연결한다(어느 step이 그 결정을 실행하는가).

## 되돌림 절차

문서 2개(ADR-017 추가분 · `cutover-p3.md` §1)만 되돌리면 된다. 코드·운영 변화 0. ADR을 되돌릴 때는 **파일 전체를 이전 버전으로 덮지 말고** 추가한 절만 지워라(다른 세션이 같은 파일을 건드릴 수 있다).

## 금지사항

- **ADR-007·008·012·013·016의 본문을 고치지 마라.** 이유: 소급 수정은 이력을 오염시킨다. 범위 선언은 새 ADR이 한다(ADR-014 선례).
- **코드를 한 줄도 쓰지 마라.** 이유: 결정 게이트와 구현 게이트를 섞으면 검토가 무력해진다.
- **`Adr008DisciplineTest`의 예외 목록을 넓히는 결정을 쓰지 마라.** 이유: 그것은 별도 ADR과 별도 리뷰가 필요한 아키텍처 변경이고, 이 phase의 설계는 그것을 요구하지 않는다(스위퍼는 앱 밖이다).
- **"성능이 좋아진다"·"더 현대적이다" 같은 근거를 쓰지 마라.** 이유: 이 리포의 ADR은 전부 실측 또는 구조적 논증에 서 있다.
- **조사표가 미상인 항목에 결정을 박지 마라.** 이유: open_questions (3)이 열려 있으면 결정 4는 조건절로만 쓸 수 있다.
