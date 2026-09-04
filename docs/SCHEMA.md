# schema.md
기사 작성기 DB Schema 명세서이다. (실제 news.db 구현 기준)

### DB
## 기술명세서
- DB는 SQLite를 사용한다 (node:sqlite, 서버 기동 시 server/index.js가 생성한다).
- DB 파일은 프로젝트 루트의 news.db이다.
- 테이블은 User, Article, Contents, ArticleHistory, ReceiverConfig, Photo, DistributionTarget 7개이다.
- 타입은 Article/Contents는 VARCHAR, User는 TEXT로 설정한다 (추가된 컬럼은 VARCHAR).
- 스키마 변경은 기존 데이터를 삭제하지 않고 컬럼을 추가하는 방식(멱등 마이그레이션)으로만 적용한다.
- DB에 있는 내용은 절대 삭제하지 않는다.

## PK
- Article과 Contents는 기사아이디(articleId)를 primary key로 설정한다.
- User는 유저아이디(userId)를 primary key로 설정한다.
- 인덱스는 각 테이블의 PK 자동 인덱스만 있고 보조 인덱스는 없다.

## 테이블 관계
- Contents와 Article은 기사아이디로 1:1 매핑된다.
- Contents는 기사의 공통정보·생애주기·편집 잠금을 담고, Article은 본문 마크업을 담는다.
- 기사 조회페이지(list.do)는 Contents를, 기사 작성페이지(writer.do)의 본문은 Article을 사용한다.
- FK 제약은 선언하지 않고 애플리케이션에서 정합성을 유지한다.
- Article 테이블과 Contents 테이블을 함께 수정할 때는 트랜잭션으로 처리한다.
- Dept 테이블은 만들지 않는다. 부서 정보는 User/Contents의 부서, 부서코드 컬럼으로 관리한다.

## User Table
USER(사용자)에 대한 명세서
# property
- 유저아이디(userId), 이름(name), 비밀번호(password), 권한(role), 부서(department), 부서코드(departmentCode), 활성여부(active)를 정의한다.
- 비밀번호는 해시(bcrypt)로 저장한다.
- 권한은 R(기자), D(데스크), Z(관리자)이다.
- active는 'Y'/'N'이며 기본값은 'Y'이다. 'N'이면 로그인할 수 없다.

## Article Table
Article에 대한 명세서
# property
- 기사아이디(articleId), 제목(title), 본문내용(content), 마크업내용 버전(markupVersion), 수정자(modifier)를 정의한다.
- 본문은 마크업내용 버전에 블록 JSON으로 저장한다 ({"format":"yh-editor","version":1,"blocks":[텍스트/임베드 블록...]}).
- 송고된 기사는 본문 블록 마지막에 "(끝)" 텍스트 블록을 가진다.
- 본문내용(평문) 컬럼은 현재 사용하지 않는다 (본문은 마크업내용 버전에만 저장한다).

