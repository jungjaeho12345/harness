package harness.news.web;

import java.io.IOException;
import org.jspecify.annotations.Nullable;
import org.springframework.core.io.Resource;
import org.springframework.web.servlet.resource.PathResourceResolver;

/**
 * SPA 정적 자산 조회 — 정본({@code express.static(spaRoot, {dotfiles:'ignore'})})이 여는 파일만 연다.
 *
 * <h2>dotfiles</h2>
 * Node는 {@code dotfiles:'ignore'}로 점으로 시작하는 <b>세그먼트</b>를 막는다. 기본(legacy)값은 마지막
 * 세그먼트만 검사해 점 디렉토리 <b>하위</b> 파일이 그대로 노출되므로({@code /.hidden/secret.txt} → 200)
 * Node가 명시적으로 껐고(1225~1227행), 여기서도 <b>모든 세그먼트</b>를 본다. {@code SPA_DIR}은 운영자
 * 설정값이라 {@code dist} 밖의 루트가 올 수 있다 — {@code .env}·{@code .git}이 그 아래 있을 수 있다는 뜻이다.
 *
 * <p>판정 전에 <b>퍼센트 디코딩</b>한다({@link LibuvNames#decode}) — 하지 않으면 {@code /%2ehidden/secret.txt}가
 * 그대로 통과한다. {@code createRelative}가 보는 이름과 같은 문자열을 봐야 판정이 어긋나지 않는다.
 *
 * <h2>Win32 이름 별칭</h2>
 * {@link LibuvNames}의 판정을 {@code /uploads}와 <b>그대로</b> 공유한다. 이유는 두 가지다: (1) 정본이 404를
 * 내는 표기({@code /assets/app.js.} 등)가 여기서 200이 되면 같은 파일에 URL 별칭이 늘어난다 (2) 예약
 * 장치명({@code /NUL}·{@code /CON})은 <b>실재하는 장치로 열려</b> 리소스 조회가 예외를 던지고 전역 핸들러가
 * <b>500</b>을 만든다 — SPA 루트는 요청 경로가 무한히 자유로운 자리라 그 500은 로그와 함께 반복
 * 호출당할 수 있다(2026-08-29 {@code /uploads} 실측에서 이미 겪은 축이다).
 *
 * <p>경로 탈출은 기본 {@link PathResourceResolver}가 위치 밖 리소스를 거부해 막고, 리소스 체인은 캐시
 * 없이({@code resourceChain} 미사용) 이 리졸버 하나만 둔다.
 */
final class SpaResourceResolver extends PathResourceResolver {

	@Override
	protected @Nullable Resource getResource(String resourcePath, Resource location) throws IOException {
		if (!servable(resourcePath)) {
			// null이면 상위(SpaResourceHandler)가 폴백을 판정하고, 폴백도 아니면 기존 404 경로로 흐른다.
			return null;
		}
		return super.getResource(resourcePath, location);
	}

	/** dotfile 세그먼트가 없고 libuv가 열 수 있는 이름인가. */
	private static boolean servable(String resourcePath) {
		String decoded = LibuvNames.decode(resourcePath);
		if (decoded == null) {
			return false;
		}
		for (String segment : decoded.split("/")) {
			if (LibuvNames.isRelativeSegment(segment)) {
				continue;
			}
			if (segment.charAt(0) == '.') {
				return false;
			}
		}
		return LibuvNames.visible(resourcePath);
	}
}
