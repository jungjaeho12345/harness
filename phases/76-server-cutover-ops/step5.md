# Step 5: node-deprecation-marker

## 읽어야 할 파일

- `phases/76-server-cutover-ops/index.json` — scope·decisions (1)(2)(5)(7)·excluded (c).
- `docs/ADR.md` — **ADR-016**(Node=SQLite / Spring=MySQL 병존이 정상 상태 · sqlite가 롤백 레버) · **ADR-008**(앱에 타이머/스케줄러 추가 금지).
- `server/index.js` 1354~1367행 — `app.listen` 콜백과 `logService.info(...)` 기동 로그. 여기 근처에 배너를 결선한다.
- `phases/75-mysql-migration/index.json` `forward_notes` (6) ④ — sqlite 분기·`TempNewsDb` 제거는 롤백 능력과 313관측 무회귀 판정을 함께 잃으므로 **제거하지 않는다**.

## 배경 / 목적

P3의 "Node 서버 은퇴" 경로를 **비파괴적으로** 연다. 이 phase는 Node를 실제로 끄지도, sqlite 분기를 제거하지도 않는다(롤백 레버 유지 · excluded (c)). 대신 운영자가 컷오버 후 실수로 Node에 쓰기를 유발하지 않도록 **opt-in 기동 경고 배너**를 둔다. 응답·계약은 한 글자도 바뀌지 않는다.

## 작업

TDD로 진행한다.

1. **순수 헬퍼 + 테스트 먼저.** 새 파일 `server/deprecationBanner.js`:

```js
// 기동 시 은퇴 예고 배너 문자열을 정한다(로그용). 앱 동작·응답과 무관한 순수 함수다.
//   NODE_SERVER_DEPRECATED === '1' 일 때만 배너 문자열을 돌려주고, 그 외에는 null(기본 침묵).
// 배너 내용(문안 재량): 이 Node 서버가 은퇴 예고 상태이며 정본은 Spring/MySQL임을,
//   되돌림이 필요하면 docs/ops-mysql.md 롤백 절차를 따르라는 안내. 비밀·경로 원문을 넣지 마라.
export function deprecationBanner(env) { /* ... */ }
```

   테스트(`test/node-deprecation-banner.test.js` · `node --test`):
   - `NODE_SERVER_DEPRECATED='1'` → 비어있지 않은 배너 문자열(정본이 Spring임을 언급).
   - 미설정/`'0'`/기타 → `null`(기본 침묵).
   - 반환 문자열에 세션·토큰·비밀번호·절대경로가 없다.

2. **결선(최소).** `server/index.js`의 `app.listen` 콜백(또는 직후)에서:
   `const banner = deprecationBanner(process.env); if (banner) logService.warn(banner);`
   기존 `logService.info('API server on …')`는 유지한다. **HTTP 응답·헤더·상태·라우트·미들웨어를 건드리지 마라** — 이건 기동 로그 한 줄이다.

3. sqlite 분기·`node:sqlite`·부트 백필·잠금(ADR-012)·`createApp` 어느 것도 제거·수정하지 마라.

**무회귀 보장**: `/api/health`를 비롯한 모든 응답이 불변이므로 계약 패리티(313관측)·`npm test`(1328)는 그대로여야 한다. `logService.warn`이 별도 링 버퍼/로그 SSE에 흐르는지는 기존 로그 정책(ADR-007)을 따르며, 이 배너는 **실데이터(기사·세션)를 담지 않는다**.

## Acceptance Criteria

```bash
# Node만 필요 — 컨테이너에서 그대로 돈다
node --test test/node-deprecation-banner.test.js
npm test        # 전체 무회귀(기존 1328 + 신설)
npm run lint

# (선택 · 실기) 배너가 뜨고 응답이 불변임을 육안 확인
#   NODE_SERVER_DEPRECATED=1 DATA_DIR=<임시> PORT=<포트> node server/index.js  → 기동 로그에 경고 배너 1줄
#   미설정으로 같은 기동 → 배너 없음. 두 경우 모두 GET /api/health = 200 {"ok":true} 동일
```

## 검증 절차

1. 위 AC를 실행한다(컨테이너 실행 가능).
2. 아키텍처 체크리스트:
   - 어떤 HTTP 응답·헤더·상태도 바뀌지 않았는가(계약 무영향 · 배너는 기동 로그뿐)?
   - sqlite 분기·`node:sqlite`·백필·ADR-012 잠금을 **제거하지 않았는가**(롤백 레버 유지)?
   - 앱에 타이머·스케줄러·주기 실행을 추가하지 않았는가(ADR-008)?
   - 배너에 비밀·실데이터·절대경로가 없는가(위생)?
3. step 5를 업데이트한다(completed→summary / error→error_message / blocked→blocked_reason).

## 금지사항

- HTTP 응답·헤더·상태·라우트·미들웨어를 바꾸지 마라. 이유: 계약이 동결이고 Node는 롤백 레버다 — 배너는 기동 로그 한 줄로 끝난다.
- sqlite 분기·`node:sqlite`·`TempNewsDb`·백필·인스턴스 잠금을 제거·수정하지 마라. 이유: 제거하면 롤백 능력과 313관측 무회귀 판정을 함께 잃는다(P3 후속 판단).
- 배너를 기본 on으로 만들지 마라. 이유: 병행 운영/롤백 중에도 Node가 정상 서비스일 수 있다 — 은퇴는 운영자가 opt-in으로 표시한다.
- 배너에 세션·토큰·비밀번호·기사 데이터·절대경로를 넣지 마라. 이유: 로그 위생(ADR-007) 위반.
- 기존 테스트를 깨뜨리지 마라.
