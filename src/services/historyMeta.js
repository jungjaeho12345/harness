// 이력 메타 파생 — 순수 모듈(DB·HTTP·Date·랜덤 비의존, embargoPolicy.js와 동형 관례).
// ArticleHistory에는 기록 시점에 파생 저장한 표시 제목 컬럼(snapshotTitle — phase 58)이 있고,
// 버전 저장 컬럼은 없으며 상태는 전이 행에만 있다. 이 모듈은 이력 로그 + 스냅샷 항목
// ({ id, snapshotTitle?, markupVersion? })에서 표시용 title/version/status를 파생한다 —
// 저장된 제목이 1차 출처이고, 값이 없는(null) 레거시 항목만 본문(markupVersion)에서 파생한다.
// 조회·필터 결선은 서비스(articleService.queryHistory) 책임 — 필요한 본문은 전부 인자로 주입받는다.

export const MAX_HISTORY_TITLE_LEN = 200;

// markupVersion 스냅샷 → 그 본문의 제목(첫 텍스트 줄, trim, 상한 절단). 파싱 불가/빈 값 → ''.
// 규칙 드리프트(의도된 대가): 아래 파생 규칙을 바꿔도 이미 저장된 행(snapshotTitle 컬럼)은 옛 규칙의
// 값을 유지한다(빈 컬럼만 채우는 부트 백필은 있고 그 백필도 이 함수를 파생 출처로 쓴다 — 단, 이미
// 저장된 값은 재파생·덮어쓰지 않는다) — 규칙을 바꾸면 같은 목록 안에서 행마다 다른 규칙의 제목이 보일 수 있다.
// 규칙은 프론트 bodyTitle(blocksToText(deserialize(body)) 첫 줄)과 동형이어야 한다 —
// 텍스트 블록(type:'text')만 세고, 임베드의 title 같은 필드는 제목으로 오인하지 않는다.
// 깨진 JSON·평문 레거시는 문자열 그대로 취급한다(hasEndMarker의 방어 패턴과 동일).
// 동형의 한계(의도): 200자 상한은 이 파생에만 있고(Article.title은 무상한 — 표시 절단일 뿐),
// text 비문자열·blocks 없는 JSON 객체 같은 serialize() 불능 입력의 처리도 프론트와 다를 수 있다.
export function snapshotTitle(markupVersion) {
  if (markupVersion === null || markupVersion === undefined || markupVersion === '') return '';
  const raw = String(markupVersion);
  let text = raw;
  try {
    const doc = JSON.parse(raw);
    const blocks = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.blocks) ? doc.blocks : null);
    if (blocks) {
      text = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
    }
  } catch {
    // 평문 레거시 — text는 이미 raw.
  }
  const firstLine = (text.split('\n')[0] ?? '').trim();
  return firstLine.slice(0, MAX_HISTORY_TITLE_LEN);
}

// 모델(queryByArticle)의 hasSnapshot(숫자 1/0)과 같은 판정 — 버전 증가는 이 플래그만 본다.
function hasSnap(rowItem) {
  return !!rowItem.hasSnapshot;
}

// 전이 행 판정 — status 전이 행만 toStatus를 갖는다(distribute·edit 행은 null). 전용 분기 없음.
function isTransition(rowItem) {
  return rowItem.toStatus !== null && rowItem.toStatus !== undefined && rowItem.toStatus !== '';
}

// 제목 결정 규칙(단일 지점): 저장된 파생 제목이 문자열이면 그대로 쓰고(재파생 금지 — 평문 제목에
// snapshotTitle()을 다시 적용하면 '[1,2]'처럼 JSON으로 파싱되는 제목이 파괴된다), 그렇지 않을 때만
// markupVersion에서 파생한다. ''(빈 문자열)도 유효한 저장값이다 — 폴백하지 않는다.
function resolveSnapshotTitle(item) {
  if (!item) return '';
  if (typeof item.snapshotTitle === 'string') return item.snapshotTitle;
  return snapshotTitle(item.markupVersion);
}

// rows: articleHistoryModel.queryByArticle() 결과 — id DESC(최신순) 전제. 순서 판단은 배열 위치가
//   아니라 id로 한다(같은 createdAt이 여러 건일 수 있다). 반환 순서는 입력 순서 그대로(재정렬 금지).
// snapshots: [{ id, snapshotTitle?, markupVersion? }] 배열 하나(undefined/빈 배열 허용).
//   신규 항목은 snapshotTitle(저장된 파생 제목) + markupVersion: null, 레거시 항목은
//   snapshotTitle: null(또는 키 없음) + markupVersion: <본문> — 같은 배열에 혼재할 수 있다.
// options.v1Body: 스냅샷이 '한 건도 없을 때만' 쓰는 v1 본문(= 현재 Article.markupVersion).
//   스냅샷 0건 = 최초 저장 이후 본문이 안 바뀌었다는 뜻이므로 현재 본문 = v1 본문(동치).
//   스냅샷이 1건이라도 있으면 현재 본문은 최신 버전이지 v1이 아니므로 무시한다.
// 반환: 입력과 같은 길이·같은 순서의 새 배열. 각 원소 = 입력 행 얕은 복사 + { title, version, status }.
//   version은 1-base 정수(최초 저장 본문 = v1, 스냅샷 행마다 증가 — 스냅샷 행 자신은 증가 후 값).
//   title·status는 값이 없으면 ''(표시 폴백 '—'는 뷰 책임).
//   markupVersion·snapshotTitle은 반환 행에 싣지 않는다(응답 shape 불변 — 방어적 제거).
export function decorateHistoryRows(rows, snapshots, { v1Body } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const snapMap = new Map(
    (Array.isArray(snapshots) ? snapshots : []).map((s) => [s.id, s]),
  );

  // 계산은 오래된 순(id ASC) — 입력 배열은 건드리지 않는다.
  const asc = [...input].sort((a, b) => a.id - b.id);
  const anySnapshot = input.some(hasSnap);
  // 스냅샷 0건일 때만 v1Body로 v1 구간 제목을 파생한다(그 외에는 무시 — 위 주석 참조).
  const v1Title = anySnapshot ? '' : snapshotTitle(v1Body);

  // 역승계용: 가장 오래된 전이의 fromStatus — 그보다 앞선 행의 상태는 그 전이 행이 알고 있다.
  const firstTransition = asc.find(isTransition);
  const backfillStatus = firstTransition ? (firstTransition.fromStatus ?? '') : '';

  let version = 1;
  let title = v1Title;
  let status = null; // 아직 전이를 못 만난 구간 — 마지막에 backfillStatus로 채운다.
  const derivedById = new Map();
  for (const r of asc) {
    if (hasSnap(r)) {
      version += 1; // 스냅샷 행 자신은 '증가 후' 값(그 편집이 새 버전을 만든다).
      title = resolveSnapshotTitle(snapMap.get(r.id));
    }
    if (isTransition(r)) status = r.toStatus;
    derivedById.set(r.id, { version, title, status: status ?? backfillStatus });
  }

  return input.map((r) => {
    const out = { ...r, ...derivedById.get(r.id) };
    delete out.markupVersion; // 목록은 blob 없는 경량 계약 — 어떤 입력에서도 싣지 않는다.
    delete out.snapshotTitle; // 표시 값의 단일 출처는 title — 저장 컬럼 값을 응답에 싣지 않는다(방어).
    return out;
  });
}
