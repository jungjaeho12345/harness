# Step 10: closeout

문서·마감. ADR 순수 추가(새 결정이 있으면)·README 에디터 장·**IME·캐럿 육안 체크리스트**·마감 실측 2회·forward_notes. 코드 변경 없음(무회귀가 AC).

## 읽어야 할 파일
- `phases/78-editor-core/index.json` 전문(scope·decisions·excluded·open_questions·order).
- `phases/77-qt-client-skeleton/index.json` `forward_notes` — 마감 형식 본보기(실측 표·미검증·divergence·이월).
- `client-qt/README.md` — 「P4 마감」 장 형식(에디터 장을 같은 형식으로 추가).
- `docs/ADR.md` — ADR 순수 추가 형식(삭제 0줄 · 기존 텍스트 접두사 유지).
- `packaging/체크리스트-육안확인.md`·`-P3.md` — 육안 체크리스트 형식 본보기(**무수정 — 형식만 참고**).
- step0~9 산출물 전부.

## 작업
1. **마감 실측 2회 연속**(build.bat · verify-qt-client 4시나리오 boot/login/list/edit × exe|spring · npm test · lint · build · parity 3종 · news.db md5). 두 회차 수치 동일(flake 0)을 표로 기록. 인계·이전 값과 어긋나면 그 사실부터.
2. **ADR 순수 추가**(에디터 결정이 새로우면 — 예: 텍스트 엔진 기반 위젯 선택·IME 무개입 규율·표면 수명 모델). 기존 ADR 텍스트 삭제 0줄. 새 결정이 P4 ADR-018 승계로 충분하면 신설하지 않는다(그 판단을 요약에 적는다).
3. **README 에디터 장**: 빌드에 편입된 에디터 모듈 현황 표 · 마커 게이트 단일 지점 · **무엇이 기계로 판정되고 무엇이 육안인가** · 미검증 목록 · divergence.
4. **IME·캐럿 육안 체크리스트**(로드맵 P5 AC (2)): 실물 MS-IME로 한글 조합 중 캐럿 튐 0 · 조합 중 단축키 미개입 · commit 후 색 재적용 · 마커 뒤 입력 차단 실기 · undo/redo 체감 · 자동저장/복구 실기. 각 항목 pass/fail 기록(사람 판정).
5. **forward_notes**: 마감 실측 전문 · 미검증(P6/P7/P8로 넘기는 것) · divergence · 이월(P6 임베드/맞춤법/찾기/표/인쇄/정렬/환경설정 · P7 관리화면·우클릭 · P8 패키징) · 다음 phase 후보(P6 에디터 확장) · 환경 함정.

## Acceptance Criteria
- `cmd.exe /c "client-qt\build.bat"` → exit 0 · 0 failed(코드 무변 재확인).
- `node scripts/verify-qt-client.mjs --scenario edit --server exe`·`--server spring` → 각 exit 0.
- `node scripts/verify-qt-client.mjs --scenario boot|login|list --server exe` → 각 exit 0.
- `npm test`·`npm run lint`·`npm run build` → 각 exit 0(무회귀).
- `git status --porcelain` 이 `docs/ADR.md`·`client-qt/README.md`·`phases/78-editor-core/**` 밖 무변.
- 리포 `news.db` md5 무변.

## 검증 절차
1. 마감 실측 2회 수치 동일 확인.
2. ADR 순수 추가면 `git diff`로 삭제 0줄 확인(core.autocrlf 때문에 접두사 비교 불가면 대체 판정 기록).
3. 육안 체크리스트를 실물 IME로 1회 수행하고 각 항목 결과 기록(green 조작 금지 — fail이면 fail로).

## 금지사항
- 코드를 고치지 마라(문서 전용 step). 이유: 구현은 step0~9에서 끝났다 — 마감에서 코드를 만지면 게이트가 흐려진다.
- ADR 기존 텍스트를 수정·삭제하지 마라. 이유: ADR는 순수 추가만(결정 이력 보존).
- 육안 체크리스트를 「통과했다」로 지어 쓰지 마라. 이유: IME·캐럿은 사람만 판정할 수 있는 축이다 — 실제 수행 결과만 적는다.
- 미검증을 숨기지 마라. 이유: 조용한 공백은 다음 감사에서 회귀와 구분되지 않는다(정직한 forward_notes가 하네스 문화).
