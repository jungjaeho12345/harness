# Step 16: closeout

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — 전체(scope·decisions·excluded·open_questions·steps summary)
- `phases/77-qt-client-skeleton/index.json` — `forward_notes` 형식(13항 · 마감 실측 전문·미검증·이월·divergence·환경 함정)
- `client-qt/README.md` — P4 마감 장 형식(이 step이 P5 장 추가)
- `docs/ADR.md` ADR-019 — 마감 실측 1문단 추가 대상

## 배경

문서·마감 step이다. 코드는 새로 만들지 않고 **기존 게이트 무회귀**가 AC다. P4 마감 규율 승계: 마감 실측 2회(수치 전건 동일 · flake 0) · 미검증 정직 기록 · P6 인계.

## 작업

1. **마감 실측(연속 2회 · 수치 전건 기록)**: `client-qt\build.bat`(QtTest 총계 — step2~15 누적) · 세 시나리오 두 모드 · `npm test` · lint · build · `spring-contract --parity` · `spa-parity` · `spool-parity` · 자산 지문(`news.db` md5·`uploads/`) · 무접촉 diff 0.
2. **`client-qt/README.md` P5 장**: `src/editor/` 모듈 이식 현황 표(파일 ↔ 정본 웹 파일 ↔ 케이스 수 실측) · 텍스트 엔진 위젯 구조 · 마커 이중 기준 규율 · **IME/캐럿 육안 체크리스트**(step15 · 실행 결과) · **무엇이 기계로 판정되고 무엇이 육안인가** · P6 착수 지점.
3. **`docs/ADR.md` ADR-019에 마감 실측 1문단**(순수 추가 · 삭제 0행).
4. **`forward_notes` 작성**(P4 형식): 마감 실측 전문 · P5→P6 인계(임베드·맞춤법·찾기바꾸기 다이얼로그·표·인쇄·환경설정 UI·서버 자동저장 결선 · 편집 표면 lock 라우트 결선) · **미검증 목록**(editorSelect DOM 케이스 처분 · IME 실물 육안 결과 · 서버 자동저장 미결선 · 성능 축) · divergence(웹/Electron 대비) · 변이 결과표 소재 · 환경 함정.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario boot --server exe
node scripts/verify-qt-client.mjs --scenario login --server exe
node scripts/verify-qt-client.mjs --scenario list --server exe
node scripts/verify-qt-client.mjs --scenario list --server spring
npm test
npm run lint
npm run build
git status --porcelain
```
- 전 커맨드 exit 0(연속 2회 동일) · QtTest 총계가 **정본 순수 370 케이스 이상 + 위젯/게이트 오프스크린 케이스** 반영 · 실패 0.
- P4 게이트(시나리오·npm test·lint·build·parity) 무회귀 · 무접촉 diff 0 · `news.db` md5 무변.
- `client-qt/README.md` P5 장 · ADR-019 마감 문단 · `forward_notes`가 존재한다.

## 검증 절차

1. 마감 실측 A·B 두 회차 수치를 요약에 전건 적고 flake 0을 확인한다.
2. **12개 순수 step의 이식 케이스 수 합계**를 요약에 정리하고 정본 370과 대조한다(누락 내역 포함 · decisions (12)).
3. **미검증을 미검증으로** 남긴다(IME 실물 육안·editorSelect·서버 자동저장 — 「됐다」로 위장 금지).

## 금지사항

- **새 기능·모듈을 여기서 만들지 마라.** 이유: 마감·문서 step이다. 기능이 남았으면 앞 step으로 되돌린다.
- **미검증을 검증으로 위장하지 마라.** 이유: 다음 감사에서 회귀와 구분되지 않는다.
- **`docs/ADR.md` 기존 내용을 수정·삭제하지 마라.** 이유: 순수 추가 1문단만.
- **`client-qt/src/net|shell|ui/**`·`web/**`·계약·`packaging/**`를 고치지 마라.**
