package harness.news.web;

import java.io.IOException;
import org.jspecify.annotations.Nullable;
import org.springframework.core.io.Resource;
import org.springframework.web.servlet.resource.PathResourceResolver;

/**
 * {@code /uploads/**} 리소스 조회 — <b>libuv가 보는 파일만</b> 보이게 만든다.
 *
 * <h2>왜 필요한가: 정본과 이 서버는 같은 파일시스템을 서로 다르게 본다</h2>
 * 정본은 {@code express.static} → {@code fs.stat}이고 그 아래는 libuv다. libuv는 경로를
 * {@code \\?\} 장문 형태로 열어 <b>Win32 레거시 이름 정규화를 받지 않는다</b>. 반면 Java의 파일 접근은
 * 그 정규화를 그대로 받는다. 2026-08-29 {@code fs.statSync} 직접 실측(같은 win32 호스트):
 * <pre>
 * "x.png"        ok      "x.png."       ENOENT     "CON"   ENOENT
 * "X.PNG"        ok      "x.png "       ENOENT     "NUL"   ENOENT
 * "x.png::$DATA" ok      "x.png:s"      ENOENT     "AUX"   ENOENT
 * </pre>
 * 그래서 손대지 않으면 <b>정본이 404를 내는 표기가 여기서는 200</b>이 된다(같은 날 와이어 실측:
 * {@code .png.}·{@code .png%20}·{@code .png%2e}·{@code .png..}·{@code .png%20%20}·{@code .png%20.}·
 * {@code <하위디렉토리>./<파일>} 7종이 200이었다). 같은 파일에 URL 별칭이 늘어나는 것 자체가 표면이다 —
 * URL 기준의 차단·캐시·감사 로그가 전부 갈린다.
 *
 * <p>예약 장치명은 더 나쁘다: {@code /uploads/NUL}은 <b>실재하는 장치</b>로 열려 리소스 조회가 예외를
 * 던지고 전역 핸들러가 <b>500</b>을 만든다(정본은 404). 없는 파일이 500이 되는 것은 상태코드 divergence인
 * 동시에 서버 로그를 남기는 자리라 무한히 반복 호출당할 수 있다.
 *
 * <h2>맞추지 <b>않는</b> 것</h2>
 * {@code ::$DATA}(대체 데이터 스트림 기본 표기)와 {@code .PNG}(대소문자 무시)는 <b>정본도 200</b>이다
 * (실측: 각각 {@code application/octet-stream}·{@code image/png}). 여기서 막으면 오히려 divergence가
 * 늘어나므로 건드리지 않는다 — 이 클래스의 규칙은 <b>정본 실측을 재현하는 것</b>이지 강화가 아니다.
 *
 * <h2>왜 이 층인가</h2>
 * "이 이름의 리소스가 존재하는가"를 판정하는 층이 여기다. 필터에서 URL 문자열로 걸면 컨테이너의 디코딩·
 * 정규화와 어긋나는 순간 그 차이가 곧 우회다(그 함정은 {@link PathPolicyFilter} 주석 참조). 리소스 체인은
 * 캐시 없이({@code resourceChain(false)}) 이 리졸버 하나만 두므로 {@code Content-Type}·{@code Cache-Control}
 * 등 응답 헤더는 한 바이트도 달라지지 않는다(계약 {@code x-uploads-static} 관측이 그것을 잠근다).
 */
final class UploadsResourceResolver extends PathResourceResolver {

	/**
	 * 이름 판정은 {@link LibuvNames}가 소유한다 — 2026-09-05(phase 76 step2)에 뽑아냈다. SPA 정적 서빙
	 * ({@link SpaResourceResolver})이 같은 파일시스템 위에서 같은 별칭 문제를 만나므로, 두 리졸버가 각자
	 * 규칙을 들면 한쪽만 늙는다. 규칙 원문과 실측 표는 그 클래스의 javadoc에 있다.
	 */
	@Override
	protected @Nullable Resource getResource(String resourcePath, Resource location) throws IOException {
		if (!LibuvNames.visible(resourcePath)) {
			// null이면 상위가 NoResourceFoundException을 던지고 전역 핸들러가 404 + 비-JSON을 낸다(정본 동형).
			return null;
		}
		return super.getResource(resourcePath, location);
	}

}
