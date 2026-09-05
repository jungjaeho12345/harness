# step0 — 기준선 재측정 · 시작 스냅샷 · 변이 결과표

> 이 파일은 **phase 76 의 측정 원장**이다. 뒤 step 들은 diff scope 를 아래 「시작 스냅샷」 대비 **증분**으로만
> 판정한다(절대 목록 비교 금지 · `restore`/`checkout`/`stash`/`clean` 금지).
> 운영측 조사 결과와 사용자 실행 항목은 **`docs/cutover-p3.md` §0·§0-1·§0-2** 가 소유한다.

## A. 시작 스냅샷 (2026-09-05 · step0 착수 시점)

- 브랜치 **`feat-76-spring-cutover`** · HEAD **`ff649bb`**(계획 커밋) · base **`048654f`**(PR #122 머지) — `git merge-base HEAD feat-0-mvp` 로 확인.
- `git status --porcelain` — **타 세션 산출물 4종뿐**(무접촉·`git add` 금지):

```
 M .claude/skills/claude-code-test-harness/SKILL.md
 M docs/UI_GUIDE.md
?? system-diagram-fixed.html
?? system-diagram-fixed.svg
```

- step0 이 더하는 것은 `?? docs/cutover-p3.md` 와 `phases/76-spring-cutover/**` 뿐이다.

## B. 기준선 재측정 — **연속 2회**

**전부 이 트리에서 직접 잰 값이다**(75 forward_notes 의 인용이 아니다). 인계값과 다른 줄은 ⚠ 로 표시했다.

| # | 커맨드 | 인계값(계획서 baseline ①~⑤) | 1회차 실측 | 2회차 실측 |
|---|---|---|---|---|
| 1 | `cd server-spring && ./mvnw -B clean verify` | 1472 / 0 / 0 / Skipped 0 | **Tests run: 1472, Failures: 0, Errors: 0, Skipped: 0** · BUILD SUCCESS · 5:48 | **동일 · 1472 / 0 / 0 / 0** · BUILD SUCCESS · 5:45 |
| 2 | `cd tools/news-migrator && ./mvnw -B clean verify` | 107 / 0 | **Tests run: 107, Failures: 0, Errors: 0, Skipped: 0** · BUILD SUCCESS · 38.9 s | **동일 · 107 / 0 / 0 / 0** · BUILD SUCCESS · 38.2 s |
| 3 | `node scripts/spring-contract.mjs --parity` | 313관측 diffs 0 | **exit 0 · profiles=5 · 313관측 diffs 0**(default 246 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3) | **동일 · exit 0 · 313관측 diffs 0**(같은 분할) |
| 4 | `… --db mysql --parity` | 313관측 diffs 0 | **exit 0 · 313관측 diffs 0**(같은 분할) | **동일 · exit 0 · 313관측 diffs 0** |
| 5 | `… --db mysql --require-full-coverage` | 39/39 · 미커버 0 | **exit 0 · 합산 관측 313 · covered 39/39 · 미커버 쌍 0** | **동일 · covered 39/39 · 미커버 쌍 0** |
| 6 | `node scripts/contract-inventory-check.mjs --require-spec-paths` | routes=39 · spec-paths 39/39 | **exit 0 · routes=39 · GET:16,POST:19,PUT:3,DELETE:1 · spec-paths=39/39** | **동일 · exit 0 · routes=39 · spec-paths=39/39** |
| 7 | `npm test` | 1328 pass / 0 fail | **exit 0 · tests 1328 · pass 1328 · fail 0 · skipped 0 · suites 51 · 25.0 s** | **동일 · 1328 pass / 0 fail / 0 skip** · 24.6 s |
| 8 | `npm run lint` | exit 0 | **exit 0**(무출력) | **exit 0** |
| 9 | `npm run build` | exit 0 | **exit 0 · 2.34 s · 산출물 파일명·크기 무변**(아래 지문) | **exit 0 · 파일명·크기·md5 전부 동일** |

**연속 2회 전건 동일 — flake 0.** 그리고 `--db mysql` 실행은 매번 **`⚠ NEWS_CT_MYSQL_PASSWORD 가 최소 길이(8자)
규정에 못 미친다`** 경고 1줄을 stderr 로 내며 정상 진행한다(사용자 실행 항목 U2 · 값도 길이도 로그에 실리지 않는다).
실행 뒤 **잔존 `harness_ct_*` DB 0개**(`SHOW DATABASES LIKE 'harness\_ct\_%'` 를 `news_ct` 자격으로 실측 — 사람 몫의 확인이다).

**⚠ 인계값과 다른 것 — 1건**: `tools/news-migrator/target/news-migrator.jar` 가 **21,855,292 B** 로,
계획서가 적은 **21,855,280 B** 보다 **12 B 크다**. 테스트 수(107)·내용 게이트는 전부 같고 차이는 **재빌드마다 달라지는
아카이브 메타데이터**다(같은 소스에서 `clean verify` 를 다시 돌린 산출물이다). ⇒ **jar 바이트 수를 무회귀 판정에 쓰지 마라.**
`server-spring` jar 는 **38,405,479 B** 로 계획서 값과 일치했다(우연이다 — 같은 이유로 이 값도 판정 기준이 아니다).

## C. 자산 지문 (2026-09-05)

| 자산 | 값 |
|---|---|
| 리포 `news.db` | **606,208 B · md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967`** — 하네스·Java·npm 실행 **전후 모두 동일**(3회 측정) |
| 리포 `uploads/` | **32파일 · 6,068,792 B** |
| `web/dist` | **3파일 · 444,543 B** — `index.html` 413 B md5 `473de6653fa156dc06f9ff4994b0b132` · `assets/index-COYNfnZU.js` 415,058 B md5 `8ae6fc215f856096133303c0d6bae318` · `assets/index-CXiUPvTY.css` 29,072 B md5 `bd8260f3e92df61e0db440a2ac567603` |
| `web/dist` 재현성 | `npm run build` **재실행 후 파일명·크기·md5 전부 동일** ⇒ step3 의 바이트 대조는 **고정된 산출물** 위에서 돈다 |
| `server-spring` jar | 38,405,479 B(위 ⚠ 참조 — 판정 기준 아님) |
| `news-migrator` jar | 21,855,292 B(〃) |
| `dist/` exe 2종 | `dist/기사작성기-server/기사작성기-server.exe` **94,298,112 B** · `dist/기사작성기/기사작성기.exe` **225,866,240 B** — 둘 다 실재(step4 가 요구하는 자산) |
| 개발 배포 폴더 | `dist/기사작성기-server/` 에 `web/`(index.html 413 B) · `data/`(news.db 606,208 B · uploads 2파일 · **빈** `dist-spool`·`rcv-spool`) · bat 은 **리포 템플릿과 바이트 동일**(2,941 B) |

## D. 무접촉 확인

`git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json docs/news.md spikes` → **무출력**(2회 확인: 측정 전·후).

## E. 변이 결과표

**변이 0건 — 이 step 은 게이트를 만들지 않는다.** 이 step 의 산출물은 문서 2개(`docs/cutover-p3.md` ·
이 파일)이고 실행되는 코드·정적 게이트를 한 줄도 추가하지 않았다. 따라서 심을 우회가 없다.
게이트를 만드는 step(2·3·5·6)이 각각 **최소 2종의 우회 변이**를 심어 red 를 보고 원복하며, 그 표를
자기 step 의 종료 조건으로 기록한다(decisions (12)).

## F. 이 step 이 새로 잡은 실행 함정 (다음 step 이 그대로 밟는다)

1. **`server-spring` 의 `mvnw verify` 는 MySQL 자격 없이는 통과하지 않는다.** 자격 없이 돌린 첫 실행은
   **Tests run 1424 · Failures 1 · Errors 28 · BUILD FAILURE**(4:49)였다 — **회귀가 아니라 실행 형태 오류**다.
   정확한 형태는 `docs/ops-mysql.md` §3 「`mvnw verify` 를 돌리는 정확한 형태」다:
   env 9키를 **한 줄씩** 싣고 → `NEWS_DB_*` 의 **값**을 `NEWS_APP_MYSQL_*` 로 옮긴 뒤 → **`NEWS_DB_*` 이름을 unset** 한다
   (그 이름이 남으면 `DB_KIND` 없이 mysql URL 만 남아 **모든 `@SpringBootTest` 가 기동을 거부**한다 — 설계된 거부).
2. **`. loadenv.sh` 는 호출자의 위치 인자를 상속한다.** 그 스크립트는 `$1` 을 env 파일 경로로 읽으므로,
   `run-xxx.sh a1` 처럼 라벨 인자를 받은 스크립트 안에서 인자 없이 source 하면 **`a1` 이라는 파일을 열려다 실패**하고
   자격이 **조용히 빈 값**이 된다(그 상태로 maven 이 그대로 돌아 5분을 버린다). **항상 경로를 명시해 source 하고,
   실행 직전에 키 하나를 비어 있음 검사**하라(이 step 의 러너가 그렇게 한다).
3. **`cmd | tail` 은 종료코드를 가린다.** 첫 실행이 그 형태였고 exit 0 으로 보였지만 실제로는 BUILD FAILURE 였다.
   러너는 **파일로 리다이렉트한 뒤 `$?` 를 먼저 찍는다.**
4. **Bash 인라인 한글은 exit 127** 이다(이 step 에서도 2회 재현). `grep` 패턴에 한글을 넣지 말고 Grep 도구·파일 스크립트를 쓴다.
5. **`taskkill` 은 이 환경에서 분류기에 막힌다** — 잘못 띄운 장기 실행은 죽일 수 없다고 보고 **처음부터 형태를 맞춰 띄워라**.

## G. 계획(index.json)과 달라진 점 · 후속 step 기대치 갱신

1. **baseline ①~⑤ 는 전건 재확인됐다**(1472 · 107 · 313×2축 · 39/39 · 1328). 계획의 전제는 유지된다.
2. **jar 바이트 수는 무회귀 판정에서 뺀다**(위 ⚠). 계획서 baseline 이 적은 두 jar 크기는 **참고값**이다.
3. **`web/dist` 는 재빌드 재현성이 확인됐다** — step3 대조기는 `web/dist` 를 고정 입력으로 다뤄도 된다.
4. **운영 tick·FTP 수집의 실값은 여전히 미상**이다. `docs/cutover-p3.md` §0-2 의 **Q1(FTP 수집 사용 여부)** 이
   유일한 **blocked 유발** 질문이고, 그 답이 없으면 **step1 의 결정 ④** 와 **step6** 이 확정되지 않는다.
   step2~step5 는 Q1 없이 진행 가능하다(전부 리포 안 자산으로 완결된다) — 그래서 이 phase 는 **step1 만 `blocked`** 로 둔다.
5. **개발 머신 = 운영 머신이 아니다**(3001 리스너 0건 · tick 작업 0건). 리포의 `dist/기사작성기-server/` 는
   **개발 빌드 표본**이지 운영 배치가 아니다 — step4 실기 시나리오는 그 표본으로 돌지만, 그 결과를 「운영에서 확인했다」로 적지 마라.
6. **MySQL 3306 리스너가 `0.0.0.0` 바인드**다(`docs/ops-mysql.md` §3 의 「loopback 전용」 서술과 다르다).
   이 phase 는 이것을 고치지 않는다(범위 밖) — **사실만 `docs/cutover-p3.md` §0 의 8묶음(MySQL)에 남기고** step10 런북이 운영자에게 낭독한다.
7. **U1 grant 는 여전히 미부착**이다(`SHOW GRANTS` 실측). 컷오버의 필수 항목이고 하네스는 이 축을 볼 수 없다.
