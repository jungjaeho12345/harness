package harness.news.service;

import java.util.Set;
import java.util.regex.Pattern;

/**
 * 배부 스풀 하위 폴더명(slug) 검증 — 리포 루트 {@code src/services/spoolDir.js}의 이식(규칙의 단일 출처).
 *
 * <p>이 값은 배부 실행 phase(ADR-008)에서 배부 스풀 루트 아래 하위 폴더명으로 실제 파일 경로에
 * 합성되므로, <b>저장 시점(여기)이 경로 조작을 막는 유일한 방어 지점</b>이다. 여기서 디렉토리를 만들거나
 * 존재를 확인하지 않는다 — 순수 검증만 한다.
 *
 * <p>계약은 {@link FileRef}와 동형이다: 유효하면 <b>원문 그대로</b>, 아니면 빈 문자열(throw 없음).
 * 다만 <b>타입 게이트가 반대</b>다 — {@code FileRef}는 {@code String.valueOf(value)}로 먼저 문자열화하지만
 * 여기서는 <b>강제변환을 하지 않는다</b>. 비문자열을 문자열화하면 {@code "123"}·{@code "true"}·
 * {@code "null"}이 아래 화이트리스트를 전부 통과해 검증기가 무력화되기 때문이다(정본 주석의 결함).
 */
public final class SpoolDir {

	/**
	 * 소문자 영숫자로 시작 + 이후 영숫자/{@code -}/{@code _}, 총 1~64자.
	 *
	 * <p>이 한 줄이 절대경로·{@code ..}·{@code /}·{@code \}·{@code :}·널바이트·공백·제어문자·유니코드·
	 * 대문자를 전부 거부한다.
	 */
	private static final Pattern SLUG = Pattern.compile("^[a-z0-9][a-z0-9_-]{0,63}$");

	/**
	 * Windows 예약 장치명 — 그 이름의 디렉토리는 생성 자체가 불가라 배부 실행 phase가 무조건 실패한다.
	 * 화이트리스트가 이미 소문자만 통과시키므로 소문자 비교로 충분하다.
	 */
	private static final Set<String> RESERVED = Set.of(
			"con", "prn", "aux", "nul",
			"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
			"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9");

	/**
	 * 유효한 슬러그면 원문 그대로, 아니면 빈 문자열.
	 *
	 * <p>진입 타입 게이트로 비문자열({@code null}·숫자·불리언·맵…)을 강제변환 없이 빈 문자열로 떨군다 —
	 * 서비스(배부 수신처)가 임의 body 값을 그대로 넘기므로 여기가 유일한 타입 방어다.
	 */
	public static String sanitize(Object value) {
		// 1) 타입 게이트 — 강제변환 금지. "null"/"undefined"/"123"/"true"는 화이트리스트를 전부 통과한다.
		if (!(value instanceof String slug)) {
			return "";
		}
		// 2) 화이트리스트.
		if (!SLUG.matcher(slug).matches()) {
			return "";
		}
		// 3) 예약 장치명 거부.
		if (RESERVED.contains(slug)) {
			return "";
		}
		// 4) 통과 — 원문 그대로 반환한다(정규화·소문자 변환·trim 금지: 입력을 고쳐서 통과시키지 않는다).
		return slug;
	}

	private SpoolDir() {
	}
}
