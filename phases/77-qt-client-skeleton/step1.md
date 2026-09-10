# Step 1: adr-qt-client

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `decisions` **(1)~(13) 전문** · `excluded` · `open_questions`
- `docs/ADR.md` — **ADR-003**(주입 가능한 Model) · **ADR-004**(신뢰 경계·매 요청 신원 재도출) · **ADR-005**(SSE 무효화 스트림) · **ADR-008**(배부 egress 0 · 앱 타이머 0) · **ADR-011**(Electron 접속형 셸의 계약) · **ADR-013**(두 서버 공존) · **ADR-017**(P3 전환 아키텍처 — 형식과 문체의 본보기). **현재 마지막 번호는 ADR-017이다 → 신설 번호는 ADR-018.**
- `docs/news-md-overrides.md` — §3(high 13건) · L6 · L8 · L22 · L80 · L123-128 · L131 · L131-132·154 · L174 · L301
- `docs/porting-plan-cpp-spring.md` — §6.2(144~171행 셸 계약 처분 표) · §7 P4 행 · §10 열린 질문
- `phases/77-qt-client-skeleton/step0.md`와 **step0이 남긴 요약**(빌드가 `subdirs`로 섰는지 폴백인지 — ADR 본문의 「빌드」 문단이 그 실측을 인용한다)

## 배경

이 phase의 코드는 전부 **한 묶음의 결정**에서 나온다. 결정이 먼저 고정되지 않으면 뒤 step들이 각자 다른 전제로 움직인다 — 73(ADR-014를 step2 선행 조건으로)·74(ADR-015를 step0으로)·76(ADR-017을 step1로)의 선례와 같은 이유다.

특히 **틀리면 되돌리기 비싼 것이 셋**이다: ① 「탭」의 네이티브 대응물(잘못 잡으면 P5·P7의 잠금 UX 전체와 서버 동시성 계약이 어긋난다) ② 자동 검증 수단(CDP가 없는 자리를 무엇이 메우는가 — 잘못 고르면 P4~P8 전 구간이 육안 검증으로 퇴화한다) ③ 리포 배치·빌드(모듈 경로가 굳으면 이후 phase가 전부 그 위에 선다).

**이 step은 코드를 0줄 쓴다.**

## 작업

`docs/ADR.md` 맨 끝에 **ADR-018을 순수 추가**한다(기존 텍스트 한 줄도 수정·삭제 금지). 표제는 결정을 한 문장으로 요약하고, 본문은 **결정 / 이유 / 트레이드오프** 3문단 구성(기존 ADR과 동형).

결정은 다섯이며, 각각 **좌표(파일:행)를 인용**한다. 인용은 **직접 열어 확인한 것만** 적는다.

1. **리포 배치·빌드·산출물** — `client-qt/`(선례: `server-spring/` = 역할-기술) · qmake + nmake · `spikes/p0-qt-editor/build.bat` 레시피 복제(VsDevCmd 고장 우회) · ASCII 타깃 이름 · 빌드 산출물 비커밋 · **windeployqt·패키징은 P8**. step0이 실증한 사실(subdirs 성부)을 인용한다.
2. **자동 검증** — diag JSONL 계약 승계(`CLIENT_DIAG_FILE` · `{ts,event,...}` · 금지 키 7종 · URL 리댁션 — `client/diag.js` 좌표 인용) + 새 드라이버 `scripts/verify-qt-client.mjs`(두 축 교차: 클라의 diag와 서버 측 사실) + **`scripts/verify-integration.mjs`·`verify-client.mjs` 무수정**(CDP는 Electron 전용 · P8까지 회귀 기준) + 순수 판정부 자기검사를 드라이버가 돌린다(`test/harness-vacuity-guards.test.js`가 고아를 red로 만든다).
3. **「탭」의 네이티브 대응물** — **편집 표면 1개 = clientId 1개**. 프로세스당·세션당 금지와 그 **구체적 붕괴 시나리오**(같은 기사를 두 표면으로 열면 서버가 '같은 탭 재획득'으로 판정해 둘 다 PUT 가능)를 본문에 적는다. 부착 라우트는 **정확히 3개**. 근거는 `docs/news-md-overrides.md` L131-132·154 · L239.
4. **net 계층의 계약 준수 판정** — 정적(라우트 표 ↔ `docs/api-contract/endpoints.json` 39행 대조 · 클라 금지 2행) + 동적(`net-request` diag 원장) 두 겹. **`contract/**`를 겨누지 않는 이유**(서버 판정용 JS 러너이며 동결 자산이다)와 **이 판정이 보증하지 않는 것**(요청 body shape 전수 일치)을 함께 적는다.
5. **P4의 경계** — 에디터(P5)·조회 6메뉴/우클릭/관리 화면(P7)·인쇄/i18n/환경설정(P6)·패키징(P8) 제외. 화면은 **로그인·목록·서버 주소 설정 3개뿐**이고 그 인벤토리를 테스트가 잠근다.

