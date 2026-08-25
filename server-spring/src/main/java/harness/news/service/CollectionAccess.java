package harness.news.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 수집 인제스트 2라우트의 <b>접근 판정</b> — 순수 함수다(서블릿·세션·DB를 모른다). 이식 원본은
 * {@code server/index.js} 120~126행({@code isLoopbackHost}) · 1345행
 * ({@code requireCollectionToken: !isLoopbackHost(host)}) · 1073~1082행(두 라우트의 가드)이다.
 *
 * <h2>가드 순서가 계약이다</h2>
 * <ol>
 *   <li><b>fail-closed</b> — 비-loopback 바인딩 + 토큰 미설정이면 {@link Decision#DISABLED}(503).
 *       그 조합에서는 이 라우트에 방어가 하나도 남지 않으므로 <b>기능을 제공하지 않는다</b>. 토큰 헤더가
 *       있어도 503이다(401로 새면 계약 {@code receive-disabled-with-token}이 red).</li>
 *   <li><b>토큰</b> — 서버에 토큰이 <b>설정돼 있을 때만</b> 헤더를 본다. 미설정 서버는 헤더를 읽지도
 *       않는다(계약 {@code open-success-token-ignored}).</li>
 *   <li>둘 다 통과하면 {@link Decision#ALLOWED} — 등록·활성 판정은 {@link CollectionService}의 몫이다.</li>
 * </ol>
 * <b>두 라우트가 이 함수 하나를 부른다</b> — 복제하면 순서가 갈리고 계약이 그 순서를 관측한다.
 *
 * <h2>loopback 판정의 경계</h2>
 * {@code 127.0.0.0/8}의 <b>점4자리 IP</b>와 {@code localhost}·{@code ::1}·{@code [::1]}뿐이다. 좁히면
 * ({@code "127.0.0.1".equals}) {@code 127.0.0.2}로 띄운 인스턴스의 수집이 죽고, 넓히면
 * ({@code startsWith("127.")}) 호스트명 {@code 127.example.com}이 loopback으로 오판돼 <b>게이트가 개방
 * 쪽으로 틀린다</b>(실제 바인딩은 DNS 결과를 따르므로 보장이 없다). 모르는 값(null·빈 값)은 loopback이
 * <b>아니다</b> — 그래야 틀릴 때 닫히는 쪽으로 틀린다.
 *
 * <p>{@code harness.news.web.CsrfOriginFilter}의 loopback 판정과 <b>공유하지 않는다</b>: 저쪽 입력은
 * {@code http://host:port} origin URL이고 이쪽은 바인드 주소 문자열({@code 0.0.0.0}·{@code ::})이라
 * 문법이 다르다(server/index.js 126~127행이 같은 이유로 분리했다).
 */
public final class CollectionAccess {

	/**
	 * {@code 127.0.0.0/8} 점4자리 표기. {@code \d}는 Java·JS 모두 ASCII 숫자만이고, 판정은
	 * {@code matches()}(전체 일치)로만 한다.
	 */
	private static final Pattern LOOPBACK_IPV4 = Pattern.compile("127(\\.\\d{1,3}){3}");

	/** 반복 헤더를 Node http 파서가 합치는 방식({@code ", "}). */
	private static final String NODE_HEADER_JOINER = ", ";

	private CollectionAccess() {
	}

	/** 판정 결과 — 상태코드 매핑은 web 계층이 한다(503 · 401 · 통과). */
	public enum Decision {

		/** 비-loopback 바인딩 + 토큰 미설정 — 기능 미가용(503 {@code collection-disabled}). */
		DISABLED,
		/** 토큰이 설정된 서버인데 헤더가 없거나 값이 다르다(401 {@code unauthenticated}). */
		UNAUTHENTICATED,
		/** 게이트 통과 — 이후 판정은 서비스가 한다. */
		ALLOWED
	}

	/** Node {@code isLoopbackHost} 문자 그대로. 비문자열·null은 {@code false}다. */
	public static boolean isLoopbackHost(String host) {
		if (host == null) {
			return false;
		}
		// Node: host.trim().toLowerCase(). trim은 NodeString 단일 출처다(String.trim()은 NBSP를 놓친다).
		String normalized = NodeString.trim(host).toLowerCase(Locale.ROOT);
		if (normalized.equals("localhost") || normalized.equals("::1") || normalized.equals("[::1]")) {
			return true;
		}
		return LOOPBACK_IPV4.matcher(normalized).matches();
	}

	/**
	 * 요청 헤더 값들 → Node가 보는 <b>한 문자열</b>. express({@code req.get})는 반복 헤더를 Node http
	 * 파서가 {@code ", "}로 합친 문자열로 받는다(2026-08-25 실측). Spring {@code getHeader}처럼 <b>첫 값만</b>
	 * 취하면 "첫 값이 옳으면 통과"가 되어 같은 요청에 두 서버가 갈린다 — 결합 문자열은 실제 토큰과
	 * 다르므로 Node에서는 <b>반복 헤더가 언제나 401</b>이다.
	 *
	 * @param values 헤더 값 목록(요청에 없으면 {@code null} 또는 빈 목록)
	 * @return 합쳐진 값. 헤더가 없으면 {@code null}(빈 문자열이 아니다 — 부재와 빈 값은 다르다)
	 */
	public static String headerToken(List<String> values) {
		if (values == null || values.isEmpty()) {
			return null;
		}
		return String.join(NODE_HEADER_JOINER, values);
	}

	/**
	 * 가드 순서를 이 함수 하나가 소유한다.
	 *
	 * @param bindHost 실제 바인드 주소({@code server.address} 파생 — 런타임 탐지 금지)
	 * @param configuredToken 서버에 설정된 수집 토큰. {@code null}·빈 문자열이 '미설정'이다
	 *     (공백 1칸은 '설정됨' — Node truthy 판정 그대로)
	 * @param headerToken 요청이 보낸 토큰({@link #headerToken}의 결과). 부재는 {@code null}
	 */
	public static Decision decide(String bindHost, String configuredToken, String headerToken) {
		boolean tokenConfigured = configuredToken != null && !configuredToken.isEmpty();
		if (!isLoopbackHost(bindHost) && !tokenConfigured) {
			return Decision.DISABLED;
		}
		if (!tokenConfigured) {
			return Decision.ALLOWED; // 토큰 미설정 서버는 헤더를 읽지 않는다.
		}
		if (headerToken == null) {
			return Decision.UNAUTHENTICATED;
		}
		return constantTimeEquals(configuredToken, headerToken) ? Decision.ALLOWED : Decision.UNAUTHENTICATED;
	}

	/**
	 * 관측은 {@code equals}와 같고 타이밍 표면만 닫는다 — 이 비교는 <b>세션이 없는</b> 라우트의 유일한
	 * 인증 수단이라 오프라인 대조 없이 바이트 단위로 탐색당할 이유를 남기지 않는다.
	 */
	private static boolean constantTimeEquals(String expected, String actual) {
		return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
				actual.getBytes(StandardCharsets.UTF_8));
	}
}
