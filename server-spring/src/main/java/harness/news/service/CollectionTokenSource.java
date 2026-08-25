package harness.news.service;

import harness.news.config.CollectionProperties;
import org.springframework.stereotype.Component;

/**
 * 서버에 설정된 수집 토큰을 <b>호출마다</b> 돌려주는 1메서드 seam.
 *
 * <h2>왜 값이 아니라 seam인가</h2>
 * Node는 요청 시점에 {@code process.env.COLLECTION_TOKEN}을 읽고 Java는 {@code System.getenv()}가 프로세스
 * 수명 동안 불변이라, <b>관측상 두 방식은 동일하다</b>. 이 seam이 있는 이유는 패리티가 아니라
 * <b>테스트 가능성</b>이다: 토큰 3상태(미설정 · 설정+일치 · 설정+불일치)를 컨텍스트 재기동 없이 덮어야
 * 가드 순서를 기계로 잠글 수 있다.
 *
 * <p>구현은 값을 <b>다듬지 않는다</b> — 서버가 토큰을 손보면 클라이언트와 조용히 갈린다. 빈 문자열이
 * '미설정'이고 공백 1칸은 '설정됨'이다({@link CollectionProperties}).
 *
 * <p>토큰 값은 로그·예외 메시지·응답 어디에도 담지 않는다.
 */
@FunctionalInterface
public interface CollectionTokenSource {

	/** 현재 설정된 토큰. 미설정이면 빈 문자열이다({@code null}도 미설정으로 본다). */
	String current();

	/** 기본 구현 — 설정 바인딩({@code app.collection.token})에서 읽는다. */
	@Component
	class FromProperties implements CollectionTokenSource {

		private final CollectionProperties properties;

		public FromProperties(CollectionProperties properties) {
			this.properties = properties;
		}

		@Override
		public String current() {
			return this.properties.token();
		}
	}
}
