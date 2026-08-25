package harness.news.config;

import harness.news.service.NodeString;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 수집 인제스트 설정 바인딩({@code app.collection.*}) — fail-closed 판정의 두 입력이다.
 *
 * <h2>왜 {@link AppProperties}에 넣지 않는가</h2>
 * {@code AppProperties}는 record이고 {@code new AppProperties(...)} 호출부가 테스트 9곳에 있다. 컴포넌트를
 * 하나 더하면 그 파일들이 전부 함께 바뀌어야 하고, 무엇보다 <b>설정의 소유 경계</b>가 흐려진다 —
 * 수집이 켜지는 조건은 수집 도메인이 소유한다. 배부 스풀 설정도 같은 이유로 별도 레코드가 된다.
 *
 * <h2>{@code host}는 실제 바인드 주소여야 한다(단일 출처)</h2>
 * {@code application.properties}는 이 값을 <b>{@code ${server.address:127.0.0.1}}</b>에서 파생시킨다.
 * {@code ${HOST:127.0.0.1}}를 한 벌 더 쓰면 출처가 둘이 되어, {@code SERVER_ADDRESS}만 설정된 배포에서
 * Tomcat은 전 인터페이스에 열리는데 fail-closed 판정은 {@code 127.0.0.1}로 남는다 — 수집 2라우트가
 * <b>무토큰으로 개방</b>되는, fail-closed가 막으려던 바로 그 상태다. 행동 단언
 * ({@code CollectionDisabledWireTest})이 그 파생을 잠근다.
 *
 * <p>빈 값·공백은 {@code 127.0.0.1}로 수렴한다 — Node {@code resolveHost}의 규율 그대로다(오타나 빈 .env
 * 항목으로 판정이 "개방"으로 넘어가면 안 된다).
 *
 * <h2>{@code token}은 다듬지 않는다</h2>
 * 서버가 토큰 값을 손보면 클라이언트와 조용히 갈린다. <b>빈 문자열이 '미설정'</b>이고 <b>공백 1칸은
 * '설정됨'</b>이다 — Node {@code if (required && ...)}의 truthy 판정 그대로다. {@code null}은 바인딩이
 * 값을 주지 않은 경우이며 미설정과 같게 본다.
 *
 * @param host 실제 바인드 주소({@code server.address} 파생). loopback이 아니면 토큰이 유일한 방어다
 * @param token 수집 토큰({@code COLLECTION_TOKEN}). 빈 문자열이면 미설정이다
 */
@ConfigurationProperties("app.collection")
public record CollectionProperties(String host, String token) {

	/** Node {@code resolveHost}의 기본값 — 명시 설정이 없으면 loopback이다. */
	public static final String DEFAULT_HOST = "127.0.0.1";

	public CollectionProperties {
		// 다듬기는 NodeString 단일 출처다 — String.trim()/strip()은 JS 공백 집합과 갈린다.
		String trimmed = (host == null) ? "" : NodeString.trim(host);
		host = trimmed.isEmpty() ? DEFAULT_HOST : trimmed;
		token = (token == null) ? "" : token;
	}
}
