package harness.news.web;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.Set;

/**
 * 출처(origin) 문자열 다루기 — Node의 {@code new URL(x).origin}·{@code isLoopbackOrigin} 동형.
 *
 * <p><b>파싱 불가는 통과가 아니라 거부다.</b> 해석할 수 없는 Referer는 {@code null}을 돌려주고 호출부가
 * 403을 낸다("이상하면 통과"는 게이트를 우회하는 가장 흔한 경로다).
 */
final class Origins {

	/** 비프로덕션 관용 대상 호스트(포트 무관). IPv6는 {@code [::1]} 형태다 — WHATWG URL의 hostname과 같다. */
	private static final Set<String> LOOPBACK_HOSTS = Set.of("localhost", "127.0.0.1", "[::1]");

	private Origins() {
	}

	/**
	 * Referer 헤더 → origin 문자열.
	 *
	 * @return {@code scheme://host[:port]}(기본 포트는 생략), 해석 불가면 {@code null}
	 */
	static String fromReferer(String referer) {
		return originOf(referer);
	}

	/** 비프로덕션 관용 판정 — loopback 호스트의 http(s) 출처인가. */
	static boolean isLoopback(String origin) {
		String host = hostOf(origin);
		return host != null && LOOPBACK_HOSTS.contains(host);
	}

	private static String originOf(String value) {
		URI uri = parse(value);
		if (uri == null) {
			return null;
		}
		String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
		String host = host(uri);
		if (host == null) {
			return null;
		}
		int port = uri.getPort();
		int defaultPort = "https".equals(scheme) ? 443 : 80;
		return (port == -1 || port == defaultPort) ? scheme + "://" + host : scheme + "://" + host + ":" + port;
	}

	private static String hostOf(String value) {
		URI uri = parse(value);
		return (uri == null) ? null : host(uri);
	}

	/**
	 * {@code http}/{@code https}인 절대 URI만 통과시킨다. 그 외(상대 경로·{@code file:}·{@code javascript:}·
	 * 문자열 {@code "null"})는 origin이 아니다.
	 */
	private static URI parse(String value) {
		if (value == null || value.isBlank()) {
			return null;
		}
		try {
			URI uri = new URI(value.trim());
			String scheme = uri.getScheme();
			if (scheme == null) {
				return null;
			}
			String lower = scheme.toLowerCase(Locale.ROOT);
			return ("http".equals(lower) || "https".equals(lower)) ? uri : null;
		}
		catch (URISyntaxException ex) {
			return null;
		}
	}

	/** 호스트(포트 제외, 소문자). IPv6 리터럴은 대괄호를 유지한다. */
	private static String host(URI uri) {
		String host = uri.getHost();
		return (host == null || host.isEmpty()) ? null : host.toLowerCase(Locale.ROOT);
	}
}