## Contents Table
ContentsVO에 대한 명세서
# property
- 기사아이디(articleId), 제목(title), 본문내용(content), 작성자(author), 수정자(modifier), 송고자(sender), 부서(department), 부서코드(departmentCode), 작성시간(createdAt), 편집시간(editedAt), 송고시간(sentAt), 배부시간(distributedAt), 엠바고 시간(embargoAt), 2차 엠바고 시간(secondEmbargoAt), 기사상태(status)를 정의한다.
- 편집 잠금 컬럼으로 LockYN(lockYN), 잠근 사용자(lockerUserId), 잠근 세션(lockerSessionId), 잠금 시각(lockedAt)이 있다. LockYN은 'Y'/'N'이며 기본값은 'N'이다.
- 공통정보 컬럼으로 공동작성(coAuthor), 지역(region), 속성(attribute), 키워드(keyword), 내부코멘트(internalComment), 외부코멘트(externalComment), 첨부파일(attachmentFile), 자료파일(referenceFile)이 있다.
- 시간 컬럼은 ISO-8601 UTC 문자열로 저장한다.
- 배부시간(distributedAt)은 배부(스풀 기록) 실행 시각이다 — 배부가 실행될 때마다 가장 최근 시각으로 갱신하고, 개별 배부 이벤트는 ArticleHistory에 append-only로 남는다(ADR-008: 스풀 기록 시각 = 배부 지시 완료, 발송 완료가 아니다).
- 기사상태(status)는 기사 생애주기 값 RDS, DPS, RRH, RRK, DDH, DDK, DPD, EPS, EEK, EEH를 가진다 (전이 규칙은 news.md 기사 생애주기를 따른다). DPD는 DPS 기사의 삭제 승인 상태값이다(행 삭제가 아니라 상태값 전이 — DB 비파괴). EPS는 엠바고가 설정된 기사를 송고할 때의 상태(송고 대기)이고, EEK/EEH는 EPS 기사를 KILL/보류한 상태값이다.
- 기사상태(status) 목록에는 위 값에 더해 DES가 있다. DES는 엠바고가 설정된 기사를 데스크가 송고했을 때의 배부 전 대기 상태이고, 첫 배부가 실행되면 EPS, 모든 엠바고 배부가 완결되면 DPS가 된다 (news.md `RDS->DES->EPS`). DES의 허용 액션은 EPS와 동일하다(KILL→EEK, 보류→EEH). 이미 EPS로 저장된 기존 행은 그대로 EPS로 남는다 — DES는 신규 송고부터 적용하며 데이터 마이그레이션은 없다(DB 비파괴). status는 CHECK 제약 없는 VARCHAR이므로 스키마 변경도 없다.
- 기사아이디는 'AKR' + YYYYMMDD + 난수 9자리 규칙으로 생성한다 (중복이면 난수를 다시 생성한다).
- 본문내용(평문) 컬럼은 Article과 동일하게 현재 사용하지 않는다.

## ArticleHistory Table
기사 편집/생애주기 전이/배부 이벤트 로그에 대한 명세서. append-only — 행 삭제 없음(DB 비파괴)이고, 행 수정은 단 하나의 예외만 있다: 표시제목(파생 컬럼)이 비어 있는(NULL) 행을 부트 시 멱등 백필로 채우는 것(사용자 승인 2026-08-11 — 채우기는 행당 1회, 스캔은 매 부트).
이벤트 사실(이벤트유형·액션·상태·행위자·생성시간·마크업버전·수신처·실패사유)은 어떤 경우에도 수정하지 않는다 — 원장이 기록한 "무슨 일이 언제 있었는가"는 불변이고, 그 사실에서 파생된 표시용 값만 비어 있을 때 채운다.
# property
- id(INTEGER PK, ROWID alias, 자동 증가), 기사아이디(articleId), 이벤트유형(eventType), 액션(action), 이전상태(fromStatus), 이후상태(toStatus), 행위자(actorUserId), 생성시간(createdAt), 마크업버전(markupVersion), 표시제목(snapshotTitle), 수신처(targetId), 실패사유(reason) 컬럼을 가진다.
- markupVersion은 편집(edit) 시점 본문 스냅샷이다 — 상태 전이 행은 NULL(본문 불변).
- snapshotTitle(VARCHAR)은 스냅샷 기록 시점에 본문 첫 줄에서 파생해 저장하는 표시용 제목이다 — 이력 조회가 본문(blob)을 읽지 않게 하는 것이 목적이다. 표시제목이 비어 있는(NULL) 스냅샷 행(컬럼 도입 이전에 기록된 행 + 드물게 기록 시점에 제목을 저장하지 못한 행)은 부트 시 1회 멱등 백필이 빈 컬럼만 채운다(파생 결과가 빈 문자열이어도 빈 문자열로 저장, 재실행 시 채운 행 수 0·값 불변). 행 삭제·기존 값 덮어쓰기·표시제목 외 컬럼 수정은 없다. 조회가 표시제목이 비어 있는 행에 한해 본문을 함께 읽어 파생하는 행 단위 폴백은 백필 이후에도 유지한다(백필을 돌리지 않은 DB·구버전 인스턴스가 기록한 행이 남을 수 있다). 파생 규칙이 바뀌어도 이미 저장된 행은 옛 규칙의 값을 유지한다(백필은 빈 값만 채운다 — 저장된 값의 재파생·덮어쓰기 없음).
- targetId(INTEGER)는 배부 실패/재전송 이벤트의 수신처(DistributionTarget.id)이고, 그 외 이벤트는 NULL이다.
- reason(VARCHAR)은 배부 실패 사유 고정 토큰이다 — 경로·본문·예외 원문을 담지 않는다.
- eventType 어휘: create / edit / status(전이 — action에 send·hold·kill·approveDelete·embargo) / distribute(kind 단위 배부 — action=press|nonpress) / distribute-failed(수신처 단위 실패) / distribute-retry(수신처 단위 재전송 성공). 배부 멱등·사이클 경계 판정은 eventType='distribute' 행만 본다(ADR-008).
- 타입 예외: 위 기술명세서의 "추가된 컬럼은 VARCHAR" 규칙의 예외는 ArticleHistory.targetId(INTEGER)다 — VARCHAR는 TEXT affinity라 숫자 id가 문자열로 저장되어 DistributionTarget.id와의 매칭이 조용히 어긋난다.
- 보조 인덱스 없음(PK 자동 인덱스만) — 배부 이벤트 조회는 id DESC 스캔 + LIMIT다(비용 인식).

