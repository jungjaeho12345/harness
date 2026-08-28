package harness.news.service;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * {@code POST /api/upload}의 도메인 서비스 — Node {@code server/index.js} 1011~1043행과 1:1이다.
 * HTTP 비의존(ADR-006)이며 서블릿 타입을 하나도 알지 못한다.
 *
 * <h2>이 라우트는 multipart가 아니라 base64 JSON이다</h2>
 * 본문은 {@code {filename, contentBase64}} 둘뿐이다. multipart 표면({@code MultipartResolver} ·
 * {@code MultipartFile} · {@code @RequestPart})을 도입하지 마라 — 존재하지 않는 계약을 구현하는 동시에
 * Content-Type 협상 표면이 새로 생긴다.
 *
 * <h2>게이트 셋과 그 순서가 계약이다</h2>
 * <ol>
 * <li><b>타입</b> — {@code typeof x === 'string'} 동형({@code instanceof String}). 강제변환하지 않는다:
 * 숫자 {@code 12345}는 문자열이 아니다 → {@code invalid-file}.</li>
 * <li><b>확장자</b> — {@link UploadNames#acceptedExtension}(win32 {@code path.extname} + 소문자화 +
 * 화이트리스트 14종)가 비면 {@code invalid-file}.</li>
 * <li><b>크기</b> — <b>디코드된</b> 바이트가 {@link #MAX_BYTES}를 <b>초과</b>하면 {@code too-large}.
 * 원문 길이로 추정하지 마라(base64는 약 4/3로 팽창한다).</li>
 * </ol>
 * 순서를 바꾸면 같은 요청의 사유가 바뀐다 — 확장자 위반 + 6MB 본문은 {@code too-large}가 아니라
 * {@code invalid-file}이다. <b>거부 경로는 디스크를 만지지 않는다</b>(디렉토리조차 만들지 않는다):
 * 저장은 세 게이트를 전부 통과한 뒤 {@link UploadStore}에만 있다.
 *
 * <h2>사유 두 종은 전역 표에 넣지 않는다</h2>
 * {@code invalid-file}·{@code too-large}는 Node에서도 {@code STATUS_BY_REASON}에 없고 라우트가 직접 400을
 * 쓴다(reason-tokens.md 표 2 #3·#4). 폴백이 이미 400이라 값은 같지만, 검증되지 않은 표를 넓히는 것 자체가
 * phase 69 decisions (19)가 금지한 행위다.
 *
 * <h2>저장 실패는 사유가 아니라 예외다</h2>
 * 발급명 충돌·쓰기 실패는 그대로 올라가 전역 핸들러가 500 {@code internal-error}로 만든다(Node는
 * {@code flag:'wx'}에서 예외를 던져 같은 자리에 도달한다). 400으로 접거나 이름을 다시 발급해 재시도하면
 * divergence이자 ADR-008 (6) 위반이다.
 *
 * <h2>디코드는 {@link NodeBase64} 하나뿐이다</h2>
 * Node의 디코더는 관대해서 <b>절대 던지지 않는다</b> — {@code "!!!"}은 400이 아니라 0바이트 파일 + 200이다.
 * {@code java.util.Base64}의 세 디코더 중 어느 것도 이 자리에 쓸 수 없고, 여기서 다시 구현해서도 안 된다.
 */
@Service
public class UploadService {

	/** Node {@code UPLOAD_MAX_BYTES} — 5MB. <b>디코드된</b> 바이트 기준이고 경계값 자신은 성공이다. */
	private static final int MAX_BYTES = 5 * 1024 * 1024;

	private static final String INVALID_FILE = "invalid-file";

	private static final String TOO_LARGE = "too-large";

	private final UploadStore store;

	public UploadService(UploadStore store) {
		this.store = store;
	}

	/**
	 * 업로드 한 건.
	 *
	 * @param filename 요청 {@code filename}(문자열이 아닐 수 있다 — 판정은 이 메서드가 한다)
	 * @param contentBase64 요청 {@code contentBase64}(문자열이 아닐 수 있다)
	 * @return 성공이면 {@code {ok:true, path, filename}}, 거부면 {@code {ok:false, reason}} — <b>키 순서</b>가
	 * Node 응답과 같다(record로 바꾸면 {@code reason:null} 같은 키가 새어 나간다)
	 * @throws IOException 저장 실패 — 사유로 접지 않고 그대로 올린다(전역 핸들러가 500을 만든다)
	 */
	public Map<String, Object> upload(Object filename, Object contentBase64) throws IOException {
		if (!(filename instanceof String name) || !(contentBase64 instanceof String content)) {
			return denied(INVALID_FILE);
		}
		String extension = UploadNames.acceptedExtension(name);
		if (extension.isEmpty()) {
			return denied(INVALID_FILE);
		}
		byte[] bytes = NodeBase64.decode(content);
		if (bytes.length > MAX_BYTES) {
			return denied(TOO_LARGE);
		}
		// 여기까지 와야 파일이 생긴다 — 경로·디렉토리 생성·발급명은 전부 저장소가 소유한다.
		String stored = this.store.save(bytes, extension);

		Map<String, Object> accepted = new LinkedHashMap<>();
		accepted.put("ok", true);
		accepted.put("path", stored);
		// 표시용 반향 — 요청 원문 그대로다(대소문자 보존 · 이스케이프·정규화 금지).
		accepted.put("filename", name);
		return accepted;
	}

	private static Map<String, Object> denied(String reason) {
		Map<String, Object> rejected = new LinkedHashMap<>();
		rejected.put("ok", false);
		rejected.put("reason", reason);
		return rejected;
	}

}
