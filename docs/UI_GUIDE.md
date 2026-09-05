# UI 디자인 가이드
보도 제작 화면. 구현 기준은 `web/src/styles/yonhap.css` (디자인 토큰 → 컴포넌트).

## 디자인 원칙
1. **도구처럼 보여야 한다** — 매일 쓰는 보도 제작 대시보드이지 마케팅 페이지가 아니다.
2. **신문형 정보 밀도** — 좁은 행간/패딩, 얇은 회색 구분선(1px #ddd), 표·목록 위주로 한 화면에 많은 기사를 조밀하게.
3. **블루가 크롬을 이끌고, 레드는 포인트로만** — 흰 배경 위 무채색 UI에 블루 기조. 레드는 로고 룰·alert·송고 배지 등 강조에만 절제해서 쓴다.

## AI 슬롭 안티패턴 — 하지 마라
| 금지 사항 | 이유 |
|-----------|------|
| backdrop-filter: blur() | glass morphism은 AI 템플릿의 가장 흔한 징후 |
| gradient-text (배경 그라데이션 텍스트) | AI가 만든 SaaS 랜딩의 1번 특징 |
| "Powered by AI" 배지 | 기능이 아니라 장식. 사용자에게 가치 없음 |
| box-shadow 글로우 애니메이션 | 네온 글로우 = AI 슬롭 |
| 보라/인디고 브랜드 색상 | "AI = 보라색" 클리셰 (이 앱은 블루+레드) |
| 모든 카드에 동일한 rounded-2xl | 균일한 큰 둥근 모서리는 템플릿 느낌 — radius는 2/4/6px만 |
| 배경 gradient orb (blur-3xl 원형) | 모든 AI 랜딩 페이지에 있는 장식 |

## 색상  (yonhap.css `:root` 토큰)
### 배경
| 용도 | 값 |
|------|------|
| 페이지 / 카드 | `#ffffff` (--yh-white) |
| 영역 강조(표 헤더 등) | `#f5f5f5` (--yh-gray-bg) |
| hover 행 / 포커스 틴트 | `rgba(10,77,166,0.08)` (--yh-blue-light) |

### 브랜드 / 크롬
| 용도 | 값 |
|------|------|
| 주 블루 (헤더선·활성탭·주요버튼·링크·표 밑줄) | `#0a4da6` (--yh-blue) |
| 블루 강조 (hover/active) | `#083d84` (--yh-blue-dark) |
| 포인트 레드 (로고 룰·alert·송고 배지) | `#c8102e` (--yh-red) |
| 골드 (에디터 "(끝)" 마커) | `#d4af37` (--yh-gold) |

### 텍스트
| 용도 | 값 |
|------|------|
| 주 텍스트(잉크) | `#1a1a1a` (--yh-ink) |
| 보조 | `#444` (--yh-gray-dark) |
| 비활성 / 플레이스홀더 | `#888` (--yh-gray-mid) |
| 구분선 | `#ddd` (--yh-gray-line) |

### 상태 배지 (기사 생애주기)
| 상태 | 값 |
|------|------|
| RDS (작성 / 회색) | bg `#e8e8e8` · fg `#555` |
| DPS (송고 / 레드) | bg `#c8102e` · fg `#fff` |
| 보류 RRH·DDH (앰버) | bg `#d97706` · fg `#fff` |
| KILL RRK·DDK (슬레이트) | bg `#374151` · fg `#fff` |

## 컴포넌트
### 카드 (`.yh-card`)
```
배경 #fff · 1px 블루 테두리 rgba(10,77,166,0.15) · radius 6px(--yh-radius-lg) · shadow-lg · padding 2rem
```
### 버튼 (`.yh-btn`)
```
inline-flex · padding xs/md · 0.85rem · weight 500 · radius 3px
Primary: 블루 배경(--yh-blue), hover 시 --yh-blue-dark
로그인 CTA(.yh-card .yh-btn--primary): 명조 700 · letter-spacing 0.1em (헤드라인 느낌)
```
### 입력 (`.yh-field input`)
```
padding sm/md · 0.9rem
라벨: 블루 #0a4da6 · 700 · letter-spacing 0.08em (인쇄 라벨)
placeholder: 이탤릭 · 회색(--yh-gray-mid)
```
### 탭 (`.yh-tab`)
```
padding sm/md · 0.85rem · 투명 배경 · 하단 2px 투명 보더 → 활성 시 블루 밑줄
```
### 표 (`.yh-table`)
```
border-collapse · 0.88rem
thead 배경 #f5f5f5 · th 하단 2px 블루 밑줄 · td 하단 1px #ddd · 행 hover 시 블루 틴트
```
### 배지 (`.yh-badge`)
```
inline-block · padding 1px 6px · radius 3px · 0.7rem · 700
```

## 레이아웃
- 상단 sticky 헤더(`.yh-topbar`, 48px): 좌측 로고/타이틀, 우측 로그인 사용자 정보(`유저아이디 · 부서 · (권한)`) + 실시간 상태바.
- **좌측 정렬 기본**, 신문형 밀도. 작성 페이지는 에디터:메타데이터 = **60:40**.
- 간격 스케일: xs 0.25 / sm 0.5 / md 0.75 / lg 1 / xl 1.5 rem (`--yh-sp-*`).

## 타이포그래피
| 용도 | 스타일 |
|------|--------|
| 헤드라인 / 제목 | 명조 `--yh-serif`('Nanum Myeongjo','Noto Serif KR') · line-height 1.3 |
| 본문 / UI | 고딕 `--yh-sans`('Noto Sans KR') · base 14px · line-height 1.5 |
| 에디터 본문 색상 | 제목=블루 · 부제=레드 · 본문=검정 · "(끝)"=골드 |

## 애니메이션
- `transition: 0.15s ease`(`--yh-transition`) 수준의 미세 상태 전환만 허용.
- 글로우·그라데이션·장식 애니메이션 금지 (안티패턴 표 참조).

## 아이콘 / 모서리 / 그림자
- 모서리는 2 / 4 / 6px(`--yh-radius-sm/md/lg`)로 절제 — 균일한 큰 rounded 금지.
- 그림자는 sm / md / lg 3단계(`--yh-shadow-*`)만 사용.
- 아이콘은 SVG 인라인, 둥근 배경 박스로 감싸지 않는다.