# schema.md
기사 작성기 DB Schema 명세서이다. (실제 news.db 구현 기준)

### DB
## 기술명세서
- DB는 SQLite를 사용한다 (node:sqlite, 서버 기동 시 server/index.js가 생성한다).
- DB 파일은 프로젝트 루트의 news.db이다.
- 테이블은 User, Article, Contents 3개이다.
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
- 기사상태(status)는 기사 생애주기 값 RDS, DPS, RRH, RRK, DDH, DDK를 가진다 (전이 규칙은 news.md 기사 생애주기를 따른다).
- 기사아이디는 'AKR' + YYYYMMDD + 난수 9자리 규칙으로 생성한다 (중복이면 난수를 다시 생성한다).
- 본문내용(평문) 컬럼은 Article과 동일하게 현재 사용하지 않는다.