**결정 2에 반드시 포함할 문장(② 검토 반영 · `open_questions` (8) 확정)**: 자동 검증은 **`CLIENT_SELFTEST=1`일 때만 동작하는 시나리오 훅**으로 UI를 몬다. 그리고 그 가드의 성격을 **정직하게** 적는다 — **보안 경계가 아니라 사고 방지 장치다**(누구나 환경변수를 켤 수 있다). 「가드가 있으니 안전하다」로 적지 마라. 함께 적을 것: 자격은 **하네스가 env로 주입**하고 앱은 보관·기억·기록하지 않는다 · **컴파일 타임 분리**(프로덕션 빌드에서 훅 코드를 제거)는 **P8로 이월**한다.

추가로 본문에 **명문화할 규율 셋**(결정 문단 안이나 트레이드오프에):
- **신원·권한 캐시 금지**(ADR-004 승계 · override L123-128) — 로그인 응답 role은 표시용, 인가는 서버 판정을 따른다.
- **SSE는 단일 무효화 신호 + 전체 재조회, `unauthorized`면 재연결 영구 중단**(ADR-005 승계 · override L80).
- **세션 쿠키를 디스크에 쓰지 않는다**(`client/lib/clientConfig.js` 머리 CRITICAL 승계) → 재시작 시 재로그인이라는 **divergence**를 정직하게 적는다.

**소멸 항목도 적는다**(§6.2 처분 표 승계): secure-origin 스위치 전체 · 권한 핸들러 2종 · preload/contextBridge·sender 검증 · resources/app 위생 게이트 — 네이티브에는 대응물이 없다. **없어진 것을 흉내 내지 마라.**

## Acceptance Criteria

```
git diff --stat docs/ADR.md
node -e "const t=require('fs').readFileSync('docs/ADR.md','utf8');const i=t.indexOf('### ADR-018');if(i<0){console.error('ADR-018 missing');process.exit(1)};console.log('ok',t.length)"
npm test
npm run lint
npm run build
cmd /c client-qt\build.bat
```
- `docs/ADR.md`는 **추가만** 되어야 한다: `git diff -U0 docs/ADR.md`의 삭제(`-`) 줄이 **0**이어야 한다(파일 머리 `---` 등 문맥 줄 제외 — 실제 삭제 0을 확인하라).
- `npm test`·`lint`·`build`·`client-qt\build.bat` 전부 step0 수치 그대로(코드 0줄 변경이므로 **반드시** 무회귀).

## 검증 절차

1. `git diff -U0 docs/ADR.md | findstr /R "^-" `로 삭제 줄이 없음을 확인한다(`core.autocrlf`로 워킹 트리가 CRLF이므로 접두사 비교 대신 **`-U0` 삭제 줄 계수**를 쓴다 — 74가 같은 함정을 겪었다).
2. ADR-018이 인용한 **모든 좌표를 다시 열어** 실제로 그 줄에 그 내용이 있는지 확인한다. 어긋나면 좌표를 고친다(주장 자체가 바뀌면 결정을 다시 생각한다).
3. **미확인을 구분해 적는다**: 확인하지 못한 값은 결정으로 굳히지 말고 **조건절**로 남긴다(ADR-017 ④의 규율 — 빈칸을 추측으로 채우는 것이 가장 흔한 사고 경로다).

## 되돌림

`docs/ADR.md`의 추가분만 지우면 원상 복구다(다른 파일을 건드리지 않았다).

## 금지사항

- **ADR-001~017 본문을 고치지 마라.** 이유: 각 문장은 그 시점의 결정·실측 기록이고 소급 수정은 이력을 오염시킨다(ADR-014가 확립한 규율).
- **코드를 쓰지 마라.** 이유: 이 step은 결정 고정이다. 코드가 섞이면 「결정이 먼저」라는 순서의 이점이 사라진다.
- **확인하지 않은 좌표를 인용하지 마라.** 이유: 틀린 좌표는 하류 step 전체를 잘못된 정본으로 보낸다.
- **`docs/news.md`를 고치지 마라.** 이유: 고객 원본 스펙이고 이 리포는 원문을 보존한다(오버라이드는 대장이 소유한다).
