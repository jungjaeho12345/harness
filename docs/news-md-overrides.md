# news.md 오버라이드 대장 (news-md-overrides)

**구현이 `docs/news.md`를 덮어쓴 지점의 단일 목록.** 포팅 로드맵 P4~P7(C++/Qt 클라이언트)의 요구사항 정본으로 `news.md`를 쓰기 전에 반드시 이 문서를 함께 연다.

- **기준 커밋**: `b53c083` (feat-0-mvp)
- **조사일**: 2026-09-10
- **대상**: `docs/news.md` 302행 전부
- **결과**: 드리프트 **39건**(override 9 · partial 16 · silent-gap 14) + 확인 **5건**(no-conflict) = 표 **44행**
- **닫는 질문**: `docs/porting-plan-cpp-spring.md` §10 **Q7**(ContentsVO.md 부재) · **Q8**(ADR이 news.md를 덮어쓴 지점 목록)

---

## 1. 이 문서를 어떻게 쓰는가

`docs/news.md`는 **고객이 준 원본 스펙**이고 이 리포는 그 원문을 고치지 않는다. 그런데 76개 phase를 거치며 그 서술의 상당수가 ADR·동결 계약·실측으로 대체됐다. 그 목록이 없으면 포터는 이미 폐기된 문장을 요구사항으로 읽고 구현한다.

**사용법은 한 줄이다.**

> `news.md`를 위에서 아래로 읽다가 **§4 표에 있는 줄 번호를 만나면, `news.md`가 아니라 이 문서를 따른다.**

그래서 §4는 **news.md 줄 번호 오름차순**으로만 정렬돼 있다(분류별·중요도별 정렬이 아니다). 사람이 원문을 순서대로 읽으며 대조하는 것이 이 문서의 유일한 사용 방식이기 때문이다.

> **줄 번호 기준(중요)**: 이 문서의 모든 줄 번호는 **기준 커밋 `b53c083`의 `docs/news.md` 본문 기준**이며, 리포 전역의 `news.md N행` 인용(코드 주석·phase 문서 등 105건)과 같은 기준이다. 이 문서를 신설하면서 news.md 에 넣은 안내는 **1행(제목 줄)에 접어 넣어 줄이 하나도 밀리지 않는다** — 따라서 **현재 파일의 실제 위치가 곧 이 번호**이고, 리포 전역의 기존 인용도 그대로 유효하다. 각 항목은 **스펙 원문을 그대로 인용**하므로 번호가 흔들려도 문장으로 대조할 수 있다.

먼저 읽어야 할 것은 §3(심각도 high 요약)이다. 여기 13건은 "잘못 만들면 되돌리기 비싼" 축(보안 경계·저장소·동시성)에 몰려 있다.

### 조사 방법

1. **6구간 병렬 대조** — news.md 302행을 6구간으로 나눠 각 구간을 독립적으로 현재 코드·ADR·동결 계약과 대조했다.
2. **2중 검증** — 후보 39건 각각을 **2표씩(총 78표)** 재검증했다. **77표 유지**, 1표가 이견(L76 — §4 해당 항목에 이견 내용을 명시했다).
3. **인용 재확인** — 이 문서를 쓰면서 표의 `file:line` 인용을 **전건 직접 열어** 확인하고, news.md 줄 번호도 `sed`로 **전건 대조**했다. 결과와 정정 내역은 §6에 있다.

---

## 2. 분류 정의

| 분류 | 뜻 | 포터가 할 일 |
|---|---|---|
| `override` | 스펙과 **다르게** 구현하기로 결정했다. news.md 문장은 폐기됐다. | news.md를 버리고 이 문서를 따른다. |
| `partial` | 스펙이 **일부만** 참이다(브라우저는 되고 셸은 안 되는 식 · 값은 맞고 전달 수단이 바뀐 식). | 참인 부분과 아닌 부분을 구분해 읽는다. |
| `silent-gap` | news.md가 **침묵**하는데 구현이 정한 **하드 규칙**이 있다. | news.md에 없다고 자유롭게 설계하면 안 된다. 규칙을 가져와야 한다. |
| `no-conflict` | 포터가 의심할 만한 지점인데 **여전히 맞다**를 확인해 준 것. | 그대로 구현한다. 다시 조사하지 않아도 된다. |

심각도는 **틀리게 구현했을 때의 되돌림 비용**이다.

- `high` — 보안 경계 붕괴 · 데이터/저장소 축 · 동시성 계약. 틀리면 구조를 다시 짠다.
- `medium` — 기능이 실제 제품과 눈에 띄게 달라진다. 화면/흐름 단위 재작업.
- `low` — 국소 수정으로 흡수된다.

---

## 3. 먼저 읽을 것 — 심각도 high 13건

