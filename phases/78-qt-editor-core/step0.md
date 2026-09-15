# Step 0: adr-editor-core

**목표**: P5 에디터 코어의 횡단 결정을 **ADR-019**로 명문화한다(코드 0줄). 뒤 step들이 각자 다른 전제로 움직이지 않도록, 직렬화 키순서·위젯 툴킷·임베드 이월·마커 병합 가드 발산·초안 저장 백엔드·정렬 근사·오프셋 계약을 durable하게 고정한다.

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` — 이 phase의 규칙 정본(§0~§10). ADR-019는 이 스펙의 결정을 요약·서명한다.
- `docs/ADR.md` — 특히 ADR-018(`:101-107`, 네이티브 클라 아키텍처)·ADR-008(`:45-47`, 배부 egress/타이머 금지 축)·ADR-003/004/005 승계. **ADR-018 본문은 소급 수정 금지**(ADR-014 규율) — ADR-019는 순수 추가.
- `docs/porting-plan-cpp-spring.md:182` — P5 완료 게이트(순수 모듈 green + IME/캐럿 체크리스트) · `:106-121` 에디터 리스크·이식 자산.
- `spikes/p0-qt-editor/editorwidget.h`·`editorlogic.h` — 위젯 툴킷 실증(QPlainTextEdit + QSyntaxHighlighter · preedit 문서 미삽입).
- `client-qt/README.md:1170-1213` — P5 착수 인계 사실.

## 작업
1. `docs/ADR.md` 말미에 **ADR-019**를 **순수 추가**한다(기존 ADR 본문 무수정). 제목 예: `ADR-019: P5 에디터 코어 — markupVersion 바이트 패리티(QJsonObject 금지)·QPlainTextEdit 위젯 축·'(끝)' 마커 병합 가드 발산·주입형 초안 저장`.
2. 본문에 **결정(D1~D8)** 을 `index.json`의 `decisions` 8항과 **동일하게** 서명하고, 각 결정의 근거를 웹 `파일:행`으로 인용한다(port-spec.md에서 가져옴).
3. **트레이드오프** 절에 미검증 축을 정직하게 적는다: (a) QCollator 정렬 순서가 웹 ICU와 다를 수 있음(D2 · step5 관측 전 미확인), (b) IME/캐럿은 실기 육안 판정이라 이 머신 밖일 수 있음, (c) 임베드 verbatim 보존은 P6에서 순서 보존 모델로 승격 필요.
4. ADR-019 번호·제목이 오케스트레이터 승인 대상임을 `index.json` open_questions (4)와 연결(문서에 각주).
5. 코드·`.pro`·테스트를 **한 파일도** 만들지 않는다.

## Acceptance Criteria
```bash
cd /home/user/harness
# ADR-019가 추가되고 ADR-018 이하 기존 본문은 무변(순수 추가)
git diff --stat docs/ADR.md          # docs/ADR.md만 변경, insertions only
git diff -U0 docs/ADR.md | grep -c '^-[^-]'   # 삭제 줄 0 (기존 ADR 무수정)
grep -c 'ADR-019' docs/ADR.md        # >= 1
# 코드/빌드/테스트 무변
git status --porcelain -- client-qt   # 무출력
```

## 검증 절차
1. `git diff -U0 docs/ADR.md`의 삭제 줄이 0인지 육안 확인(순수 추가).
2. ADR-019의 D1~D8이 `phases/78-qt-editor-core/index.json`의 `decisions`와 1:1 대응하는지 대조.
3. 인용한 웹 `파일:행`이 실재하는지 표본 확인(`editorContent.js:52`·`WriterPage.jsx:1327-1328`·`SCHEMA.md:53` 등).

## 금지사항
- 코드/`.pro`/테스트/`client-qt/**`를 만들거나 고치지 마라. 이유: 이 step은 결정을 굳히는 문서 게이트다. 코드를 섞으면 리뷰가 결정과 구현을 분리 검토할 수 없다.
- ADR-018을 포함한 기존 ADR 본문을 고치지 마라. 이유: 각 ADR은 그 시점의 결정 기록이고 소급 수정은 이력을 오염시킨다(ADR-014).
- `docs/news.md`·`docs/porting-plan-cpp-spring.md`를 고치지 마라. 이유: 요구사항/로드맵 정본은 이 phase가 바꾸지 않는다.
