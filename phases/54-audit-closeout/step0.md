# Step 0: projection-array-guard

## 목표

`src/services/contentsProjection.js`의 `toPublicContents`가 **배열을 받으면 비공개 컬럼을 하나도 제거하지 못한 채 통과시키는** 방어 공백을 닫는다. 배열 입력은 원소별로 재귀 투영한다.

> **선행**: 이 phase의 첫 step. 시작 기준선은 `npm test` 751/751 pass, `npm run test:web` 87 files / 2124 tests pass, `npm run lint`·`npm run build` clean.
> 수정 대상은 **`src/services/contentsProjection.js` 1개 + 그 테스트 1개뿐**이다.

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md` — 백엔드 계층 분리(controllers → services → models → db)와 "보안 경계 = 서버" 절.
- `src/services/contentsProjection.js` — 파일 전체(30줄).
  - `PRIVATE_CONTENTS_COLS = Object.freeze(['lockerSessionId', 'lockerClientId'])` — 응답에 실리면 안 되는 컬럼의 단일 출처.
  - `toPublicContents(contents)` — `contents === null || typeof contents !== 'object'`면 그대로 반환, 그 외에는 `Object.entries` 순회로 비공개 키를 제외한 **새 객체**를 만든다(원본 mutate 금지).
- `src/services/articleService.js` — 읽기 경로 3곳이 이 함수의 유일한 프로덕션 호출부다.
  - `getById` → `{ ...row, contents: toPublicContents(row.contents) }`
  - `query` → `articleModel.query(filters).map((contents) => toPublicContents(contents))`
  - `search` → `articleModel.searchByText(q).map((row) => toPublicContents(row))`
  - 위 3곳의 **명시적 `.map`은 이 step에서 제거하지 않는다**(작업 항목 아님).
- `test/contentsProjection.test.js` — 기존 테스트 스타일(node:test + assert, 순수 함수 단위 검증).
- `test/response-secrets.test.js` — 응답 JSON에 세션 토큰 문자열·키 이름이 0건임을 라우트 루프로 단언하는 phase 51 회귀 테스트(읽기만 — 수정 금지).

## 배경 (자기완결) — 왜 결함인가

`Object.entries([rowA, rowB])`는 `[['0', rowA], ['1', rowB]]`를 돌려준다. 키 `'0'`·`'1'`은 `PRIVATE_CONTENTS_COLS`에 없으므로 걸러지지 않고, 값은 **원본 행 객체 그대로**(즉 `lockerSessionId`·`lockerClientId`를 품은 채) 결과에 실린다. 즉 호출부가 실수로 `toPublicContents(rows)`처럼 배열을 통째로 넘기면

- 반환값은 배열이 아니라 `{ '0': …, '1': … }`이 되고,
- 그 안의 행에는 **활성 세션 토큰이 그대로 남는다**.

이것은 phase 51 step0이 닫은 권한 상승 표면(전 인증 사용자가 목록 조회만으로 데스크의 세션 토큰을 획득)과 정확히 같은 구멍이며, 지금은 "호출부가 항상 `.map`을 쓴다"는 관행에만 의존하고 있다. 새 읽기 라우트가 하나 추가될 때 조용히 재발할 수 있는 형태다.

## TDD — 테스트 먼저

`test/contentsProjection.test.js`에 red → green으로 추가한다.

1. **배열 입력 투영**: `[{ articleId:'AKR1', lockYN:'Y', lockerUserId:'u1', lockerSessionId:'tok', lockerClientId:'c-1' }, { articleId:'AKR2', lockerSessionId:'tok2' }]`을 넘기면
   - 결과가 `Array.isArray`이고 길이·순서가 같다,
   - 각 원소에 `lockerSessionId`·`lockerClientId` **키가 없다**(`'lockerSessionId' in out[i] === false`),
   - 공개 필드(`articleId`·`lockYN`·`lockerUserId`)는 값 그대로 보존된다,
   - `JSON.stringify(결과)`에 `'tok'`·`'tok2'`·`'lockerSessionId'`·`'lockerClientId'` 문자열이 **하나도 없다**.
2. **원본 불변**: 입력 배열과 각 원소가 변하지 않는다(입력 배열 === 원본 참조, 원소의 `lockerSessionId`가 그대로 남아 있다 — 잠금 판정 경로가 계속 쓴다).
3. **결함 재현(수정 전 red)**: 수정 전 구현은 배열 입력에 대해 `Array.isArray(out) === false`이고 `JSON.stringify(out)`에 토큰 문자열이 남는다 — 이 두 단언이 red여야 한다.
4. **원소가 객체가 아닌 배열**: `[null, 'x', 3]` → 각 원소는 원본 규칙대로 그대로 반환된다(길이 3, 값 동일). 크래시 없음.
5. **회귀(기존 계약 불변)**: 단일 객체·`null`·`undefined`·문자열·숫자 입력의 반환이 오늘과 동일하다. 중첩 객체 필드(예: `contents.meta` 같은 객체 값)는 **깊은 복사 없이 참조 그대로** 실린다(오늘 동작 유지).

기존 테스트는 한 줄도 수정하지 않는다.

## 작업

`src/services/contentsProjection.js`의 `toPublicContents` 맨 앞에 배열 분기를 추가한다.

```js
export function toPublicContents(contents) {
  if (Array.isArray(contents)) return contents.map(toPublicContents); // 원소별 재귀 투영
  if (contents === null || typeof contents !== 'object') return contents;
  // …기존 본문 그대로…
}
```

지켜야 할 규칙:

- **예외를 던지지 마라.** 이 함수는 읽기 응답 경로에 있고, throw는 조회 500으로 이어진다. 안전한 값으로 수렴하는 것이 기존 방어 규율(`null`/비객체는 그대로 반환)과 일관된다.
- 원본 배열·원소를 mutate하지 않는다(새 배열·새 객체만 만든다).
- `PRIVATE_CONTENTS_COLS`의 항목을 추가·삭제·이름 변경하지 않는다.
- 파일 상단 주석에 "배열 입력은 원소별로 투영한다(오용이 무음 토큰 유출로 번지지 않게 하는 안전망 — 호출부는 계속 명시적으로 map 한다)" 취지의 **한 줄**만 보탠다. 기존 주석을 재작성하지 마라.

## Acceptance Criteria

```bash
npm run lint      # 통과
npm run build     # 통과
npm test          # 백엔드 — 실패 0, 개수는 751 + 이번 신규 케이스
npm run test:web  # 웹 무접촉 — 87 files / 2124 tests, 실패 0(개수 불변)
```

`git diff --name-only`는 `src/services/contentsProjection.js`, `test/contentsProjection.test.js` **2개뿐**이어야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증: 추가한 배열 분기를 주석 처리하면 신규 케이스(배열 투영·토큰 문자열 부재)만 red가 되고 기존 케이스는 green인지 확인한 뒤 원복한다.
3. 호출부 확인: `git grep -n "toPublicContents" -- src server`로 프로덕션 호출부가 여전히 `articleService`의 3곳뿐이며 `.map`이 그대로인지 확인한다. 새 호출부를 만들지 않는다.
4. 아키텍처 체크리스트:
   - services 계층 순수 모듈만 수정했는가(DB/HTTP/시계 의존 0)?
   - DB 스키마·행 변경 0건인가?
   - 응답 계약(`lockYN`·`lockerUserId`·`lockedAt`은 계속 노출)이 그대로인가?
5. `phases/54-audit-closeout/index.json`의 step0을 `completed` + `summary`로 갱신한다. summary에는 "배열 입력 = 원소별 재귀 투영, throw 금지, 호출부 map 유지"를 명시하라.

## 금지사항

- 배열 입력에서 예외를 던지지 마라. 이유: 조회 라우트가 500으로 떨어져 가용성이 깎이고, 이 함수의 기존 방어 규율(안전한 값으로 수렴)과 어긋난다.
- `articleService`의 `.map` 호출을 "이제 필요 없다"며 제거하지 마라. 이유: 투영 책임이 어디 있는지 읽는 사람이 알 수 없게 되고, 배열 분기는 어디까지나 안전망이지 계약이 아니다.
- `PRIVATE_CONTENTS_COLS`에 컬럼을 추가하지 마라. 이유: `lockYN`·`lockerUserId`·`lockedAt`은 잠금 표시 UI 계약이며 제거하면 목록의 잠금 표시와 phase 53의 takeover 감지가 깨진다.
- 모델(`articleModel`)이 돌려주는 행에서 컬럼을 지우지 마라. 이유: `acquireEditLock`의 재로그인 takeover 판정이 `lockerSessionId`를 필요로 한다(제거는 응답 투영 한 곳에서만).
- DB 스키마·행을 건드리지 마라(DDL/DELETE 0건). 이유: DB 비파괴 원칙(CLAUDE.md·ADR-002).
- `docs/ADR.md`·`docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하거나 커밋에 포함하지 마라. 이유: 다른 세션이 편집 중이거나 이 phase의 소유가 아니다.
- 기존 테스트를 깨뜨리지 마라.
