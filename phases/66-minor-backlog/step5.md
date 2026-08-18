# Step 5: closeout

코드 변경 없이 **합쳐진 HEAD에서 전체 게이트를 재실증**하고 phase를 마감한다. 이 step은 `phases/**`와 `docs/ADR.md`의 ADR-011 1문장만 수정한다.

## 읽어야 할 파일

- `phases/66-minor-backlog/index.json` — scope 전체·decisions **(20)(21)(22)**·excluded·open_questions, 그리고 step0~4의 summary(마감 기록의 원재료)
- `phases/66-minor-backlog/step0.md` ~ `step4.md` — 각 step이 무엇을 잠갔는지(요약 문장을 지어내지 말고 실제 산출물과 대조하라)
- `phases/index.json` — 최상위 phase 목록. **65-instance-lock 항목의 형식**(dir · status · completed_at · note 한 덩어리)을 그대로 따른다
- `phases/65-instance-lock/index.json` — 마감 기록(summary·forward_notes) 서술 수준의 본보기
- `CLAUDE.md` — 커밋 규칙

## 배경

- 이 phase는 서로 독립인 5개 하자를 5개 모듈에서 고쳤다. 각 step이 자기 스위트를 돌렸지만, **합쳐진 HEAD에서 전체 게이트가 2회 연속 green인지**는 아무도 확인하지 않았다.
- `npm run test:web`은 드물게 1건이 비고정으로 실패하고 재실행하면 green이다(알려진 flake). 그래서 판정은 **2회 실행**으로 한다 — 1회차 실패는 회귀로 단정하지 말고, 실패한 파일/케이스 이름을 기록한 뒤 재실행 결과로 판정한다.
- 이 phase에는 새 모듈·새 아키텍처 계층·새 운영 절차가 없어 문서 변경은 **ADR-011 결정문 1문장 보강 하나뿐**이다(ARCHITECTURE·README·기타 ADR은 무수정). 그 1문장이 필요한 이유: step4가 저장값의 **출처**를 바꿨다 — ADR-011 결정문은 지금 "서버 주소는 최초 실행 시 셸 로컬 화면에서 입력받아 `GET /api/health`의 본문 `{ ok:true }`까지 확인한 뒤에만 설정 파일에 저장한다"고만 적혀 있어, **저장되는 값이 사용자가 입력한 주소**라고 읽힌다. 이제는 리다이렉트를 따라간 **최종 origin**이 저장되며 이것은 운영자에게 보이는 계약 변경이다(설정 화면 표시·재시작 안내·secure-origin 스위치 대상이 함께 움직인다).
- 계획 산출물(`phases/66-minor-backlog/**`)은 **실행 전에 오케스트레이터가 계획 커밋으로 먼저 올린다**(전례: phase 65 계획 커밋 baf91d3). 그래서 아래 범위 정합 목록에 그 디렉토리 전체가 나타나는 것이 정상이다.

## 작업

1. **전체 게이트 재실증** — 아래 AC를 순서대로 돌리고 **관측값**(통과 수·소요·실패 후 재실행 결과)을 요약에 기록한다. 추측·반올림 금지.
2. **기준선 대비 증감 확인** — 백엔드 1310 → step4가 더한 만큼, web 2368 → step0~3이 더한 만큼. 감소가 있으면 **마감하지 말고** 원인을 규명해 보고하라(테스트 삭제·skip은 이 phase에서 발생하면 안 된다).
3. **범위 정합 확인** — 이 phase 전체 diff(브랜치 분기점 대비)가 아래 파일들로만 이뤄졌는지 확인한다:
   - `web/src/view/editorEditOps.js` · `editorEditOps.test.js`
   - `web/src/view/editorContent.js` · `editorContent.test.js`
   - `web/src/view/editorSelect.js` · `editorSelect.test.js`
   - `web/src/view/WriterPage.jsx` · `WriterPage.test.jsx`
   - `client/lib/serverUrl.js` · `client/main.js` · `test/client-probe-origin.test.js`
   - `docs/ADR.md`(이 step의 ADR-011 1문장 보강 — 아래 작업 5)
   - `phases/66-minor-backlog/**`(계획 커밋 포함) · `phases/index.json`
   그 밖의 파일이 **커밋에 들어가 있으면** 그 자체가 사고다 — 되돌리지 말고 보고하라. 반면 사용자 소유 미커밋 파일(계획 시점 관측: `.claude/skills/**` · `docs/news.md` · `packaging/체크리스트-육안확인.md` · `phases/49-mini-backlog-cleanup/step0.md` · `phases/50-hygiene-cleanup/` — **실행 중에 더 늘 수 있다**)이 작업 트리에 남아 있는 것은 정상이다. 판정은 커밋된 diff 기준으로 하고, 미커밋 파일에는 손대지 마라.