## ReceiverConfig Table
수집(자동기사) 수신 설정에 대한 명세서. Z(관리자) 전용 CRUD.
# property
- id(INTEGER PK, ROWID alias, AUTOINCREMENT), 소스아이디(sourceId), 유형(type), 이름(name), 호스트(host), 포트(port), 사용자명(username), 비밀번호(password), API엔드포인트(apiEndpoint), API키(apiKey), 활성여부(active), 생성시간(createdAt) 컬럼을 가진다.
- id는 INTEGER PRIMARY KEY (SQLite ROWID alias) — 자동 증가. 나머지 컬럼은 VARCHAR.
- sourceId는 수신 시 식별자로, collectionService.receive(sourceId, payload)가 이 값으로 등록 여부를 판정한다. 미등록 sourceId는 수신 거부.
- type은 'FTP' 또는 'API'.
- active는 'Y'/'N', 기본값 'Y'. 비활성 설정은 등록 거부 대상이 된다.
- 행 삭제(remove)는 설정 행만 지운다 — 이미 수집된 Article/Contents는 절대 건드리지 않는다(DB 비파괴 원칙).
- 보조 인덱스/FK 제약 없음. 정합성은 애플리케이션이 유지.

## Photo Table
사진DB(도구>사진발행/DB등록)에 대한 명세서. 세션 로그인 사용자 전용(역할 게이트 없음), append-only.
# property
- id(INTEGER PK, ROWID alias, 자동 증가), 이미지참조(src), 캡션(caption), 출처기사아이디(sourceArticleId), 등록자(registeredBy), 등록시간(createdAt) 컬럼을 가진다.
- id는 INTEGER PRIMARY KEY (SQLite ROWID alias) — 자동 증가. 나머지 컬럼은 VARCHAR.
- src는 업로드 상대경로(/uploads/...) 또는 https:// URL만 허용한다 — 등록 시 서버가 sanitizeFileRef(첨부/자료 파일과 같은 단일 출처)로 검증하고, 그 외(javascript:/data:/http:/프로토콜상대/.. traversal 등)는 invalid-src로 거부한다.
- caption은 검색 대상 텍스트다 — GET /api/photos/search가 캡션 부분일치(LIKE)로 조회한다(최신 등록 우선, id DESC). 재임베드 시 이미지 alt로 쓰인다.
- sourceArticleId는 등록 시점 편집 중이던 기사아이디다(미저장 신규 기사면 빈 문자열 — best-effort 출처 기록).
- registeredBy는 검증된 세션의 userId로만 채운다(ADR-004 — 클라이언트가 보낸 값은 신뢰하지 않는다). createdAt는 ISO-8601 UTC 문자열로 서버가 stamp한다.
- 행 삭제/수정 없음(append-only) — 사진 삭제는 범위 밖(DB 비파괴 원칙).
- 보조 인덱스/FK 제약 없음. 정합성은 애플리케이션이 유지.