| news.md | 한 줄 요약 |
|---|---|
| [L6](#l6) | "NodeJS를 사용한다" — 현재 라이브는 Node이나, 전환 아키텍처의 서버는 **Spring Boot**(`server-spring/`)다. 정본은 동결 REST 계약. |
| [L8](#l8) | "DB는 SQLite" — 포팅 스택의 저장소는 **MySQL 8.0**으로 확정(ADR-016). Node=SQLite / Spring=MySQL 병존이 정상 상태. |
| [L21](#l21) | 사용자 **삭제 함수·DELETE 엔드포인트가 없다.** 삭제는 `active='N'` 비활성화뿐(DB 비파괴). |
| [L22](#l22) | 비밀번호는 **bcrypt** 비교이고, 여기에 **타이밍 균등화 + 5회 실패 15분 계정 잠금 + 비활성 거부**가 얹혀 있다. |
| [L68·70-71](#l68) | 송고/보류 버튼 매트릭스가 news.md 자체와 모순 — DPS 고침/포털고침에서는 **D만** 버튼을 받는다(R·Z는 없음). 그대로 만들면 권한 과다 부여 버그. |
| [L80](#l80) | SSE는 4종 이벤트별 부분갱신이 아니라 **행 데이터 없는 단일 무효화 신호 + 전체 재조회**다. `unauthorized` 프레임을 받으면 **재연결을 영구 중단**한다. |
| [L123-128](#l123) | 세션 신원은 로그인 시점 스냅샷이 아니라 **매 요청 User 행 재조회로 재도출**된다(캐시·TTL 없음). |
| [L131](#l131a) | 잠금 컬럼 중 `lockerSessionId`·`lockerClientId`는 **어떤 조회 응답에도 실리면 안 된다**(과거 권한 상승 취약점의 원인). |
| [L131-132·154](#l131b) | 편집 잠금의 보유자 신원은 **세션이 아니라 탭**(`x-edit-client` clientId)이다. 같은 사용자의 재로그인은 차단이 아니라 **takeover**다. |
| [L156-159](#l156) | **SQLite 저장 프로시저는 존재하지 않는다**(SQLite에 SP 기능 자체가 없다). 기사ID 규칙은 그대로지만 **앱 계층 함수**로 구현돼 있다. |
| [L164](#l164) | 툴바 15개 버튼 → 실제로는 **글씨체·글씨크기 2개**뿐이고 **기본 숨김**(우클릭 '툴바 보이기'로 토글). |
| [L174](#l174) | Alt+Y의 브라우저 맞춤법(spellcheck)은 **Electron 셸에서 무효**다(`spellcheck:false` 고정). Qt 네이티브 맞춤법을 붙이면 안 된다. |
| [L301](#l301) | CORS는 고정 단일 출처가 아니라 **`ALLOWED_ORIGINS` 런타임 허용목록**이고, 실제 방어선은 CORS가 아니라 **Origin/Referer 검증(ADR-009)** 이다. |

**여기에 §5의 Q7 항목(L254 `ContentsVO.md` 부재)을 함께 읽어라.** 심각도는 medium으로 판정했지만(이유는 §5), P4 착수의 선행 조건이다.

---

## 4. 본문 — news.md 줄 번호 오름차순

### 색인

| news.md | 분류 | 심각도 | 요약 |
|---|---|---|---|
| [6](#l6) | partial | high | 서버는 Node → 전환 대상은 Spring |
| [7](#l7) | partial | low | 서버는 MVC가 아니라 controllers→services→models→db |
| [8](#l8) | partial | high | DB는 SQLite → 포팅 스택은 MySQL 8.0 |
| [11-18](#l11) | no-conflict | low | 기사 조회 5종 필터·삭제=상태전이 — 그대로 맞다 |
| [17](#l17) | silent-gap | medium | 기사 수정에는 비관적 편집 잠금이 필수 전제 |
| [21](#l21) | override | high | 사용자 삭제 없음 — 비활성화만 |
| [22](#l22) | override | high | bcrypt + 타이밍 균등화 + 계정 잠금 |
| [23](#l23) | partial | low | 로그인 후 이동은 list.do 단독(작성/목록 합본 화면 아님) |
| [34-39](#l34) | silent-gap | medium | Z 전용 페이지가 2개 더 있다(logs.do·distMgmt.do) |
| [50-52](#l50) | silent-gap | low | 키 미설정은 빈 결과가 아니라 데모 폴백 · 이미지는 키 2개 |
| [53](#l53) | partial | medium | 본문 검색은 평문 컬럼이 아니라 블록 JSON LIKE |
| [67-76](#l67) | silent-gap | medium | 매핑 모드는 버튼 매트릭스 전체를 우회(저장 1개) |
| [68·70-71](#l68) | partial | high | DPS 고침/포털고침 버튼은 D 전용 |
| [76](#l76) | partial | low | "(끝)" 가드 외에 제목 가드·확인창이 앞에 있다(출처는 L149·153) |
| [80](#l80) | partial | high | SSE = 단일 무효화 신호 + 전체 재조회, unauthorized면 종료 |
| [84](#l84) | override | medium | 부서 기본 선택은 '내 부서'가 아니라 '전체' |
| [89·96-99](#l89) | silent-gap | low | 데스크 미송고에도 부서 멀티셀렉트가 있다 |
| [91·96-99](#l91) | silent-gap | medium | KILL기사·엠바고 관리 우클릭 메뉴 구성이 문서에 없다 |
| [96-99](#l96) | no-conflict | low | 데스크 미송고 우클릭 5항목 — 그대로 맞다 |
| [97·100](#l97) | override | medium | 목록 기본 컬럼은 8종이 아니라 11종(+토글 1종) |
| [104](#l104) | partial | low | 시간 표시 형식은 고정이 아니라 환경설정 전역값 |
| [115](#l115) | silent-gap | medium | 이력보기는 새 창이 아니라 인앱 모달(historyView.js는 죽은 코드) |
| [123-128](#l123) | silent-gap | high | 세션 신원 매 요청 재도출 |
| [125](#l125) | partial | low | 세션 쿠키는 maxAge 1h 지속 쿠키 — 창 닫기가 세션을 끝내지 않는다 |
| [126·128](#l126) | partial | medium | 세션 운반의 1차 수단은 HttpOnly 쿠키(sessionStorage는 폴백) |
| [127](#l127) | silent-gap | medium | SSE push는 세션을 연장하지 않는다(비연장 peek) |
| [131](#l131a) | silent-gap | high | 잠금 세션/탭 컬럼은 응답에 실리면 안 된다 |
| [131-132·154](#l131b) | override | high | 잠금 신원은 세션이 아니라 탭(clientId) · 재로그인 takeover |
| [133·136](#l133) | no-conflict | low | 30분 TTL · 강제해제 D/Z — 그대로 맞다 |
| [135](#l135) | partial | medium | 창 닫기 해제는 best-effort(도달 보장 없음) |
| [142](#l142) | silent-gap | medium | IP 제한 외에 계정 단위 잠금(5회/15분·423)이 따로 있다 |
| [156-159](#l156) | override | high | SQLite SP 없음 — 앱 계층 함수 |
| [164](#l164) | override | high | 툴바 15버튼 → 2개, 기본 숨김 |
| [169](#l169) | partial | medium | 붙여넣기 이미지는 17%/612px이 아니라 최대 200×200 |
| [174](#l174) | override | high | 셸(Electron)에서는 네이티브 맞춤법이 꺼져 있다 |
| [184-190](#l184) | no-conflict | low | 상단 메뉴바 7메뉴 전 항목 일치 — 그대로 맞다 |
| [201](#l201) | silent-gap | medium | 입력모드의 유일한 효과는 상태표시줄 Byte 계산식 |
| [225](#l225) | partial | low | 작성자는 신규 탭 1회 prefill일 뿐, 기존 기사는 저장값 보존 |
| [228-233](#l228) | partial | low | articleInsert/Update/Select라는 API는 없다(REST 동사+경로) |
| [239](#l239) | silent-gap | medium | 잠금 3종 API의 실제 의미론(탭 단위·stale·D/Z 전용·멱등) |
| [249](#l249) | no-conflict | low | DPS 고침/포털고침은 Z도 제외한 D 전용 — 그대로 맞다 |
| [254](#l254) | silent-gap | medium | `ContentsVO.md`가 리포에 없다 → SCHEMA.md가 대신한다 (**Q7**) |
| [301](#l301) | override | high | CORS 고정 출처 → ALLOWED_ORIGINS + Origin/Referer 가드 |
| [302](#l302) | partial | medium | 사용자 생성/수정은 Z 전용이 맞으나 '삭제'는 API·UI가 없다 |

---

<a id="l6"></a>
### L6 — `partial` · **high** — "NodeJS를 사용한다."

- **현재 사실**: Node/Express는 **오늘도 라이브 운영 서버이고 무수정**이다(ADR-013). 그러나 P3 전환 아키텍처(ADR-017, phase 76, 2026-09-09 머지)는 **Spring Boot 서버(`server-spring/`)가 SPA와 같은 host:port를 소유**하고 클라이언트가 실제로 말을 거는 대상이 되게 한다. Node의 역할은 롤백 레버 + 패리티 대조군으로 바뀐다. **컷오버는 아직 실행되지 않았다** — 운영 `news` DB는 2026-09-04 시점에도 테이블 0개이고, 실행은 사용자 확인 항목에 걸려 있다.
- **근거**: `docs/ADR.md:71-72` (ADR-013 — "Node 서버(`server/**`·`src/**`)는 **무수정**이고 두 서버가 공존한다") · `docs/ADR.md:96-97` (ADR-017 — ③ **"Node 은퇴"는 운영 중단이지 코드 삭제가 아니다**) · `docs/ADR.md:91` ("컷오버는 실행하지 않았다 — 운영 `news`는 이 시점에도 **테이블 0개**")
- **결정 주체**: ADR-013(2026-08) · ADR-017(phase 76, 2026-09-05~09). 컷오버 실행은 미해결 사용자 항목에 게이트됨.
- **news.md만 믿으면**: Express 특유의 부수 동작을 계약으로 오인해 클라이언트에 굳힌다. 와이어 정본은 **`docs/api-contract/endpoints.json`(39 라우트)** 이다 — 두 서버 모두 이 계약에 대해 diff 테스트된다. 또한 Node는 컷오버 후에도 **의도적으로 남는다**(삭제되지 않는다).

<a id="l7"></a>
### L7 — `partial` · low — "MVC Pattern으로 개발한다." (서버 기술명세서)

- **현재 사실**: 서버는 고전 MVC가 아니라 **얇은 transport + 계층형 도메인**이다: `controllers → services → models → db`(ADR-006). 순수 REST/SSE API 서버라 **View 계층이 없다**(ADR-001이 View를 가진 SPA와 API-only 백엔드를 분리한다). Spring 포팅도 동일 계층(`controller → service → repository → db`, ADR-013). 반면 **클라이언트 쪽 같은 문장(L31)은 정확하다** — ADR-003이 주입 가능한 `contract.js` seam을 가진 진짜 M/V/C 분리를 정의한다.
- **근거**: `docs/ADR.md:10-13` (ADR-001) · `docs/ADR.md:35-38` (ADR-006) · `docs/ADR.md:71-72` (ADR-013) · `docs/ADR.md:20-23` (ADR-003, 대조용)
- **결정 주체**: ADR-001 · ADR-006 · ADR-013
- **news.md만 믿으면**: 백엔드에서 'View'에 해당하는 계층을 찾다가 없어서 임의로 만든다. 백엔드에서 복제할 계층은 controller/service/model/db이고, View는 클라이언트에만 있다.

<a id="l8"></a>
### L8 — `partial` · **high** — "DB는 SQLite를 사용한다."

- **현재 사실**: Node(라이브 서버)는 SQLite `news.db`를 **무수정으로 계속 쓴다**. 그러나 포팅/미래 스택의 저장소는 **MySQL 8.0으로 확정**됐다(사용자 결정 2026-09-01 · 실측 판본 8.0.46). **"Node=SQLite / Spring=MySQL 병존이 정상 상태"** 가 P2 이후의 문서화된 정상 조건이고, MySQL 스키마 정본은 별도 모듈 `tools/news-migrator`의 Flyway 기반선이 소유한다. MySQL을 단일 운영 저장소로 만드는 컷오버는 아직 실행되지 않았다.
- **근거**: `docs/ADR.md:87` (ADR-016 표제) · `docs/ADR.md:88` (결정 ①②③ — MySQL 8.0 · Node는 SQLite 무수정 정본 · Flyway 정본 이관) · `docs/ADR.md:91` (P2 마감 실측 — 컷오버 미실행, 운영 DB 테이블 0개)
- **결정 주체**: ADR-016 · phase 75(P2 DB 이관) · 사용자 결정 2026-09-01
- **news.md만 믿으면**: SQLite 저장 의미론을 시스템의 항구적 전제로 삼는다. ADR-016 트레이드오프 문단이 **8종의 SQLite/MySQL 행동 차이**(LIKE 대소문자 · 삭제 후 id 재사용 · 769자 텍스트 PK 거부 등)를 기록해 뒀다 — REST 계약 밖의 가정을 클라이언트 로직에 심으면 그 축에서 갈린다.

<a id="l11"></a>
### L11-18 — `no-conflict` · low — 기사 함수(조회 5종 필터 · 삭제)

- **확인 결과**: 다섯 조회 조건(기사아이디 · 작성자 · 송고자 · 작성시간 범위 · 배부시간 범위)이 **명세 그대로** 구현돼 있고, 그 위에 news.md와 모순되지 않는 필터(status/excludeStatus/department)가 더 얹혀 있다. **L18의 "삭제도 상태값 수정"** 도 정확하다 — DPD는 행 삭제가 아니라 삭제 승인 상태값이다(DB 비파괴). 이건 나중에 덧씌운 규칙이 아니라 원본 스펙부터 그랬다.
- **근거**: `src/models/articleModel.js:79-147` (`query()`) · `docs/SCHEMA.md:50` ("DPD는 DPS 기사의 삭제 승인 상태값이다(행 삭제가 아니라 상태값 전이 — DB 비파괴)")

<a id="l17"></a>
### L17 — `silent-gap` · medium — "기사를 수정하는 함수에서는 기사 아이디를 조건으로 기사 상태값을 수정할 수 있다."

- **현재 사실**: 일반 기사 편집(제목/본문 — 상태값만이 아니다)은 별도 엔드포인트 `PUT /api/articles/:id`이고 **비관적 편집 잠금이 필수 전제**다: `POST /api/articles/:id/lock`으로 잠금을 얻은 **탭(`x-edit-client`)만** PUT할 수 있고, DPS 상태 기사는 **D 권한만** 잠글 수 있으며, 잠금 충돌은 `401 reason:'locked'`, 별도로 D/Z의 강제 해제 라우트가 있다. 상태 전이는 이것과 **다른 엔드포인트**(`POST /api/articles/:id/action`)다. 이 동시성 제어는 news.md 기사 함수 절에 전혀 없다.
- **근거**: `docs/api-contract/endpoints.json:241-277` (articles-update `auth:'lock-holder'` · articles-lock(DPS D 전용·401 locked) · articles-unlock · articles-force-unlock) · 같은 파일 `:212-221` (articles-action — 역할 게이트 R/D/Z의 별도 상태 전이 엔드포인트)
- **결정 주체**: 구현(ADR 카탈로그 이전의 동시성 제어 기능) — 동결 계약으로 고정됨
- **news.md만 믿으면**: 기사ID로 바로 수정하는 단순 함수를 만든다. 실제로는 잠금 획득/해제/강제해제와 탭 신원(`x-edit-client`)이 **선택 사항이 아니라 1급 메커니즘**이고, 상태 전이와 내용 수정은 **다른 코드 경로**다.

<a id="l21"></a>
### L21 — `override` · **high** — "사용자를 입력/수정/삭제/조회 할 수 있는 함수를 생성한다."

- **현재 사실**: **사용자 삭제 함수도, 삭제 라우트도 없다.** '삭제'는 비활성화(`active='N'` 업데이트)로만 구현된다. 동결 REST 계약은 `/api/users`에 GET/POST/PUT만 노출하고 DELETE가 없다.
- **근거**: `src/models/userModel.js:2` ("삭제 함수는 두지 않는다: 비활성화는 active='N' 업데이트로 처리한다 (DB 비파괴)") · `docs/api-contract/endpoints.json:40-66` (users-list/users-create/users-update만 — delete 라우트 없음)
- **결정 주체**: 프로젝트 규칙(`CLAUDE.md` "DB에 있는 내용은 절대 삭제하지 않는다") · ADR.md 철학의 DB 비파괴 원칙
- **news.md만 믿으면**: 관리 화면에 실제 행 삭제 액션을 만든다 — 시스템 전체가 딛고 선 DB 비파괴 불변식을 깬다. 이식할 DELETE 엔드포인트는 **존재하지 않는다**.

<a id="l22"></a>
### L22 — `override` · **high** — "아이디와 비밀번호를 조건으로 전달된 값이 DB에 있는 정보와 같으면 로그인 할 수 있다."

- **현재 사실**: 비밀번호는 **bcrypt 해시(10 rounds)** 로 저장되고 `bcrypt.compare`로 대조한다 — 값 동등 비교가 아니다. 여기에 news.md에 없는 규칙이 셋 더 있다. ① **존재하지 않는 userId도 더미 해시로 bcrypt 비교를 1회 수행**해 소요 시간을 균등화한다. ② **비활성(`active='N'`) 거부가 잠금 판정·실패 카운트보다 앞선다.** ③ **5회 연속 실패 시 그 계정을 15분 잠근다**(`LOCKOUT_THRESHOLD=5` / `LOCKOUT_DURATION_MS=15분`) — 잠긴 동안은 올바른 비밀번호도 거부한다.
- **근거**: `src/services/userService.js:6` (bcryptjs) · `:14-18` (LOCKOUT_THRESHOLD · LOCKOUT_DURATION_MS · DUMMY_HASH) · `:43-64` (login — compare → inactive → locked → 실패 누적 순서) · `docs/ADR.md:27` (ADR-004 "비밀번호는 bcrypt 해시로 저장한다")
- **결정 주체**: ADR-004 · 2026-08 보안 감사 결과의 잠금 하드닝
- **news.md만 믿으면**: 원문 문자열 동등 비교 인증을 만든다(심각한 보안 회귀). bcrypt 검증 · 타이밍 균등화 · 잠금/비활성 거부를 모두 구현해야 하며 이 중 어느 것도 news.md에 없다.

<a id="l23"></a>
### L23 — `partial` · low — "로그인 후에는 기사 작성 기능과 기사 목록기능이 있는 페이지로 이동한다."

- **현재 사실**: 로그인 성공은 정확히 **`list.do`(기사 목록)** 로 간다. 작성/목록 합본 화면은 없다 — 작성은 별도 라우트 `writer.do`이고 `list.do` UI에서 진입한다. 로그인 상태에서 `login.do`로 가려는 시도는 전부 `list.do`로 리졸브된다.
- **근거**: `web/src/app/routing.js:27-32` (`resolveRoute` — identity 있고 target이 `login.do`면 `list.do`)
- **결정 주체**: 구현 — news.md 내부 긴장(L34-36이 이미 writer.do와 list.do를 별개 페이지로 열거한다)의 해소
- **news.md만 믿으면**: 작성+목록 합본 단일 화면을 설계한다. 위험은 낮다(몇 줄 아래 페이지 목록이 두 화면임을 이미 시사한다).

<a id="l34"></a>
### L34-39 — `silent-gap` · medium — 페이지 목록(login/writer/list/rcvMgmt/userMgmt)

- **현재 사실**: news.md 목록에 없는 **Z 전용 `.do` 페이지가 2개 더 있다.** `logs.do`(실시간 관리자 로그 뷰어 — ADR-007)와 `distMgmt.do`(배부 대상 관리 — 2026-07-26 배부 스코프 확장, ADR-008). 둘 다 `rcvMgmt.do`/`userMgmt.do`와 **동일하게 게이트**된다(Z 아니면 `list.do`로 리다이렉트).
- **근거**: `web/src/app/routing.js:7-8` (`ROUTES`에 `logs.do`·`distMgmt.do` 포함, `Z_ONLY_ROUTES`도 동일) · `:27-32` (Z 게이트)
- **결정 주체**: ADR-007(로그 SSE/뷰어) · ADR-008 + 사용자 결정 2026-07-26(배부 시스템 스코프 확장)
- **news.md만 믿으면**: 로그 뷰어와 배부 관리 화면을 통째로 빠뜨린다. 둘 다 Z 역할의 핵심 기능이고 배부는 현재 구현 범위에 포함된다.

<a id="l50"></a>
### L50-52 — `silent-gap` · low — 이미지/영상 검색 프록시 · "외부 검색이 실패하면 오류 대신 빈 결과"

- **현재 사실**: **키가 아예 없을 때는 빈 결과가 아니라 결정적 데모 페이로드**를 돌려준다(`{items: demoResults(...), error:false, demo:true}` — 이미지는 picsum.photos, 영상은 고정 공개 YouTube id 4개). 외부 호출 자체를 하지 않는다. **빈 결과(`{items:[], error:true}`)는 "키가 설정됐는데 호출이 실패한 경우" 전용**이다. 또한 이미지 검색은 news.md가 시사하는 단일 'API 키'가 아니라 **`GOOGLE_API_KEY`와 `GOOGLE_CSE_ID` 2개**를 요구한다(영상은 `YOUTUBE_API_KEY` 1개).
- **근거**: `src/services/mediaSearch.js:11` (`empty()`) · `:13-31` (`demoResults`) · `:38-47` (`buildUrl` — 이미지에 키 2개 요구) · `:49-54` (키 없음 → 데모) · `docs/ADR.md:77-81` (ADR-014 — 키 없으면 미디어 검색은 데모 폴백 + `error:false`, 번역은 200 + `ok:false` + `reason:'no-key'`)
- **결정 주체**: **ADR-014**. (주의: `mediaSearch.js:1`의 주석이 근거를 'ADR-005 서버 프록시'라고 적었는데 이는 ADR-014 마지막 문단이 지적한 **오귀속**이다 — ADR-005는 SSE 무효화 스트림으로 무관하다.)
- **news.md만 믿으면**: "키 없음 → 빈 결과"로 만들어 데모 폴백 UX를 잃고(웹은 샘플이 보이는데 Qt는 빈 패널), 이미지 검색에 CSE id가 더 필요하다는 사실도 놓친다.

<a id="l53"></a>
### L53 — `partial` · medium — "글기사는 내부 기사DB에서 제목, 본문내용을 검색하여 결과를 보여준다."

- **현재 사실**: 검색은 `SELECT * FROM Article WHERE title LIKE ? OR content LIKE ? OR markupVersion LIKE ?`인데, **`content`(평문 본문) 컬럼은 현재 사용하지 않는다** — 본문은 `markupVersion`(블록 JSON 직렬화 문자열)에만 저장된다. 즉 '본문내용 검색'은 실제로는 **블록 JSON 원문 LIKE 매칭**으로 충족된다.
- **근거**: `src/models/articleModel.js:150-156` (`searchByText`) · `docs/SCHEMA.md:38-40` ("본문내용(평문) 컬럼은 현재 사용하지 않는다 — 본문은 마크업내용 버전에만 저장한다")
- **결정 주체**: 실측(Article.content 미사용 결정이 이 검색 기능보다 선행·독립)
- **news.md만 믿으면**: 깔끔한 `content` 텍스트 컬럼을 검색해 **0건**을 얻는다. 직렬화 JSON blob을 LIKE 매칭해야 하고, 그 대가로 임베드 메타데이터·JSON 문법 노이즈에도 매치가 걸린다(news.md가 말하지 않는 행동 뉘앙스).

<a id="l67"></a>
### L67-76 — `silent-gap` · medium — '기사 작성 페이지 내 버튼' 절 전체

- **현재 사실**: news.md의 송고/보류/KILL 매트릭스를 **통째로 우회하는 네 번째 진입 모드**가 있다. 탭이 `mode:'mapping'`(목록 페이지 우클릭 '매핑' — 본문을 보존하는 임베드 전용 편집)이면 액션 바는 **'저장' 버튼 단 하나**이고, 그 저장은 **생애주기 전이 없는 평범한 PUT**이며(`applyAction` 미호출), **역할·상태·기사아이디와 무관하게** 표시된다.
- **근거**: `web/src/view/WriterPage.jsx:1696-1712` (`isMapping ? <저장> : buttons.map(...)`) · `web/src/view/writerButtons.js:26-28` (`if (mode === 'mapping') return ['save'];`) · `phases/3-mapping/step0.md:18` ("매핑은 생애주기 전이를 일으키지 않으므로 이 submit을 쓰지 않는다") · `phases/3-mapping/step1.md:57` ("매핑 탭에 송고/보류/KILL 버튼을 표시하지 마라")
- **결정 주체**: phase 3(3-mapping) step0/step1
- **news.md만 믿으면**: 매핑 모드의 저장 경로를 아예 빠뜨리거나, 잘못해서 송고/보류/KILL 생애주기 규칙으로 태운다.

<a id="l68"></a>
### L68 · L70-71 — `partial` · **high** — "Z권한은 송고/보류/KILL 버튼이 보이고 사용할 수 있다." / "송고/보류 버튼은 권한 R, D 그리고 DPS 기사가 포털고침 또는 고침버튼을 눌렀을 때 표현한다."

- **현재 사실**: DPS 고침/포털고침 진입 컨텍스트에서는 **역할 D만** 버튼을 받는다 — `if (mode === 'revise' || mode === 'portalRevise') { return role === 'D' ? order(['send','hold']) : []; }`. R은 없고(L70-71의 "R, D"와 모순) **Z도 없다**(L68의 포괄 서술과 모순). 이 판정은 news.md **자신의 더 구체적인 문장**(L92 "우클릭 메뉴의 고침(포털제외)/포털고침은 … D 권한 사용자에게만 활성화" · L249 "DPS일 때는 D 권한 사용자만 고침/포털고침 메뉴를 사용할 수 있다")과 일치한다.
- **근거**: `web/src/view/writerButtons.js:35-38` · `docs/news.md:92`·`:249` · `phases/0-mvp/step12.md:25` ("**DPS 고침/포털고침 진입**은 권한 D만 가능 … 이 컨텍스트에서는 **송고·보류만** 표시(KILL 없음)")
- **결정 주체**: phase 0-mvp step12 — 구현자가 news.md 내부 모순을 **구체 서술(L92·L249) 우선**으로 해소했다.
- **news.md만 믿으면**: L68/L70-71만 보고 만들면 R과 Z에게 송고/보류를 잘못 노출한다 — **실제 권한 과다 부여 버그**다(이 모드에서 KILL은 누구에게도 뜨지 않는다).
- **부기**: `phases/0-mvp/step12.md:25`는 근거를 "(news.md 193)"으로 적었는데 그 줄 번호는 현재 news.md와 맞지 않는다(현재 해당 규칙은 L92·L249). 규칙 자체는 유효하다.

<a id="l76"></a>
### L76 — `partial` · low — "송고는 본문에 \"(끝)\" 표시가 있어야 한다. … 보류/KILL은 \"(끝)\" 없이도 진행된다."

- **현재 사실**: 이 문장 자체는 **정확하다**(코드와 일치). 다만 그 앞에 이 절에 없는 게이트가 둘 더 있다. ① **송고와 보류(KILL 제외)는 제목이 비어 있으면 차단**한다(제목은 본문 첫 줄 또는 제목 필드 중 하나라도 있으면 인정). ② 모든 액션 전에 **확인창**이 뜬다. 두 규칙은 news.md에 **있다** — 단지 이 절이 아니라 **L153**(제목 가드)과 **L149**(확인창)에 있다.
- **근거**: `web/src/view/WriterPage.jsx:1554-1558` (제목 가드) · `:1559-1562` ("(끝)" 가드) · `:1563` (확인창) · `docs/news.md:149`·`:153`
- **결정 주체**: news.md 자신(L149·L153) — ADR이 아니다.
- **news.md만 믿으면**: 절 단위로만 읽는 포터가 제목 가드와 확인창을 빠뜨린다. **절 경계의 공백**이지 문서의 드리프트는 아니다.
- **검증 이견(1표)**: 재검증 2표 중 1표가 "이 항목은 드리프트가 아니므로 표에서 빼야 한다"고 판정했다. 그럼에도 남긴 이유는 **절 단위로 이식하는 포터에게 실제로 유용한 교차 참조**이기 때문이다. 심각도 low로 두고 이견을 여기 명시한다.

<a id="l80"></a>
### L80 — `partial` · **high** — "실시간은 SSE 스트림으로 구현한다. 기사 생성/수정/상태변경/잠금변경 이벤트를 수신하면 목록을 갱신하고, 연결이 끊기면 자동으로 재연결한다."

- **현재 사실**: 클라이언트가 받는 것은 4종 이벤트별 구분 신호가 아니라 **행 데이터 없는 단일 `change` 신호**(payload `{kind:'create'|'update'|'status'|'lock'}`)이고, 컨트롤러는 **kind를 무시하고 항상 자기 필터로 전체 재조회**한다(naive broadcast, ADR-005). 또 "끊기면 자동 재연결"은 **일시적 네트워크 오류에만** 해당한다 — 서버가 세션 무효화 시 보내는 **`unauthorized` 프레임을 받으면 클라이언트가 EventSource를 명시적으로 `close()` 하여 재연결을 영구 중단**한다(재연결 폭주 방지).
- **근거**: `docs/api-contract/sse.md:38` ("이벤트 어휘 4종") · `:58` (`change` — 행 데이터 없음) · `:60` (`unauthorized` — 프레임 1회 후 서버 `res.end()`, 클라이언트가 EventSource를 닫는다) · `web/src/model/httpModel.js:310` · `:330-332` (unauthorized → `source.close()`, error는 재연결 보존) · `web/src/controller/useViewController.js:143-147` (kind 무시하고 `refresh()`)
- **결정 주체**: ADR-005(SSE 무효화 신호) · ADR-007(push 시점 비연장 재검증)
- **news.md만 믿으면**: 이벤트 종류별 핸들러/부분 갱신을 만든다 — 오버엔지니어링이자 서버 계약과 불일치다. **단일 무효화 신호 + 전체 재조회**, 그리고 **unauthorized 수신 시 종료** 규약을 그대로 구현해야 한다.

<a id="l84"></a>
### L84 — `override` · medium — "부서별 작성페이지는 … 진입 시 로그인 사용자의 부서가 기본 선택되어 자동 조회된다."

- **현재 사실**: 부서별 작성(deptWrite) 진입 기본값은 **'전체'**(부서 미지정)이지 로그인 사용자의 부서가 아니다. 메뉴를 전환할 때마다 `selectMenu`가 `setDepartments(null)`로 '전체'로 리셋한다. 데스크 미송고·부서별 작성·부서별 송고 3개 메뉴의 기본값이 **'전체'로 통일**됐다.
- **근거**: `web/src/controller/useViewController.js:87` (`useState(null)` — 주석 "null/[] = '전체'(부서 미지정) — 3개 메뉴 공통 기본값") · `:149-153` (`selectMenu` → `setDepartments(null)`) · `web/src/controller/useViewController.test.jsx:28-29` ("dept write → … default 전체 (no department)") · `phases/4-mvp-polish/step5.md:29` ("**세 메뉴 기본값을 '전체'로 통일**한다(부서별 작성 기본값을 기존 '내 부서'에서 '전체'로 변경)")
- **결정 주체**: phase 4-mvp-polish step5(명시 결정)
- **news.md만 믿으면**: 로그인 사용자 부서를 기본 선택으로 만들어 실제 동작(전체 조회)과 어긋난다.

<a id="l89"></a>
### L89 (+ L96-99) — `silent-gap` · low — 부서 멀티셀렉트의 노출 범위

- **현재 사실**: news.md는 KILL기사·엠바고 관리 페이지에 부서 드롭다운이 있다고만 적고, 데스크 미송고 페이지 서술(L96-99)에는 부서 선택 UI 언급이 없다. 실제로는 **데스크 미송고에도 동일한 '전체' 토글 체크박스 멀티셀렉트 + 조회버튼이 노출**된다.
- **근거**: `web/src/view/ListPage.jsx:187-188` (`showDeptSelector`에 `deskUnsent` 포함) · `phases/4-mvp-polish/step5.md:29` ("부서 선택은 **데스크 미송고·부서별 작성·부서별 송고 3개 메뉴 공통**으로 노출")
- **결정 주체**: phase 4-mvp-polish step5(명시 결정)
- **news.md만 믿으면**: 데스크 미송고에서 부서 선택 UI를 뺀다.

<a id="l91"></a>
### L91 (+ L96-99) — `silent-gap` · medium — 우클릭 메뉴 구성(KILL기사 · 엠바고 관리)

- **현재 사실**: news.md는 부서별 작성/부서별 송고/개인별 수정/데스크 미송고의 우클릭 메뉴만 서술하고 **KILL기사·엠바고 관리 페이지의 우클릭 메뉴 구성은 어디에도 없다**. 실제 구성은 이렇다.
  - **KILL기사**: `상세보기 · 이력보기 · 송고이력보기 · 본문복사 · 제목만복사` **읽기전용 5항목**(전이·편집 액션 전부 숨김).
  - **엠바고 관리**: 위 5항목 + **'편집'**(항상 `enabled:true` — 실제 인가는 서버 잠금 게이트가 강제).
- **근거**: `web/src/view/ContextMenu.jsx:48-51` (killArticles) · `:52-57` (embargoMgmt) · `web/src/view/ContextMenu.test.jsx:162` · `:176`
- **결정 주체**: 구현 단계 도출(step2/step3 · phase48 step5 — 사용자 확정 기록 없음)
- **news.md만 믿으면**: 두 페이지의 메뉴 구성을 전혀 알 수 없다.
- **정정(검증)**: 엠바고 관리에 **편집 항목이 있다는 사실 자체는** news.md **L264·L266**("엠바고 관리 메뉴에서 기사를 편집할 수 있다")에 있다. 문서에 없는 것은 **나머지 4개 읽기전용 항목과 정확한 구성·순서**다. KILL기사 메뉴는 news.md 전체에 걸쳐 **완전한 공백**이다.

<a id="l96"></a>
### L96-99 — `no-conflict` · low — 데스크 미송고 우클릭 메뉴

- **확인 결과**: 코드의 `deskUnsent` 메뉴는 정확히 `[편집(D/Z만 활성) · 상세보기 · 이력보기 · 본문복사 · 제목만복사]` 5항목으로 news.md와 일치한다(news.md L98의 '제목만목사'는 원문 오타).
- **근거**: `web/src/view/ContextMenu.jsx:45-47`

<a id="l97"></a>
### L97 · L100 — `override` · medium — "컬럼은 기사아이디, 제목, 작성자, 수정자, 작성시간, 수정시간, 기사상태, LockYN**만** 표현한다."

- **현재 사실**: 기본 표시 컬럼은 8종이 아니라 **부서·부서코드·송고시간이 추가된 11종**이다(이 셋은 `defaultVisible` 미지정 = 기본 표시). 여기에 **배부시간**이 카탈로그에 있으나 **기본 숨김**(컬럼 설정에서 켠다) — 카탈로그 총 12종.
- **근거**: `web/src/view/columnConfig.js:2-3` (주석 "부서/부서코드는 사용자 요청으로 추가 — news.md 기본 8컬럼에 더해 노출") · `:6-20` (COLUMNS 12개 · `distributedAt`만 `defaultVisible:false`)
- **결정 주체**: phase 4-mvp-polish step5(사용자 요청, 명시 결정)
- **news.md만 믿으면**: "~만 표현한다"를 그대로 따라 부서/부서코드/송고시간을 누락하고, 토글 가능한 배부시간 컬럼도 만들지 않는다.

<a id="l104"></a>
### L104 — `partial` · low — "작성시간/수정시간 컬럼은 YYYY-MM-DD HH:mm 형식으로 가운데 정렬해 표시한다."

- **현재 사실**: 가운데 정렬은 고정 규칙으로 일치한다. 그러나 **시간 표시 형식은 고정이 아니다** — 에디터 환경설정의 9종 날짜 포맷 중 선택값을 따르는 모듈 전역 `currentFormat`이고 `'YYYY-MM-DD HH:mm'`은 그 **기본값**일 뿐이다. 사용자가 포맷을 바꾸면 작성시간·수정시간·송고시간·배부시간 컬럼이 전부 그 포맷을 따른다.
- **근거**: `web/src/view/listFormat.js:17-21` (`DEFAULT_DATE_FORMAT` · 가변 `currentFormat`) · `:52-62` (`formatDateTime`/`formatCell` — 4개 시간 컬럼 공통) · `web/src/view/ListPage.jsx:94` (`setDateFormat(loadEditorPrefs().dateFormat)`)
- **결정 주체**: 에디터 환경설정 '날짜형식' 기능(news.md L213-214의 다른 절)
- **news.md만 믿으면**: 포맷을 하드코딩해 사용자가 다른 날짜 형식을 고른 순간 목록 표시가 어긋난다.

<a id="l115"></a>
### L115 — `silent-gap` · medium — "이력보기를 누르면 …"

- **현재 사실**: news.md는 이력보기의 **표시 매체(새 창 vs 인앱 모달)** 를 명시하지 않는다. 현재 라이브 구현은 상세보기와 달리 **리스트 페이지 내 인앱 모달**이다. 새 창 렌더용 모듈 `web/src/view/historyView.js`(`renderHistoryHtml`)가 남아 있지만 **어떤 프로덕션 코드도 import하지 않는 고아(dead) 코드**다 — 자기 테스트만 쓴다.
- **근거**: `web/src/view/ListPage.jsx:333-368` (historyModal) · `web/src/view/historyView.test.js:2` (유일한 import) · `web/src/view/historyColumns.js:33`은 주석 참조일 뿐 import가 아니다 · `phases/1-menu-actions/step8.md:60` ("**권장: 모달**")
- **결정 주체**: phase 1-menu-actions step8 권고 → phase 56-history-view-columns가 모달 경로로 구현, 새 창 경로는 방치
- **news.md만 믿으면**: `historyView.js`를 살아있는 구현으로 오인해 새 창 방식으로 이식한다. 이력보기/송고이력보기는 **모달**로 이식해야 하고 `historyView.js`는 이식 대상이 아니다.

<a id="l123"></a>
### L123-128 — `silent-gap` · **high** — 세션 정책 절(슬라이딩 만료만 서술)

- **현재 사실**: 세션 신원(role·active·부서 등)은 **로그인 시점 스냅샷이 아니다.** 모든 touch/peek이 User DB 행을 다시 읽어 신원을 재도출하고, 행이 사라졌거나 `active='N'`이면 **세션을 즉시 무효화**한다. 역할 변경은 **바로 다음 요청부터** 적용된다 — 캐시도 TTL도 없다. 이것은 실제 사고(강등/비활성 후에도 옛 권한이 유지되던 [high] 감사 지적) 이후 소급 적용됐다.
- **근거**: `src/services/sessionGuard.js:1-27` (파일 주석이 2026-08-03 [high] 감사 지적을 인용 · `revalidate()`가 매 호출 `userModel.findById` 재조회 후 `identityOf` 화이트리스트 투영) · `docs/ADR.md:27` (ADR-004 — "세션 신원(role/active 등)은 **로그인 시점 스냅샷이 아니라 매 요청 User 행 재조회로 재도출**한다")
- **결정 주체**: 2026-08-03 감사 지적[high] + ADR-004
- **news.md만 믿으면**: 로그인 때 role/active를 세션 객체에 캐시한다(문면 그대로 읽으면 자연스러운 설계) — 이 프로젝트가 이미 고친 **stale-privilege 버그를 그대로 재생산**한다. 비활성/강등된 사용자가 최대 1시간 동안 옛 권한으로 행동한다.

<a id="l125"></a>
### L125 — `partial` · low — "새로고침(F5)을 눌러도 세션이 끊어지면 안 되고 유지한다. (탭/브라우저 닫힘 시에는 세션 종료 …)"

- **현재 사실**: 세션 쿠키는 **`maxAge=1시간`의 지속 쿠키**로 발급된다(브라우저 종료 시 삭제되는 진짜 'session cookie'가 아니다). 1시간 유휴 창 안이면 브라우저를 다시 열어도 쿠키가 재전송되고 세션 복원이 조용히 성공한다 — **탭/브라우저 닫힘이 서버 세션을 끝내지 않는다.** 닫을 때 시도되는 것은 편집 잠금 해제뿐이고 그것도 best-effort다([L135](#l135)).
- **근거**: `server/index.js:43` (`SESSION_COOKIE_MAX_AGE_MS = ONE_HOUR_MS`) · `:52-59` (`sessionCookieOptions` — `httpOnly:true`, `maxAge: ONE_HOUR_MS`) · `src/services/sessionService.js:21-53` (만료는 순수 시간 기반 슬라이딩 — 창 닫힘 트리거 무효화가 서버에 아예 없다)
- **결정 주체**: phase 1-security-hardening(쿠키 전환) — 창 닫힘 세션 종료를 추가하는 결정은 동반되지 않았다.
- **news.md만 믿으면**: 창 닫힘에 클라이언트 자격증명을 파기하는 로직을 넣고 그것이 서버 진실을 반영한다고 믿는다. 서버에는 그런 메커니즘이 없다.

<a id="l126"></a>
### L126 · L128 — `partial` · medium — 세션 토큰과 sessionStorage

- **현재 사실**: **L126은 여전히 정확하다** — 토큰은 서버 발급 무작위 값이고 권한을 담지 않으며, 로그인 성공 시 기존 세션을 무효화하고 새 토큰을 발급한다. **바뀐 것은 L128의 운반/보관 수단**이다. phase 1-security-hardening(steps 3-5) 이후 1차 인증 수단은 **JS가 읽을 수 없는 서버 발급 HttpOnly 쿠키(`sid`)** 이고 `credentials:'include'`로 자동 첨부된다. `sessionStorage` + `x-session-id` 헤더는 **dev/cross-origin 폴백**으로만 남아 있다.
- **근거**: `web/src/model/httpModel.js:7-11` (파일 머리 — "인증의 1차 수단은 서버가 발급한 HttpOnly 세션 쿠키 … x-session-id 헤더는 dev cross-origin 폴백") · `server/index.js:42` (`SESSION_COOKIE_NAME='sid'`) · `:52-59` (`httpOnly:true`) · `:587-588` (`readSessionToken` — 쿠키 우선, 헤더 폴백) · `phases/1-security-hardening/index.json` (step3 `cookie-session-server` = 커밋 `6819805` · step4 `cookie-session-client` = `d2d44bc`, 둘 다 2026-06-15)
- **결정 주체**: phase 1-security-hardening(steps 3-5) — ADR-004가 후속 과제로 적어 둔 HttpOnly 쿠키 하드닝
- **news.md만 믿으면**: 세션 id를 클라이언트가 읽는 저장소에 넣고 매 요청 헤더로 붙인다. Qt 클라이언트는 **쿠키 자(cookie jar) 기반 세션 지속**(`credentials:'include'` 대응)을 써야 하고, 헤더 폴백은 비쿠키 전송에서만 의미가 있다.

<a id="l127"></a>
### L127 — `silent-gap` · medium — "세션 만료 시점 갱신(sliding)은 인증된 모든 요청마다 이루어진다."

- **현재 사실**: 일반 REST 요청에는 참이지만 **두 SSE 스트림(`/api/stream`·`/api/logs/stream`)은 push마다 세션을 연장하지 않는다.** 최초 연결에서 한 번 touch(연장)하고, 이후 라이브 이벤트 재검증은 **비연장 `peek`** 을 쓴다(명시 설계). 즉 다른 요청 없이 SSE만 열어 두면 이벤트를 계속 받는 중에도 마지막 실제 요청으로부터 1시간 뒤 세션이 만료된다.
- **근거**: `docs/ADR.md:33` (ADR-005 트레이드오프 — "**push 시점 재검증(비연장 peek)** … 무효화된 세션에는 `change` 신호를 쓰지 않고") · `docs/ADR.md:43` (ADR-007 동형) · `src/controllers/index.js:151`·`:154` (`session: touchSession` vs `peek: peekSession`) · `server/index.js:1139-1150` (주석 "반드시 비연장 peek다: touch면 열린 SSE가 세션을 무한 연장해 1시간 유휴 만료가 무력화된다" → `controllers.auth.peek(sid)`)
- **결정 주체**: ADR-005 / ADR-007
- **news.md만 믿으면**: 스트림이 열려 있는 것을 '활동'으로 보고 클라이언트 유휴 타이머를 갱신한다. 서버는 그와 무관하게 만료시키므로, 클라이언트는 **실제 사용자 요청**을 따로 추적해야 세션 만료 시점을 안다.

<a id="l131a"></a>
### L131 — `silent-gap` · **high** — "잠금은 잠근 사용자, 세션, 잠금 시각으로 식별한다."

- **현재 사실**: 잠금 행의 식별 필드 중 **`lockerSessionId`(살아있는 인증 토큰 원문)와 `lockerClientId`(탭 사칭 재료)는 기사/콘텐츠를 돌려주는 어떤 응답에도 실리면 안 된다**(목록·상세·검색 전부, 다른 인증 사용자에게도). 서비스 읽기 경계의 **단일 chokepoint 투영**(`PRIVATE_CONTENTS_COLS`)이 이를 강제하고, DB 행과 잠금 판정 내부 경로는 실값을 그대로 쓴다. 이것은 실제 권한 상승 취약점(로그인한 R 기자가 목록 응답에서 D/Z의 세션 토큰을 읽어 자기 `x-session-id`로 재사용)의 수정이다.
- **근거**: `src/services/contentsProjection.js:16-18` (`PRIVATE_CONTENTS_COLS = Object.freeze(['lockerSessionId','lockerClientId'])` · 파일 주석 2-14가 신뢰 경계 근거) · `:24-32` (`toPublicContents`) · `phases/51-security-hotfix/step0.md:5-11` (취약점 서술) · `:36` ("`lockerClientId`도 함께 제거 대상 … 누구나 남의 편집 탭을 사칭할 재료를 얻는다") · `:46` (투영 상수 정의)
- **결정 주체**: phase 51-security-hotfix(2026-08 감사에서 발견된 권한 상승 취약점 수정)
- **news.md만 믿으면**: L134("잠금 획득에 실패해도 누가 잠갔는지는 알려주지 않는다")는 **실패 응답만** 덮는다. 조회/목록 응답은 Contents 행을 통째로 실어도 된다고 오해하기 쉽고, 그러면 **이미 고친 그 취약점을 그대로 재생산**한다. 반대로 `lockYN`·`lockerUserId`·`lockedAt`은 **UI 계약이므로 유지**한다.

<a id="l131b"></a>
### L131-132 · L154 — `override` · **high** — "잠금은 잠근 사용자, 세션, 잠금 시각으로 식별한다." / "한 기사의 편집은 한 페이지 한 세션 한정이다." / "편집 중 기사 저장(수정)은 편집 잠금을 보유한 세션만 할 수 있다."

- **현재 사실**: 잠금 보유자 신원의 실제 키는 **(userId, clientId)** 다 — `clientId`는 클라이언트가 만든 '편집 탭' 문자열이며 **`x-edit-client` 헤더**로 전달된다. **세션 id가 아니다.** `releaseEditLock`과 `assertLockHolder`는 `sessionId`를 읽지도 비교하지도 않는다(계약상 인자로만 받고 판정에 쓰지 않는다). `sessionId`가 쓰이는 곳은 단 하나 — **같은 사용자가 다른(새) 세션으로 재로그인했을 때 takeover를 허용**하는 판정이다. 즉 news.md의 "다른 세션이면 편집 불가"는 실제와 반대 방향이다. 규칙 전체는 이렇다: 같은 탭 재획득(F5) 허용 · 같은 사용자 재로그인 takeover 허용 · **같은 세션의 다른 탭 차단** · 다른 사용자 차단.
- **근거**: `src/services/articleService.js:383-389` (a/b/c 규칙 주석) · `:390-412` (`acquireEditLock` — `const sameUserReLogin = c.lockerUserId === userId && c.lockerSessionId !== sessionId;`) · `:414-432` (`releaseEditLock` — 주석 "sessionId는 받지도 쓰지도 않는다", 이미 해제된 잠금 해제는 멱등) · `:450-466` (`assertLockHolder` — `clientId` + `userId`만으로 판정, `sessionId` 미사용) · `server/index.js:932`·`:961`·`:974` (lock/unlock/저장 인가 라우트가 `x-edit-client` 헤더에서 clientId를 읽는다)
- **결정 주체**: 0-mvp 커밋 `00aa92c`(2026-06-17) "편집 잠금을 탭(clientId) 단위로 — 같은 계정 다른 세션/탭 차단 + 재로그인 takeover".
  **시간 순서(정정)**: 원래의 (news.md와 일치하던) sessionId 기반 잠금이 먼저 있었고, phase 1-security-hardening(커밋 `6819805`/`d2d44bc`, 2026-06-15)이 세션 쿠키를 **브라우저의 모든 탭이 공유**하게 만들면서 "한 세션 = 한 페이지/탭"이라는 암묵 전제가 깨졌다. 이틀 뒤 `00aa92c`가 그에 반응해 보유자 키를 (userId, clientId)로 재정의했다.
- **news.md만 믿으면**: 잠금 신원을 (user, sessionId)로 구현한다. 그러면 (a) 실제 판별자가 **매 lock/save/unlock 호출에 실려 가는 클라이언트 생성 탭 id**라는 것과, (b) 같은 사용자의 재로그인이 차단이 아니라 **의도된 takeover 경로**라는 것을 둘 다 놓친다.

<a id="l133"></a>
### L133 · L136 — `no-conflict` · low — 30분 stale 잠금 · 강제 해제 D/Z

- **확인 결과**: 두 값 모두 정확히 일치한다. `LOCK_TTL_MS = 30 * 60 * 1000`이고 `isStale()`이 그 값으로 판정한다. `POST /api/articles/:id/force-unlock`은 role D 또는 Z만 통과시킨다.
- **근거**: `src/services/articleService.js:14-15`·`:55-60` · `server/index.js:982-990` (role 검사 `:986`)

<a id="l135"></a>
### L135 — `partial` · medium — "브라우저(탭)가 닫힐 때는 해제 요청을 보내 잠금을 해제한다."

- **현재 사실**: 해제 요청은 `pagehide`/`beforeunload`에서 **평범한(keepalive 아닌) fetch**로 나가며 **창이 실제로 닫힐 때 도달 보장이 없다** — 이 사실이 실측으로 문서화돼 있다. 그래서 실제 복구 수단은 **30분 stale TTL**과 **D/Z 강제 해제**다.
- **근거**: `phases/62-client-exe/step1.md:22` ("편집 잠금 해제는 `pagehide`/`beforeunload`에서 **평범한 fetch**로 나간다(keepalive 아님 — 창 닫기 시 도달 보장 없음)") · `docs/api-contract/openapi.yaml:1324` ("보유자와 무관하게 잠금을 푼다(편집자가 브라우저를 닫아 잠금이 30분 남는 상황의 운영 수단)")
- **결정 주체**: phase 62-client-exe D-6 실측 + 기존 30분 TTL / D·Z 강제 해제 설계(0-mvp)
- **news.md만 믿으면**: 창 닫힘 해제를 신뢰 가능한 메커니즘으로 보고 그 위에 UX를 쌓는다. 보장되는 것은 **30분 만료와 강제 해제**뿐이다.

<a id="l142"></a>
### L142 — `silent-gap` · medium — "로그인은 15분 동안 같은 IP에서 10회까지만 시도할 수 있다."

- **현재 사실**: news.md에 없는 **두 번째 독립 잠금 축**이 있다 — 같은 userId에 대한 **5회 실패 시 그 계정을 15분 잠근다**(`lockedUntil`). IP나 전역 15분/10회 제한과 **무관한 별도 카운터**이고, 응답은 일반 401(invalid-credentials)이 아니라 **HTTP 423 + `reason:'locked'`** 이며, 잠긴 동안은 **올바른 비밀번호도 거부**된다.
- **근거**: `src/services/userService.js:14-15` (`LOCKOUT_THRESHOLD=5` · `LOCKOUT_DURATION_MS=15*60*1000`) · `:43-79` (`login()`이 정답 인정 전에 `isLocked()` 확인 · `registerFailure()`가 임계치에서 `lockedUntil` 설정) · `server/index.js:609-614` (IP `loginLimiter` 15분/10회) · `:627-630` (`reason==='locked'` → `res.status(423)`)
- **결정 주체**: 0-mvp / security 브랜치("lockout dual-options" 정본 결정)
- **news.md만 믿으면**: IP 제한만 만들고 계정 자체 잠금을 놓친다. 로그인 흐름이 '계정 잠김' / 'IP 제한' / '비밀번호 오류'를 구분하지 못한다.

<a id="l156"></a>
### L156-159 — `override` · **high** — "## SQLite Store Procedure 명세서" (기사 아이디 생성 SP)

- **현재 사실**: **시스템 어디에도 SQLite 저장 프로시저가 없다**(SQLite에 SP 기능 자체가 없다). ID 생성 규칙 자체(`'AKR' + YYYYMMDD + 난수 9자리`, 충돌 시 난수 재생성)는 **정확히 보존**돼 있으나, DB 측 절차 로직이 아니라 서비스 계층에서 호출하는 **평범한 앱 계층 JS 함수**로 구현돼 있다.
- **근거**: `src/db/articleId.js:1-16` (파일 주석 1행이 'SQLite Store Procedure 명세'를 인용하면서 순수 JS로 구현 — Article·Contents 양쪽 유일성 검사 후 재생성 루프) · `src/services/articleService.js:148` (`generateArticleId(db)` 호출) · `docs/ADR.md:15-18` (ADR-002 — `node:sqlite` + 직접 SQL, ORM/DB 측 로직 없음, 정합성은 애플리케이션이 유지)
- **결정 주체**: ADR-002(아키텍처) + 사실 제약(SQLite는 SP를 지원한 적이 없다)
- **news.md만 믿으면**: 호출하거나 재구현할 DB 객체(프로시저/트리거)를 찾다가 아무것도 못 찾는다. **평범한 함수**로 이식해야 한다.

<a id="l164"></a>
### L164 — `override` · **high** — "상단 메뉴바 밑에는 글씨체, 글씨크기, 새문서, 불러오기, 저장하기, 인쇄, 인쇄미리보기, 찾기/바꾸기, 맞춤범검사, 약물입력, 약어변환, 표 삽입, 그림삽입, 유튜브영상 삽입, 메모장이 있다."

- **현재 사실**: 툴바는 **글꼴 select + 글자크기 select 2개만** 렌더한다. 나머지 13개는 비활성 placeholder 버튼으로 만들어졌다가 **의도적으로 제거**됐다(2026-07-07 사용자 요청). 게다가 툴바 자체가 **기본 숨김**이고 우클릭 컨텍스트 메뉴의 **'툴바 보이기'(`ctx.showToolBar`)** 로만 켠다. 제거된 기능은 여전히 메뉴바(파일/편집/도구)·컨텍스트 메뉴·단축키로 접근 가능하다.
- **근거**: `web/src/view/EditorToolBar.jsx:1-10` (주석 "구 기능 버튼군(…)은 사용자 요청으로 제거됨(2026-07-07)" · `TOOLBAR_FONTS`/`TOOLBAR_SIZES`만) · `web/src/view/EditorContextMenu.jsx:22` (`ctx.showToolBar` 토글)
- **결정 주체**: 사용자 요청 2026-07-07(코드 주석에 기록)
- **news.md만 믿으면**: 메뉴바 아래 항상 보이는 15버튼 툴바를 만든다. 실제 제품과 시각·기능 모두 어긋나고 메뉴바/컨텍스트 메뉴/단축키에 이미 있는 기능을 중복 노출한다.

<a id="l169"></a>
### L169 — `partial` · medium — "클립보드에서 복사하여 붙여넣기한 이미지/유투브 크기는 … 가로*세로=17%*17% … 사진/영상 figure 폭도 1.7배=612px, 기사 참조 카드는 480px 유지"

- **현재 사실**: 퍼센트 크기(`widthPercent:17`/`heightPercent:17`)는 임베드 블록에 **저장만 되고 렌더러가 읽지 않는 비활성 메타데이터**다. 실제 렌더는 **이미지: 비율 유지 + 최대 200×200px 캡, `<figure>`는 `fit-content`**(612px도, 에디터 폭의 17%도 아니다)다 — 이 200×200 캡은 phase 4-mvp-polish에서 온 것으로 news.md의 17%/1.7배 문구보다 선행한다. 고정 px 부분 중 맞는 것은 **유튜브 영상(612px figure)** 과 **기사 참조 카드(480px)** 뿐이다.
- **근거**: `web/src/view/InlineEmbed.jsx:3` ("이미지: 제품 결정대로 비율 유지·최대 200×200으로 캡하고 figure는 캡된 이미지에 맞춘다(612px 미예약)") · `:29-30` (`maxWidth/maxHeight 200px`) · `:93-100` (이미지는 `fit-content`, 영상 612px, 기사 카드 480px) · `web/src/view/clipboardEmbed.js:6-11` (`EMBED_SIZE`) · `:77-88` (`makeImageEmbed`가 퍼센트를 저장) · `phases/4-mvp-polish/step3.md:3`·`:29` ("Ctrl+V 이미지 붙여넣기(200×200)")
- **결정 주체**: phase 4-mvp-polish(제품 결정, ADR 번호 없음) — news.md의 퍼센트 문구가 나중에 수정될 때 재검토되지 않았다.
- **news.md만 믿으면**: 붙여넣기 이미지를 에디터 폭 기준 반응형 17%로 계산하고 612px figure를 예약한다. 실제 제품은 에디터 크기와 무관하게 작은 고정 상한(200×200) 썸네일이다.

<a id="l174"></a>
### L174 — `override` · **high** — "Alt+Y를 누르면 브라우저 맞춤법 검사가 켜진다(spellcheck=true, lang=ko)."

- **현재 사실**: **브라우저 SPA에서는 여전히 참이다** — `insertEnd()`가 `setSpell(true)`를 호출해 에디터 DOM의 `spellcheck=true`를 만든다(기본값 false). 그러나 **Electron 데스크톱 클라이언트(`client/`)에서는 무효**다: 원격 SPA를 로드하는 모든 `APP_WINDOW`가 **Chromium/BrowserWindow 수준에서 `webPreferences.spellcheck:false`** 로 생성되며 이는 확정 결정으로 기록돼 있다. Chromium 수준 `spellcheck:false`는 그 렌더러의 네이티브 맞춤법을 통째로 끄므로, 페이지가 DOM 속성을 무엇으로 하든 **셸에서는 빨간 밑줄이 나오지 않는다.**
- **근거**: `client/lib/windowPolicy.js:15-17` (주석 — "spellcheck:false는 확정 결정(decisions (13)): Chromium 맞춤법 검사는 사전 다운로드 등 앱 밖 통신을 유발할 수 있어 ADR-008(egress 0)·폐쇄망 배치와 맞지 않는다. 맞춤법은 SPA 자체 메뉴(phase 30)가 담당") · `:18-28` (`baseWebPreferences()` — `spellcheck: false`) · `web/src/view/WriterPage.jsx:580-584` (`insertEnd()` → `setSpell(true)`) · `web/src/view/Editor.jsx:388`(prop 기본 false)·`:391`(lang)·`:675`(`spellCheck={spellcheck}`)
- **결정 주체**: ADR-011(Electron 접속형 셸, egress-0/폐쇄망) + `windowPolicy.js`의 in-code 'decisions (13)'
- **news.md만 믿으면**: Alt+Y로 OS/Qt 네이티브 맞춤법을 켜고 빨간 밑줄 피드백을 기대하는 데스크톱 클라이언트를 만든다. 실제 제품은 **데스크톱 셸에서 네이티브 맞춤법을 의도적으로 억제**하고 SPA 자체의 규칙 기반 맞춤법 엔진(`editorSpell.js` · 맞춤법 메뉴)에만 의존한다. **Qt 네이티브 맞춤법을 배선하면 안 된다.**

<a id="l184"></a>
### L184-190 — `no-conflict` · low — 기사 상단 메뉴바 7개 메뉴

- **확인 결과**: `EditorMenuBar.jsx`의 `EDITOR_MENUS`가 7개 메뉴와 모든 항목을 **같은 순서·같은 표시 단축키(Alt+Y, Ctrl+Y)로 그대로** 재현한다(코드 주석이 "news.md 그대로"라고 밝힌다). 항목의 활성/placeholder 구분은 `enabledIds`로만 하고 라벨을 바꾸지 않는다 — 포터는 **L184-190을 메뉴 구조의 정본으로 그대로 써도 된다.**
- **근거**: `web/src/view/EditorMenuBar.jsx:8-112` (`EDITOR_MENUS`)

<a id="l201"></a>
### L201 — `silent-gap` · medium — "입력모드 : KSC-5601모드 설정, Unicode 모드 설정"

- **현재 사실**: news.md는 효과를 적지 않은 일반 환경설정 항목처럼 열거하지만, 구현에서 이 설정의 효과는 **정확히 하나**다 — 에디터 상태표시줄의 **'Byte' 수치를 계산하는 근사식**(EUC-KR 블록 범위 근사 vs UTF-8 `TextEncoder`)을 고른다. 입력·검증·저장·전송 방식은 **전혀 바꾸지 않는다**(저장/전송은 항상 UTF-8). 환경설정의 '언어' 항목과도 **완전 독립**임이 명시돼 있다.
- **근거**: `web/src/view/editorEncoding.js:1-6` (파일 주석 — "상태표시줄 Byte 표시용 … 환경설정 '언어'(라벨/lang 속성 전용)와는 완전 독립") · `:32-35` (`normalizeInputMode`) · `:37-53` (`euckrStats`) · `web/src/view/WriterPage.jsx:346`·`:349`·`:1689` (`inputMode`가 `<StatusBar inputMode=…>`에만 결선)
- **결정 주체**: 실측(구현이 정한 것 — ADR도, news.md의 범위 서술도 없다)
- **news.md만 믿으면**: 'KSC-5601 모드'를 실제 입력 제한이나 저장 인코딩 스위치로 만든다(비-KSC 문자 거부/변환, EUC-KR 저장). 실제 기능은 **상태표시줄 카운터의 계산식**일 뿐이며, 진짜 인코딩 스위치로 구현하면 항상 UTF-8인 백엔드/계약과 호환성이 깨진다.

<a id="l225"></a>
### L225 — `partial` · low — "작성자는 로그인한 사용자 정보의 이름을 입력한다."

> 원자료가 L226으로 적었던 항목이다. **실제 줄 번호는 225**다(226은 빈 줄).

- **현재 사실**: 이것은 **새 빈 작성 탭의 1회성 기본값**으로만 참이다(`blankFields`/`blankTab`이 로그인 사용자 이름으로 시드). 이후 필드는 자유롭게 편집 가능하고 신원에 묶인 읽기전용이 아니다. **기존 기사를 열면 작성자 필드는 그 기사에 저장된 `author` 값**으로 채워진다(`fieldsFromArticle`: `article.author ?? fallbackAuthor`) — 지금 보는 사람이 아니라 원래 쓴 사람이고, 편집/저장해도 현재 사용자로 재동기화되지 않는다.
- **근거**: `web/src/controller/useWriteController.js:90-92` (주석 "author는 로그인 사용자 이름으로 미리 채운다(신규 작성 시 작성자 미입력 방지)") · `:100-107` (`fieldsFromArticle`) · `:110-117` (`blankTab`) · `web/src/view/WriterPage.jsx:2018-2019` (author input — `readOnly`는 모드 플래그이지 신원 기반 잠금이 아니다)
- **결정 주체**: 구현(`useWriteController.js` 설계, ADR 없음)
- **news.md만 믿으면**: 작성자를 현재 세션 신원의 파생 표시(저장/로드마다 재계산)로 잠근다. 그러면 다른 사용자가 기존 기사를 열어 재저장할 때 **원 작성자 기록을 조용히 덮어쓴다** — DB 비파괴 규율과도 어긋난다.

<a id="l228"></a>
### L228-233 — `partial` · low — "기사를 DB Article, Contents 테이블에 입력하는 API, articleInsert 있다." 외 5줄 (articleUpdate / articleSelect / User 테이블 3종)

> 원자료가 L227-233으로 적었던 항목이다. **인용된 본문은 228-233**이다(227은 절 표제 `## API 명세서`).

- **현재 사실**: 이 줄들은 레거시 작명 템플릿을 쓴다(User 테이블 줄까지 전부 "기사를"로 시작하는데 이는 스펙 작성 아티팩트이지 '기사를 User 테이블에 넣는' 연산이 아니다). `articleInsert`/`articleUpdate`/`articleSelect`라는 이름의 RPC API는 **구현된 적이 없다.** 실제는 동결 REST 계약이다: `POST /api/articles` · `PUT /api/articles/:id` · `GET /api/articles/:id`·`/api/articles`·`/api/articles/search` · `POST/PUT/GET /api/users`.
- **근거**: `docs/api-contract/endpoints.json` (39 라우트 — `articles-create`/`articles-update`/`articles-get`/`articles-list`/`articles-search`/`users-list`/`users-create`/`users-update`) · `src/**`·`server/**`·`docs/api-contract/**` 전체 grep에서 `articleInsert`/`articleUpdate`/`articleSelect` **0건**
- **결정 주체**: ADR-001의 REST 규약에서 파생. **단, ADR-001이 이 RPC 작명을 명시적으로 폐기한다고 적지는 않았다** — REST 동사+경로가 이를 대체했다는 것은 합리적이지만 **암묵적 추론**이다.
- **news.md만 믿으면**: 저 이름의 함수를 찾다가 못 찾는다. 매핑은 **동결 계약의 REST 동사+경로**로 해야 한다. (참고: OpenAPI에는 `ArticleUpdateRequest`/`ArticleUpdateResponse`라는 **DTO 타입 이름**이 있으나(`openapi.yaml:321`·`356`) 이는 news.md가 말하는 엔드포인트/함수 이름이 아니다.)

<a id="l239"></a>
### L239 — `silent-gap` · medium — "편집 잠금을 획득/해제/강제해제하는 API가 있다 (/api/articles/:id/lock, /unlock, /force-unlock)."

> 원자료가 L238로 적었던 항목이다. **실제 줄 번호는 239**다(238은 `PUT /api/articles/:id`).

- **현재 사실**: news.md는 세 엔드포인트의 **존재만** 적고 구현이 강제하는 의미론은 하나도 적지 않는다. 실제 규칙은 넷이다. **(a)** 잠금은 세션 단위가 아니라 **탭 단위**(`x-edit-client`)다 — 같은 탭은 재획득 가능(F5), 같은 사용자의 새 세션은 takeover, **같은 세션의 다른 탭은 차단**, 다른 사용자는 차단. **(b)** 잠금은 30분 무갱신이면 **stale**로 만료되어 재획득 가능해진다. **(c)** 강제 해제는 **D와 Z 전용**이고 R은 라우트에서 직접 **403**을 받는다(일반 `editDps` 게이트 경유가 아니다). **(d)** 해제는 **멱등**이다(이미 해제된 기사를 해제해도 `ok:true`).
- **근거**: `src/services/articleService.js:383-412` (a 규칙 · `isStale`) · `:55-60` (`isStale` 30분) · `:427` (멱등 반환) · `server/index.js:982-991` (force-unlock — `me.role !== 'D' && me.role !== 'Z'` → 403, 검사는 `:986`) · `docs/api-contract/endpoints.json:268-277` (articles-force-unlock `roles:['D','Z']` · notes "R은 403 FORBIDDEN(라우트 직접)") · `:259-266` (articles-unlock — "이미 해제된 잠금 해제는 멱등 200")
- **결정 주체**: 실측 / phase 0-mvp 설계 + 이후 하드닝(단일 ADR 없음 — 동결 계약 행동으로 고정)
- **news.md만 믿으면**: 탭 신원 모델도, stale 타임아웃도, D/Z만 강제 해제 가능하다는 것도 모른 채 잠금 UX를 만든다. 셋 다 올바른 동시 편집 동작의 하중을 받는 규칙이다.

<a id="l249"></a>
### L249 (참조 L245 · L256-257) — `no-conflict` · low — "기사의 상태값이 DPS일 때는 D 권한 사용자만 고침/포털고침 메뉴를 사용할 수 있다."

- **확인 결과**: 정확히 그대로 유효하다. 포터가 의심할 만한 부분까지 확인했다 — **Z(관리자)도 명시적으로 제외**된다(R만이 아니다). `CAPABILITIES.editDps`는 `['D']` 하나뿐이고, 동결 계약의 articles-lock 주석이 이를 못 박는다: "DPS 기사는 D 전용(editDps — Z 포함 비 D는 403 forbidden)". 즉 **Z의 광범위한 관리 권한이 송고된(DPS) 기사 편집에는 미치지 않는다.**
- **근거**: `src/services/authorization.js:12` (`editDps: ['D']`) · `:27-40` (`editDps()` — status가 DPS일 때만 역할 게이트 적용, 아니면 `not-dps`) · `docs/api-contract/endpoints.json:257`

<a id="l254"></a>
### L254 — `silent-gap` · medium — "기사의 정보들(ContentsVO.md)이 매핑되어 보여준다." **(§10 Q7)**

> 원자료가 L252로 적었던 항목이다. **실제 줄 번호는 254**다.

- **현재 사실**: **`ContentsVO.md`라는 파일은 리포 어디에도 없다**(`find -iname 'ContentsVO*'` 0건). news.md가 독자를 보내는 Contents 필드 집합은 현재 **`docs/SCHEMA.md`의 `## Contents Table` 절**이 대신 문서화한다 — 그 절 첫 줄이 스스로 **"ContentsVO에 대한 명세서"** 라고 밝힌다.
- **근거**: 리포 전역 `find -iname "ContentsVO*"` → 0건 · `docs/SCHEMA.md:42-43` (`## Contents Table` / "ContentsVO에 대한 명세서") · `:45` (필드 15종) · `:46` (잠금 컬럼 4종) · `:47` (공통정보 컬럼 8종) · `docs/porting-plan-cpp-spring.md:223` (P4 선행 조건으로 이미 표시됨)
- **결정 주체**: 실측(리포에 체크인된 적이 없는 파일)
- **news.md만 믿으면**: 존재하지 않는 문서를 찾는다. **`docs/SCHEMA.md`의 Contents Table 절로 리다이렉트**해야 필드 매핑을 찾을 수 있다.
- **심각도 하향(정정)**: 원자료는 high였으나 **medium으로 내렸다.** news.md가 필드에 대해 침묵하는 것이 아니기 때문이다 — 바로 다음 줄 **L255**가 읽기전용 ContentsVO 필드(기사아이디·수정자·송고자·부서·부서코드·작성시간·편집시간·송고시간)를 **인라인으로 열거**한다. 즉 실질 공백은 '내용 부재'가 아니라 **죽은 파일 참조**다. 상세는 [§5](#q7)를 보라.

<a id="l301"></a>
### L301 — `override` · **high** — "CORS는 개발 클라이언트(localhost:5173)만 허용한다."

- **현재 사실**: CORS는 고정 단일 출처가 아니라 **런타임 허용목록**이다: 비프로덕션에서는 `DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173','http://127.0.0.1:5173']`에 `env.ALLOWED_ORIGINS`(콤마 구분)를 합치고, **프로덕션에서는 기본값이 없다** — `ALLOWED_ORIGINS`를 명시하지 않으면 자기 출처가 아닌 모든 쓰기가 거부된다. 그리고 더 중요한 것: **실제 프로덕션 방어층은 CORS가 아니다.** ADR-009가 상태 변경 메서드 전체에 **독립적인 Origin/Referer 허용목록 검증**(CSRF 방어)을 추가했다 — 쿠키가 `SameSite=None; Secure`일 때 CORS는 simple request의 **실행**을 막지 못하기 때문이다.
- **근거**: `server/index.js:83` (`DEFAULT_ALLOWED_ORIGINS`) · `:92-99` (`allowedOrigins()` — 프로덕션은 env만, 비프로덕션은 기본값+env) · `:105-116` (`logOriginDiagnostics` — 프로덕션 허용목록이 비면 경고) · `docs/ADR.md:50-54` (ADR-009 — `csrfOriginGuard` 전역 미들웨어 · 403 `forbidden-origin` · 허용목록을 CORS와 **단일 출처로 공유**)
- **결정 주체**: ADR-009(CSRF Origin/Referer 허용목록) + phase 60(동일 출처 서빙 / `ALLOWED_ORIGINS` 메커니즘)
- **news.md만 믿으면**: 고정 허용 출처 하나를 하드코딩하거나 동등한 검사를 아예 뺀다. 프로덕션에 기본 출처가 없다는 것과, **CORS가 아니라 Origin/Referer 검사가 진짜 CSRF 방어선**이라는 것을 놓친다 — Qt 클라이언트의 HTTP 호출이 만족시켜야 하는 조건이다.

<a id="l302"></a>
### L302 — `partial` · medium — "사용자 생성/수정/삭제는 권한 Z만 할 수 있다."

- **현재 사실**: **생성·수정의 Z 전용 게이트는 정확하다.** 그러나 **'삭제'는 API도 UI도 없다** — `DELETE /api/users/:id`가 존재하지 않는다(`/api/users`에 GET/POST/PUT만). 사용자 비활성화는 `PUT .../users/:id`에 `{active:'N'}`으로 하며(배부 대상 비활성화와 같은 소프트 패턴) 행 삭제는 하지 않는다.
- **근거**: `server/index.js:654` (GET) · `:667` (POST) · `:676` (PUT) — delete 라우트 없음 · `docs/api-contract/endpoints.json:40-66` (users-list/create/update만) · `web/src/view/UserMgmtPage.jsx:115-116` (활성 select) — 파일 전체에 삭제 버튼/핸들러 없음
- **결정 주체**: SCHEMA.md / 프로젝트 전역 DB 비파괴 규칙(단일 ADR 번호 없음)
- **news.md만 믿으면**: Qt 관리 패널에 '사용자 삭제' 메뉴를 만든다 — 호출할 서버 엔드포인트가 없다. 올바른 기능은 update 엔드포인트를 통한 `active` 'Y'/'N' 토글이다.

---

<a id="q7"></a>
## 5. Q7 답 — `ContentsVO.md`

계획서 §10 Q7("`ContentsVO.md`가 리포에 부재 — 원본 확보 필요")에 대한 답이다.

**`ContentsVO.md`는 리포에 없다.** 리포 전역 `find -iname "ContentsVO*"`가 0건이다. 체크인된 적이 없다.

**그 명세를 대신하는 것은 세 곳이고, 셋을 합치면 현재 필요한 정보가 전부 나온다.**

1. **필드 정의 — `docs/SCHEMA.md`의 `## Contents Table` 절(L42-53).**
   그 절은 스스로 **"ContentsVO에 대한 명세서"**(L43)라고 선언한다. 내용은 기본 필드 15종(L45: articleId · title · content · author · modifier · sender · department · departmentCode · createdAt · editedAt · sentAt · distributedAt · embargoAt · secondEmbargoAt · status) + 편집 잠금 컬럼 4종(L46) + 공통정보 컬럼 8종(L47) + 시간/상태값/기사아이디 규칙(L48-52)이다.
2. **편집 페이지 매핑 규칙 — `docs/news.md:254-255`.**
   L255가 어떤 필드가 입력란에 채워지고(제목/본문내용/작성자/엠바고 시간/2차 엠바고 시간) 어떤 필드가 **읽기전용으로 표시**되는지(기사아이디·수정자·송고자·부서·부서코드·작성시간·편집시간·송고시간) 직접 열거한다.
3. **응답 투영(무엇이 실제로 나가는가) — 동결 계약.**
   `docs/api-contract/endpoints.json`(39 라우트)과 `contract/**`가 소유한다. **주의**: 잠금 컬럼 중 `lockerSessionId`·`lockerClientId`는 **응답에서 제거된다**([L131](#l131a)) — 스키마에 있다고 해서 와이어에 있는 것이 아니다.

**원본 `ContentsVO.md`가 나타나면 이 셋과 대조하라.** 셋 중 어느 것과도 어긋나는 항목이 있으면 그것은 새 오버라이드 후보이며, 이 문서에 항목을 추가하고 판정 근거를 남겨야 한다. 계획서가 요구한 '원본 확보'는 **해소 조건이 아니라 대조 대상의 획득**이다 — 위 셋으로 P4를 착수할 수 있다.

---

## 6. 경계 — 이 문서가 하지 않는 것

1. **스펙을 바꾸지 않는다.** `docs/news.md` 본문은 한 글자도 수정하지 않았다(1행 제목 줄에 이 문서를 가리키는 한 문장만 덧붙였다 — 본문 줄은 추가·삭제·이동이 전혀 없어 줄 번호 우주가 원문과 동일하다). 원문 보존이 이 리포의 규율이다. 여기 적힌 판정은 원문을 **덮어쓰는 읽기 규칙**이지 원문의 개정이 아니다.
2. **미구현 백로그 목록이 아니다.** 여기 있는 항목은 전부 "**지금 그렇게 동작한다**"이지 "나중에 이렇게 할 것이다"가 아니다. 남은 작업 목록은 `phases/**`와 계획서 §10이 소유한다.
3. **여기 없는 줄이 '검증됐다'는 뜻이 아니다.** 스윕 범위는 302행 전부지만 **판정은 근거가 있는 것만** 실었다. 표에 없는 줄은 "현재 구현과 다르다는 근거를 찾지 못했다"이지 "코드와 일치함을 확인했다"가 아니다. 확인된 일치는 `no-conflict` 5건뿐이다.
4. **와이어 계약의 정본이 아니다.** 요청/응답 shape·상태코드·필드는 `docs/api-contract/endpoints.json`·`openapi.yaml`·`contract/**`가 소유한다. 이 문서는 **news.md를 읽는 방법**만 소유한다. 둘이 어긋나면 **동결 계약이 이긴다.**
5. **자동 갱신되지 않는다.** 기준 커밋은 `b53c083`이다. 이후 코드가 바뀌면 항목이 낡을 수 있다 — 특히 P3 컷오버가 실행되면 [L6](#l6)·[L8](#l8)의 "아직 실행되지 않았다"는 문장이 바뀐다.

---

## 7. 부록 — 인용 검증 결과

이 문서를 쓰면서 원자료(6구간 병렬 스윕 + 2중 검증)의 인용을 **전건 재확인**했다.

- **news.md 줄 번호 대조**: 44행 전건을 `sed`로 원문 확인(기준 = `b53c083` 원문 · 제목 줄 안내는 줄을 밀지 않으므로 현재 파일과 같은 번호다). **41건 일치 · 3건 정정** — L226→**225**(작성자) · L238→**239**(잠금 API) · L252→**254**(ContentsVO). 추가로 절 표제를 포함하던 범위 1건을 조정했다(L227-233 → **228-233**).
- **`file:line` 인용**: 전건 직접 열람. **확인 44 · 정정 14 · 미확인 0.** 정정은 전부 **좌표 이동**이고 실체 주장이 뒤집힌 것은 없다. 주요 정정:
  - `docs/ADR.md:28` → **:27** (ADR-004 '매 요청 재도출' 문장)
  - `docs/ADR.md:34`/`:44` → **:33**/**:43** (ADR-005 · ADR-007 트레이드오프)
  - `docs/ADR.md:71` → **:71-72** (ADR-013 결정 본문은 72행) · `:87` → **:87-88**(ADR-016 결정 ①②③은 88행)
  - ADR-017 인용문에서 원자료가 덧붙인 "두 결정은…" 접두는 **원문에 없다** → 삭제(정확한 문장은 `docs/ADR.md:97` ③).
  - `server/index.js:586-588` → **:587-588** · `:616-624` → **:609-614·627-630**(423 매핑은 630) · `:981-989` → **:982-991**(역할 검사 986)
  - `endpoints.json:241-267` → **:241-277**(force-unlock은 268-277)
  - `WriterPage.jsx:1694-1712` → **:1696-1712**(1694는 주석) · `articleModel.js:151-156` → **:150-156**
  - `phases/51-security-hotfix/step0.md`의 인용 순서(36 ↔ 46) 교정, 그리고 **살아있는 코드 근거**(`src/services/contentsProjection.js:16-18`)를 추가했다.
  - `phases/0-mvp/step12.md` → 정확한 좌표는 **:25** · `phases/3-mapping/step0.md` → **:18**(+ `step1.md:57` 추가)
- **원자료와 달라진 판정 4건**
  1. **[L254](#l254) 심각도 high → medium.** news.md L255가 ContentsVO 필드를 인라인으로 열거하므로 공백의 실체는 '내용 부재'가 아니라 **죽은 파일 참조**다. (§3 요약에는 P4 선행 조건이라 그대로 싣는다.)
  2. **[L91](#l91) 범위 축소.** 엠바고 관리 메뉴에 편집 항목이 있다는 사실 자체는 news.md **L264·L266**에 있다. 문서 공백은 나머지 4개 읽기전용 항목의 구성·순서다(KILL기사 메뉴는 여전히 완전 공백).
  3. **[L50-52](#l50) 결정 주체 교체.** 원자료의 "ADR 없음" → **ADR-014**(`docs/ADR.md:77-81`)가 데모 폴백을 명시 결정한다. `mediaSearch.js:1`의 'ADR-005' 자기 인용은 ADR-014가 지적한 **오귀속**이다.
  4. **[L249](#l249) 앵커 이동.** 원자료는 이 no-conflict 항목을 L257(참조 245)에 걸었으나, 규칙 자체가 적힌 줄은 **L249**다. 줄 번호 오름차순 대조에서 실제로 마주치는 위치로 옮겼다(참조로 245·256-257 유지).
- **[L76](#l76) 검증 이견 1표**를 항목 본문에 명시했다(78표 중 유일한 비유지 표).