4. **DB·데이터 무접촉 확인** — 이 phase의 코드·테스트에 리포 `news.db` 연결이나 `uploads/` 쓰기가 없다는 사실을 확인한다(변경 파일 목록 기준의 근거 한 줄로 충분하다 — 서버를 띄우지 마라).
5. **ADR-011 결정문 1문장 보강**(`docs/ADR.md` — 이 phase의 유일한 문서 변경):
   - ADR-011 **결정** 문단에서 서버 주소 저장을 설명하는 문장 **하나만** 손댄다. 담을 사실 2개: (i) 확인 요청이 리다이렉트로 다른 출처에 도달하면 **최종 origin**이 저장·표시되고 그 값이 재시작 안내·secure-origin 스위치 대상이 된다 (ii) 확인 실패거나 최종 URL이 비정상(파싱 불가·http/https 밖·자격증명 포함)이면 **승격하지 않고 사용자가 입력한 주소를 유지**한다(fail-safe).
   - **이유·트레이드오프 문단과 다른 ADR·다른 문장은 건드리지 마라.** 기존 문장을 재작성하지 말고 사실을 덧붙이는 방향으로 최소 편집한다(phase 65 step4의 "추가 위주·기존 문장 재작성 0" 규율).
   - 문서와 코드가 어긋나지 않는지 확인하라: 실제 구현(step4)이 승격을 거부하는 조건과 문서 문장이 일치해야 한다. 어긋나면 문서를 코드에 맞추지 말고 **불일치 자체를 보고**하라(코드가 계획과 다르게 구현됐다는 신호다).
6. **phase 마감 기록**:
   - `phases/66-minor-backlog/index.json`에 step0~4 summary가 전부 채워졌는지 확인하고, `forward_notes` 배열을 새로 쓴다. 최소 4항목: (i) 이 phase가 소진한 백로그(감사 minor 잔여 5건과 그 출처) (ii) **Electron 실왕복 미검증**(step4 — 가정은 표준 fetch로 실측, 실제 경로는 net.fetch) 같은 남은 불확실성 (iii) 기각 3건(동일-탭 캐럿 stale=not_a_defect · 빈 줄 삭제 시 임베드 동반 삭제=not_a_defect · 매핑 dead-click=already_fixed)과 phase 64·65에서 이월된 제외 항목이 그대로 남아 있다는 사실 (iv) **사용자 가시 동작 변화 1줄: "탭(문서)을 바꾸면 열려 있던 도구 창(다이얼로그)이 모두 닫힌다"** — 지금까지 일부만 닫히던 것이 전부로 넓어졌다(찾기/바꾸기 패널은 예외로 유지).
   - `phases/index.json`의 `66-minor-backlog` 항목(계획 커밋에 이미 들어 있다)을 완료로 갱신한다: status를 completed로, `completed_at`을 추가하고, note 앞에 65 항목과 같은 형식의 `[완료 …]` 기록(step별 실측 요약·최종 게이트 수치·미검증 항목)을 덧붙인다. 기존 계획 서술은 지우지 말고 뒤에 그대로 남긴다.
