package harness.news.web;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Content-Type 바이트 기록 shim의 <b>실패 규율</b>.
 *
 * <p>이 shim은 서블릿 API를 우회해 컨테이너 내부(Tomcat coyote)에 헤더 문자열을 직접 써 넣는다.
 * 그런 우회에는 하나의 치명적 실패 양식이 있다: <b>조용한 폴백</b>. 컨테이너 구조가 달라졌을 때
 * {@code setContentType}으로 슬그머니 되돌아가면 기능 테스트는 전부 green인데 <b>전 관측의 패리티가
 * 깨진다</b>(흡수 검토한 클라우드 구현이 정확히 이 형태였고, 그 폴백 경로를 검증하는 테스트가 0건이었다
 * — index.json decisions (18)).
 *
 * <p>그래서 이 구현에는 폴백이 없다. seam이 없으면 <b>즉시 예외</b>이고, 그 예외는 전역 핸들러를 통해
 * 500이 되어 계약 스위트가 첫 요청에서 red를 낸다("조용히 잘못된 헤더"보다 "시끄럽게 실패"가 낫다).
 * 이 테스트가 그 계약이다.
 */
class RawContentTypeTest {

	@Test
	void missingSeamFailsLoudlyInsteadOfFallingBackSilently() {
		IllegalStateException error = assertThrows(IllegalStateException.class,
				() -> RawContentType.set(null, "application/json; charset=utf-8"));

		assertTrue(error.getMessage().contains(RawContentType.REQUEST_ATTRIBUTE),
				"진단에 seam 이름이 있어야 원인을 찾는다: " + error.getMessage());
	}

	@Test
	void foreignContainerAlsoFailsLoudly() {
		assertThrows(IllegalStateException.class,
				() -> RawContentType.set("Tomcat이 아닌 무언가", "application/json; charset=utf-8"));
	}
}
