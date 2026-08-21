package harness.news.service;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * 송고 가드의 "(끝)" 마커 판정 — 리포 루트 {@code src/services/articleService.js} 38~55행과 동형.
 *
 * <p><b>제목 파생({@link HistoryMeta#snapshotTitle})과 규칙이 다르다.</b> 마커는 블록의 {@code type}을
 * 보지 않고 모든 블록의 {@code text}를 잇는다. 계약 픽스처({@code contract/lib/fixtures.js})가 만드는
 * 본문 블록에는 {@code type}이 아예 없으므로, 두 규칙을 하나로 합치면 송고 가드가 통째로 뒤집힌다
 * (모든 송고가 400 no-end-marker가 된다).
 */
class EndMarkerTest {

	@Test
	void blocksWithoutATypeStillCount() {
		// 계약 픽스처의 실제 본문 shape — type 키가 없다.
		assertTrue(EndMarker.present("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"text\":\"본문\"},{\"text\":\"(끝)\"}]}"),
				"type 없는 블록도 마커 판정 대상이다 — 계약 픽스처가 그 shape이다");
	}

	@Test
	void typedBlocksAlsoCount() {
		assertTrue(EndMarker.present("{\"blocks\":[{\"type\":\"text\",\"text\":\"기사 본문 (끝)\"}]}"));
	}

	@Test
	void bodyWithoutTheMarkerIsFalse() {
		assertFalse(EndMarker.present("{\"blocks\":[{\"text\":\"본문만 있고 마커가 없다\"}]}"));
	}

	@Test
	void onlyTheTextFieldOfABlockIsJoined() {
		// text 밖의 필드에 있는 마커는 세지 않는다(join 대상이 text뿐이라는 사실의 관측).
		assertFalse(EndMarker.present("{\"blocks\":[{\"caption\":\"(끝)\"}]}"));
		// 비문자열 text는 빈 문자열로 대체된다 — 예외가 아니다.
		assertTrue(EndMarker.present("{\"blocks\":[{\"text\":123},{\"text\":\"(끝)\"}]}"));
		assertFalse(EndMarker.present("{\"blocks\":[{\"text\":123}]}"));
	}

	@Test
	void plainTextLegacyBodiesAreSearchedAsIs() {
		assertTrue(EndMarker.present("평문 레거시 본문입니다 (끝)"));
		assertFalse(EndMarker.present("평문 레거시 본문입니다"));
	}

	@Test
	void brokenJsonFallsBackToTheRawString() {
		assertTrue(EndMarker.present("{\"blocks\":[{\"text\":\"(끝)\"}"), "파싱 실패는 원문 문자열 검사로 폴백한다");
		assertFalse(EndMarker.present("{\"blocks\":[{\"text\":\"본문\"}"));
	}

	@Test
	void aTopLevelArrayIsNotABlocksDocument() {
		// Node는 doc.blocks만 본다 — 최상위 배열은 blocks가 없으므로 원문 문자열 그대로 검사된다.
		assertTrue(EndMarker.present("[{\"text\":\"(끝)\"}]"), "원문에 마커 문자열이 있으면 참이다");
		assertFalse(EndMarker.present("[{\"text\":\"본문\"}]"));
	}

	@Test
	void emptyOrMissingBodiesAreFalse() {
		assertFalse(EndMarker.present(null));
		assertFalse(EndMarker.present(""));
		assertFalse(EndMarker.present("{\"blocks\":[]}"));
	}
}