7. **요약 보고 문구 준비** — 오케스트레이터가 Slack에 그대로 옮길 수 있게, 사용자 관점 변화를 각 한 줄로 정리한다: 문단 정렬 오변이 차단 · 손상 본문 유실 방지 · 하이라이트 줄 단어 선택 복구 · 도구 창 겹침 해소 · 리다이렉트 서버 주소 정정. 여기에 **동작이 달라지는 항목 1줄을 반드시 포함**한다 — "탭(문서)을 바꾸면 열려 있던 도구 창이 모두 닫힌다(찾기/바꾸기 패널은 그대로 남는다)". 사용자가 '왜 창이 사라졌지?'라고 느낄 수 있는 유일한 변화라 보고에서 빠지면 안 된다.

## Acceptance Criteria

```bash
npm test
npm run test:web
npm run test:web
npm run lint
npm run build
git status --porcelain
git diff --stat feat-0-mvp...HEAD
```

## 검증 절차

1. AC를 순서대로 전부 실행한다. `npm run test:web`은 **2회 연속** 돌려 둘 다 green인지 본다(1회차 실패 시 실패 케이스 이름을 기록하고 2회 더 돌려 판정 — 3회 중 2회 이상 같은 케이스가 실패하면 flake가 아니라 회귀다).
2. `npm run build`가 clean인지 확인한다(web 빌드 산출물은 `.gitignore` 대상이라 diff에 나타나지 않아야 한다).
3. 작업 3의 범위 정합을 `git diff --stat`으로 확인하고, 파일 목록을 요약에 그대로 붙인다(이 step에서 더해지는 `docs/ADR.md` 1문장과 `phases/**`도 목록에 나타나는 것이 정상이다).
4. `phases/index.json`이 유효한 JSON인지 확인한다(파싱 1회 — 손상되면 이후 모든 phase 도구가 죽는다).
5. `phases/66-minor-backlog/index.json`의 step5 status·summary를 갱신한다. summary에는 최종 수치(백엔드/web 통과 수·lint·build)와 2회 연속 green 여부, 미검증 항목을 남긴다.

## 금지사항

- 코드·테스트 파일을 이 step에서 수정하지 마라(`web/**`·`client/**`·`test/**`·`src/**`·`server/**`). 이유: 마감 step이 코드를 만지면 그 변경만 게이트를 통과하지 못한 채 커밋된다 — 문제가 발견되면 해당 step으로 돌려보내는 것이 절차다.
- 실패한 테스트를 skip·삭제하거나 기대값을 낮춰 green을 만들지 마라. 이유: 이 phase의 절반이 데이터 유실·오변이 방지이며, 그 잠금을 푸는 순간 phase의 목적이 사라진다.
- `docs/**`는 **ADR-011 결정문 1문장 외에는 수정하지 마라**(ARCHITECTURE·README·다른 ADR·ADR-011의 이유/트레이드오프 문단 포함). 이유: 이 phase는 새 모듈·새 계층·새 운영 절차를 만들지 않았고, 바뀐 사실은 '저장되는 서버 주소의 출처' 하나뿐이다 — 그 밖의 문서 손질은 리뷰 범위를 흐린다. 특히 `docs/news.md`는 사용자 미커밋 수정이 있는 무접촉 파일이다(열지도 마라).
- 사용자 미커밋 파일(`.claude/skills/**` · `phases/49-mini-backlog-cleanup/step0.md` · `phases/50-hygiene-cleanup/**` · `docs/news.md` · `packaging/체크리스트-육안확인.md`, 그리고 **실행 중 새로 나타난 것 전부**)을 add·restore·checkout·stash·clean 하지 마라. 이유: 사용자 소유 작업물(육안 검증 기록 포함)이며 커밋에 섞이거나 되돌아가면 복구가 어렵다.
- `git add -A`·`git add .`를 쓰지 마라. 이유: 위 미커밋 파일이 그대로 쓸려 들어간다 — 명시 경로만 스테이징한다.
- 서버를 띄우거나 배포물(exe)을 재조립하지 마라. 이유: 이 phase는 서버·배포 파이프라인을 한 줄도 바꾸지 않았다 — 재실증할 대상이 없고 실행 자체가 데이터 접촉 위험만 만든다.
- 미검증 항목을 "검증됨"으로 적지 마라. 이유: step4의 Electron 실왕복은 이 환경에서 수단이 없다 — 정직한 unverified 기록이 이 리포의 관행이다.
