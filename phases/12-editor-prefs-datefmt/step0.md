# Step 0: listformat-dateformat — 날짜형식 9종 + listFormat 인자화

## 배경 / 요구사항

`docs/news.md` "# 에디터 환경설정 > 날짜형식: 9개의 날짜 포멧팅". 현재 `listFormat.js`의 `formatDateTime(iso)`는 `'YYYY-MM-DD HH:mm'` 고정이다. 이 step은 **9종 날짜형식**을 정의하고 `listFormat`이 현재 선택된 형식을 쓰도록 인자화한다(기본은 현행 형식 — 불변). 형식을 바꾸는 UI/적용은 Step 1.

스펙이 9종을 구체화하지 않았으므로 아래 9종으로 정의한다(토큰 `YYYY/MM/DD/HH/mm`).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md`
- `/docs/news.md` — "# 에디터 환경설정 > 날짜형식", "기사 조회페이지"(작성/수정/송고시간 컬럼 'YYYY-MM-DD HH:mm').
- `web/src/view/listFormat.js` — `formatDateTime(iso)`(ISO 문자열을 정규식으로 잘라 표시 — **Date 객체 비사용**: 타임존 이동 방지), `formatCell(key, value)`(createdAt/editedAt/sentAt만 포맷). **여기를 인자화**한다.
- `web/src/view/listFormat.test.js`(있으면) — vitest 단위 테스트 패턴.
- `web/src/view/editorColoring.js` — module-level 현재값 + setter 패턴 참고(phase 11 `setEditorColors`와 동일 구조로 `setDateFormat`을 둔다).
- `web/src/view/editorPrefs.js` — `DEFAULT_EDITOR_PREFS.dateFormat`(phase 10, 기본 'YYYY-MM-DD HH:mm').

## 작업

TDD로 진행한다(vitest).

### 1. `listFormat.js` 인자화 + 9종 형식

```js
// 9종 날짜형식 (id=format 패턴). 기본은 현행 'YYYY-MM-DD HH:mm'.
export const DATE_FORMATS = Object.freeze([
  'YYYY-MM-DD HH:mm',
  'YYYY-MM-DD',
  'YYYY.MM.DD HH:mm',
  'YYYY.MM.DD',
  'YYYY/MM/DD HH:mm',
  'YYYY년 MM월 DD일 HH:mm',
  'YYYY년 MM월 DD일',
  'MM-DD HH:mm',
  'MM/DD/YYYY',
]);
export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD HH:mm';

export function applyDateFormat(iso, format)  // 순수: ISO를 파싱해 format 토큰을 치환. iso 없음/미매치면 ''/원본.
export function setDateFormat(format)         // module-level 현재 형식 설정(DATE_FORMATS에 없으면 기본 유지).
export function formatDateTime(iso)           // 현재 형식으로 포맷(시그니처 불변 — formatCell 호출부 무회귀).
```

규칙:
- `applyDateFormat(iso, format)`: 기존 `formatDateTime`처럼 **정규식으로 ISO에서 YYYY/MM/DD/HH/mm를 추출**(Date 객체 쓰지 마라 — 타임존 이동 방지)하고 `format` 문자열의 토큰을 치환한다. `iso`가 없으면 `''`, 정규식 미매치면 원본 문자열 반환(기존 `formatDateTime` 폴백 동일). **토큰은 `YYYY→MM→DD→HH→mm` 순서로 각 1회씩 치환하고 대소문자를 구분한다**(`MM`=월, `mm`=분 — global replaceAll로 뭉뚱그려 치환하면 충돌 소지).
- `formatDateTime(iso)`: **시그니처 불변**(`formatCell`이 `formatDateTime(value)`로 호출). 내부에서 `applyDateFormat(iso, currentFormat)`을 쓴다. `currentFormat`은 module-level(기본 `DEFAULT_DATE_FORMAT`).
- `setDateFormat(format)`: `DATE_FORMATS`에 있는 값만 적용(아니면 무시/기본 유지). `formatCell`은 변경 없음.
- **기본 상태(setDateFormat 미호출)에서 `formatDateTime`은 기존과 100% 동일한 결과**('YYYY-MM-DD HH:mm') — 기존 listFormat 테스트 불변.
- module 상태 누수 방지: 테스트는 `afterEach(() => setDateFormat(DEFAULT_DATE_FORMAT))` 필수.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **Date 객체 비사용**: ISO 문자열 파싱으로만 포맷(타임존 이동 방지 — 기존 listFormat 철학). `new Date(iso)` 쓰지 마라.
2. **시그니처/기본값 불변**: `formatDateTime(iso)`·`formatCell(key,value)` 시그니처 불변. 기본 형식 미설정 시 결과는 현행과 동일.
3. **화이트리스트**: `setDateFormat`은 `DATE_FORMATS` 값만 받는다(임의 패턴 거부).
4. **순수+최소상태**: `applyDateFormat`은 순수. module 상태는 currentFormat 1개. localStorage/DOM 접근 금지(영속은 editorPrefs, 적용 결선은 Step 1).

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(vitest):
- 기본: `formatDateTime('2026-06-21T09:05:00Z')==='2026-06-21 09:05'`(기존 불변).
- `applyDateFormat('2026-06-21T09:05:00Z','YYYY년 MM월 DD일')==='2026년 06월 21일'`; `applyDateFormat('2026-06-21T09:05Z','MM/DD/YYYY')==='06/21/2026'`.
- `applyDateFormat('', any)===''`, `applyDateFormat('not-a-date','YYYY-MM-DD')==='not-a-date'`(폴백).
- `setDateFormat('YYYY.MM.DD')` 후 `formatDateTime('2026-06-21T09:05Z')==='2026.06.21'`; `setDateFormat('잘못된형식')`은 무시(기본 유지).
- `afterEach(setDateFormat(DEFAULT_DATE_FORMAT))`로 격리.

## 검증 절차

1. AC 실행. 2. 아키텍처 체크(view 모듈, Date 비사용, 기본 불변). 3. `phases/12-editor-prefs-datefmt/index.json` step 0 갱신(성공 시 completed+summary, 실패 error, 개입필요 blocked).

## 금지사항

- `new Date(...)`로 포맷하지 마라(타임존 이동). 이유: 기존 listFormat이 문자열 슬라이스로 TZ 안정성을 보장.
- `formatDateTime`/`formatCell` 시그니처를 바꾸지 마라(ListPage 회귀).
- 날짜형식 UI/다이얼로그/ListPage 결선/localStorage 접근을 이 step에서 하지 마라(Step 1).
- 기본 형식 결과를 바꾸지 마라(기존 테스트·표시 회귀).
- 기존 테스트를 깨뜨리지 마라.
