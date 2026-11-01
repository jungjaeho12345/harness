# Step 1: block-model

에디터 본문 블록 모델(yh-editor v1)을 `client-qt/src/editor/`에 이식한다. 본문 직렬화/역직렬화·`END_MARKER`·레거시 평문 로드가 여기 산다. 이 모델이 이후 색상·마커 가드·단축키·undo·저장의 공통 기반이다.

## 읽어야 할 파일
- `phases/78-editor-core/index.json` — decisions (1)(2) · excluded (a).
- `web/src/view/editorContent.js` — **이식 원본**. `EDITOR_FORMAT='yh-editor'` · `EDITOR_VERSION=1` · `END_MARKER='(끝)'` · `ALIGN_VALUES=['left','center','right','justify']` · `isValidAlign` · 블록 타입 `{type:'text',text[,align]}`/`{type:'embed',embedType,...}` · `blocksToText`/`textBlock`/`isTextBlock`/`isEmbedBlock`/`normalizeBlocks` · 직렬화 `{format,version,blocks}` · 레거시 평문 역호환 로드.
- `web/src/view/editorContent.test.js` — **명세서(회귀 케이스 원천)**.
- `src/services/` 의 본문 저장 포맷(백엔드와 동일 `{format:'yh-editor',version:1,blocks:[]}` — `docs/api-contract` 부수 계약 「본문 직렬화」와 대조).
- step0 산출물 `client-qt/src/editor/editorroles.*`(`END_MARKER` 재사용 — 리터럴 중복 금지, 단일 출처 공유).

## 작업
1. `client-qt/src/editor/editorcontent.h`/`.cpp` 신설. 블록을 C++ 값 타입으로 모델링: `struct TextBlock{ QString text; QString align; }` · `struct EmbedBlock{ QString embedType; ... }` 또는 `variant`/태그 유니온. 순수(위젯·transport 비의존).
2. 시그니처(웹 1:1): `QString blocksToText(const QVector<Block>&)` · `QVector<Block> textToBlocks(const QString&)`(역직렬화) · `QString serialize(const QVector<Block>&)`(→ `{format,version,blocks}` JSON) · `QVector<Block> deserialize(const QString& json)`(레거시 평문 포함 역호환) · `bool isValidAlign(const QString&)` · `QVector<Block> normalizeBlocks(const QVector<Block>&)`.
3. **`END_MARKER`는 step0 모듈과 단일 출처를 공유**(리터럴 두 번 적지 마라 — phase 77 divergence 감사 교훈).
4. **CRITICAL 불변식(웹 주석 승계)**: 본문은 항상 블록 구조로 다룬다(평문으로만 저장 금지). 직렬화 결과의 `format`/`version`은 백엔드와 바이트 동일해야 한다(계약). 역직렬화는 입력을 mutate하지 않는다.
5. QtTest(`editorcontenttest`): `editorContent.test.js`의 케이스를 옮긴다(직렬화 왕복·레거시 평문 로드·align 화이트리스트·정규화). TDD red 먼저.

## Acceptance Criteria
- `cmd.exe /c "client-qt\build.bat"` → exit 0 · 신규 클래스 함수만큼 Totals 증가 · 0 failed.
- `node scripts/verify-qt-client.mjs --scenario boot --server exe` → exit 0.
- `git status --porcelain` 이 `client-qt/src/editor/**`·`client-qt/common.pri`·`client-qt/tests/**`·`phases/78-editor-core/**` 밖 무변.

## 검증 절차
1. 직렬화 왕복 라운드트립 테스트가 웹 `editorContent.test.js`의 대응 케이스와 동일 입출력임을 확인.
2. 우회 변이 2종(`version` 상수 변경 → 계약 불일치 · 레거시 평문 로드 경로 제거)으로 red 실증 후 원복(소스 diff).
3. 무접촉 경로 diff 0.

## 금지사항
- 본문을 평문 문자열로만 저장/취급하지 마라. 이유: 블록 구조가 news.md/schema.md 계약이며, 임베드·정렬 정보가 소실되면 저장이 손상된다.
- 직렬화 `format`/`version`을 임의로 바꾸지 마라. 이유: 서버(동결 계약)가 그 바이트를 파싱한다 — 다르면 저장이 거부되거나 조용히 손상된다.
- 역직렬화에서 본문을 정규화·재해석하지 마라(입력 mutate 금지). 이유: 동일-body 판정(undo)이 어긋나 헛 스냅샷이 생긴다.