## DistributionTarget Table
배부(distribution) 대상 수신처 관리에 대한 명세서. Z(관리자) 전용 CRUD. 아키텍처는 ADR-008이 단일 출처다.
# property
- id(INTEGER PK, ROWID alias, 자동 증가), 수신처명(name), 종류(kind), 스풀폴더(spoolDir), 활성여부(active), 생성시간(createdAt), 수정시간(updatedAt) 컬럼을 가진다.
- id는 INTEGER PRIMARY KEY (SQLite ROWID alias) — 자동 증가. 나머지 컬럼은 VARCHAR.
- kind는 'press'(언론사) 또는 'nonpress'(비언론사)이다. 엠바고 배부 규칙(1차→언론사, 2차→비언론사)이 이 값으로 대상을 고른다.
- spoolDir는 배부 스풀 하위 폴더명(슬러그 문자열)이다. 배부 실행 시 `DIST_SPOOL_DIR/<spoolDir>/<articleId>_<시각>.json`으로 기사 파일이 기록된다(ADR-008의 파일 스풀 outbound — 앱은 쓰기만 하고 발송은 외부 전송기가 한다). 경로 합성 직전에 슬러그 규칙을 다시 검증한다.
- active는 'Y'/'N', 기본값 'Y'. 'N'이면 배부 대상에서 제외된다.
- **행 삭제 없음 — 비활성은 active='N' soft delete로 처리한다(DB 비파괴 원칙). 모델은 삭제(remove/delete) 함수를 노출하지 않는다.**
- createdAt/updatedAt은 ISO-8601 UTC 문자열로 서버가 stamp한다.
- ReceiverConfig(수집 inbound 전용)와 재사용하지 않는 별도 테이블이다 — ADR-008 (2).
- 보조 인덱스/FK 제약 없음. 정합성은 애플리케이션이 유지.

## MySQL 매핑 (phase 75 / P2 — 추가 절)
위 명세는 **SQLite 정본**(`src/db/schema.js`)의 것이고 **컬럼의 의미는 이 절이 바꾸지 않는다.** 여기에는 같은 7테이블을
MySQL 8.0으로 옮길 때의 **타입·collation 대응**과 **저장소가 달라서 갈리는 축**만 더한다. 배경·근거는 ADR-016,
축별 실측은 `docs/db-mysql-mapping.md`, 운영 절차는 `docs/ops-mysql.md`다.

- **정본이 둘이 된다**: SQLite 측은 `src/db/schema.js`, MySQL 측은 `tools/news-migrator`의 Flyway 기반선
  (`src/main/resources/db/migration/V1__baseline.sql`)이다. 두 정본의 동형성은 사람 눈이 아니라 기계가 지킨다
  (`BaselineMatchesCanonicalSchemaTest`가 컬럼 이름·선언 순서·타입·기본값을 규칙으로 계산해 대조한다 —
  **정본에 컬럼이 늘면 그 테스트가 red다**). `server-spring`은 여전히 **DDL을 한 줄도 실행하지 않는다**.
- **이 phase 이후 정상 상태는 Node=SQLite / Spring=MySQL 병존**이다. 전환기에 어느 쪽이 쓰기 정본인지는
  **사람의 절차**가 지킨다(`docs/ops-mysql.md` §11-6).

### 타입 대응 (규칙 넷 — 전부 실측된 오류코드가 근거다)
| SQLite 정본 | MySQL | 근거 |
|---|---|---|
| 텍스트 PK 3종(`User.userId`·`Article.articleId`·`Contents.articleId`) | `VARCHAR(768) NOT NULL PRIMARY KEY` | `LONGTEXT`는 PK가 될 수 없고(1170), `VARCHAR(769)` PK는 키 상한 3072바이트를 넘어 거부된다(1071) |
| 그 밖의 모든 텍스트(`VARCHAR`/`TEXT`) | `LONGTEXT` | `Article.markupVersion`이 165,802바이트라 `VARCHAR`가 원천 불가하고(1406), `Contents` 29컬럼을 `VARCHAR(768)`로 두면 행 크기 상한을 넘어 테이블이 만들어지지 않는다(1118) |
| `INTEGER PRIMARY KEY`(ROWID alias — ArticleHistory·ReceiverConfig·Photo·DistributionTarget) | `BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY` | 채번을 유지한다 |
| `ArticleHistory.targetId INTEGER` | `BIGINT` | 숫자 id가 문자열이 되지 않게(정본의 타입 예외를 그대로 옮긴다) |
| 기본값 5건(`User.active='Y'`·`User.failedLoginCount='0'`·`Contents.lockYN='N'`·`ReceiverConfig.active='Y'`·`DistributionTarget.active='Y'`) | **식 형태** `DEFAULT ('Y')` | `LONGTEXT`는 리터럴 기본값을 가질 수 없다(1101). 버리면 안 되는 이유는 삽입문이 **동적 컬럼 목록**이라 값 없는 컬럼이 문장에서 빠지기 때문이다 — 버리면 MySQL에서만 `NULL`이 되어 **이관이 동작을 바꾼다** |

- **문자셋·collation은 전 테이블 `utf8mb4` / `utf8mb4_0900_bin`이다.** 세 후보 중 `=`(보안 축)와 `ORDER BY`가
  SQLite BINARY와 **완전히 일치한 유일한 값**이다(`utf8mb4_bin`은 PAD SPACE라 `'x' = 'x '`가 참이 되어 인증이 무너지고,
  `utf8mb4_0900_ai_ci`는 대소문자·전각·자모를 같다고 본다).
- **엔진은 InnoDB.** **날짜·시각을 `DATETIME`으로 승격하지 않는다**(ISO-8601 문자열 그대로 — 승격하면 포맷·타임존이 왕복에서 갈린다).
- **보조 인덱스·FK를 만들지 않는다** — 정본과 같이 **PK 자동 인덱스만**이다(성능 축은 P3).
- **테이블 이름은 정본 표기로 적지만 카탈로그에는 소문자로 남는다**(`lower_case_table_names=1`). **컬럼 이름 표기는 보존**되므로
  응답 키 집합(=계약)은 이관으로 바뀌지 않는다. 예약어 교집합은 **0건**이라 리포지토리 SQL은 무인용 식별자 그대로 돈다.
- **대상 스키마에는 정본에 없는 테이블이 하나 생긴다** — `flyway_schema_history`(이관 도구의 원장). 전 행 대조는 이 테이블을 **명시적으로 제외**한다.

### SQLite와 갈리는 축 (저장소가 다르면 답이 다르다)
| 축 | SQLite | MySQL |
|---|---|---|
| `LIKE` 대소문자 | ASCII 대소문자 **무시** | **구분**(채택 collation의 대가 — 검색 결과가 좁아진다) |
| 삭제된 id 재사용 | 최댓값 행 삭제 후 **재사용** | InnoDB는 **재사용하지 않는다** |
| 롤백 후 id | 간격 **없음** | 간격 **1** |
| 769자 텍스트 PK | **수락** | **거부**(1406) — 도달 경로는 `User.userId`(관리자 생성 API) |
| `length()` 값 | **문자 수** | **바이트 수** (이 리포가 쓰는 유일한 자리인 `length(x) > 0` 술어는 **같은 행 집합**) |
| 큰 수의 저장 표현 | `1e9` → `1000000000.0` | `1e9` → `1000000000` |
| 대기 예산 | `busy_timeout` 5초 | `innodb_lock_wait_timeout` 50초 |
| 유한하지 않은 id(`NaN`·무한대) | 조용히 0행 | 문장 자체가 깨진다 → **서버가 정본 의미론으로 먼저 막는다**(`ColumnValues.matchesNoRow`) |

**정렬은 갈리지 않는다**(채택 collation이 SQLite BINARY와 일치한다). 각 축의 **유일 방어선(파일·메서드)** 목록은
`docs/db-mysql-mapping.md` §7·§7-1이 소유한다 — 계약 스위트가 **보지 못하는** 축이 대부분이기 때문이다.
