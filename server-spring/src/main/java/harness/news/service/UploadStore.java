package harness.news.service;

import harness.news.config.AppProperties;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * 업로드 파일 저장 어댑터 — Node {@code server/index.js} 1011~1043행의 파일 쓰기 세 줄과 1:1이다
 * ({@code fs.mkdirSync(uploadDir,{recursive:true})} · {@code crypto.randomBytes(16).toString('hex')} ·
 * {@code fs.writeFileSync(..., {flag:'wx'})}).
 *
 * <p><b>이 파일은 이 서버에서 파일을 쓰는 두 자리 중 하나다</b>({@code Adr008DisciplineTest} 4군 예외 ② —
 * 다른 하나는 배부 스풀 게시 {@code SpoolWriter}). ADR-008의 파일 쓰기 금지가 말하는 것은 "앱이 몰래
 * 어딘가에 쓰지 않는다"인데 {@code POST /api/upload}는 <b>파일 저장이 라우트의 정의</b>다. 예외는
 * <b>4군(파일 쓰기)에만</b> 열려 있다 — 여기서도 타이머·재시도·비동기·네트워크는 금지이고, 정적 게이트가
 * 그 사실을 자기 검사로 못 박는다({@code theExemptionAppliesOnlyToItsOwnFileAndItsOwnGroup}).
 *
 * <h2>예외 면적을 좁히는 자기 규율</h2>
 * 정적 스캔은 "무엇을 부르는가"만 보고 <b>"어디에 쓰는가"는 보지 못한다</b> — 예외 파일 안에서 경로 합성이
 * 틀리면 게이트는 green이다. 그래서 이 클래스는 스스로를 좁힌다.
 * <ol>
 * <li><b>경로를 밖에서 받지 않는다.</b> uploads 루트는 {@link AppProperties#dataDirPath()}{@code .resolve}
 * <b>한 지점</b>에서만 도출한다 — cwd 상대 경로·기본값 추정은 없다({@code app.data-dir}은 필수 설정이라
 * 추정 경로가 존재할 수 없다). Node {@code createApp}의 기본값 {@code 'uploads'}(cwd 상대)는 테스트 잔재이며
 * 이식 대상이 아니다 — 그것을 이식하면 프로세스 cwd(=리포)에 업로드 파일을 떨군다.</li>
 * <li><b>호출자가 준 문자열을 경로에 이어 붙이는 API를 노출하지 않는다.</b> 파일명은 언제나 자기가 발급한
 * {@code <32hex>.<ext>}이고, 사용자 {@code filename}은 이 클래스에 도달하지 않는다(확장자 도출은 호출자
 * 책임이고 여기서는 <b>확장자조차 다시 검증</b>한다 — {@link #EXTENSION}).</li>
 * <li><b>발급된 이름도 다시 검증한다.</b> 이름 seam은 주입 가능하므로 그 자체가 경로 합성 표면이다.</li>
 * </ol>
 *
 * <h2>규율</h2>
 * <ul>
 * <li><b>lazy mkdir</b> — 생성자는 파일시스템을 만지지 않는다. {@code createDirectories}는 <b>쓰기 직전</b>에
 * 멱등으로 부른다(Node 동형 · 미설정 환경에서 부팅만으로 디렉토리가 생기지 않는다).</li>
 * <li><b>미덮어쓰기</b> — {@link StandardOpenOption#CREATE_NEW}. Node {@code flag:'wx'}와 같은 자리다.
 * {@code CREATE}/{@code TRUNCATE_EXISTING}로 바꾸면 <b>조용히 덮어쓰기가 된다</b>.</li>
 * <li><b>재시도 0</b> — 이름이 충돌하면 그대로 실패한다(Node는 예외를 던져 500이 된다). 다시 발급해
 * 재시도하면 ADR-008 (6) 위반이자 Node와의 divergence다.</li>
 * <li><b>예외를 삼키지 않는다</b> — 실패는 던져서 전역 핸들러가 500 {@code internal-error}로 만든다.</li>
 * <li><b>절대경로 비유출</b> — 반환값은 응답에 그대로 실리는 상대 경로({@code /uploads/<32hex>.<ext>})이고,
 * 예외 메시지에도 경로·파일명을 담지 않는다(원인 예외는 cause로만 남긴다 — {@code Throwable.toString()}은
 * cause를 찍지 않는다). 그 값이 응답이나 {@code GET /api/logs/digest}로 나가면 서버 파일시스템 구조가
 * 유출된다(ADR-007 · 72 tick 규율과 동형).</li>
 * <li><b>로그 0</b> — 경로·파일명·바이트를 남기지 않는다. 이 클래스에는 로거가 없다.</li>
 * </ul>
 */
@Component
public final class UploadStore {

	/** 데이터 디렉토리 아래 업로드 루트 이름 — Node {@code resolveRuntimePaths}의 {@code uploadDir}와 같다. */
	private static final String UPLOADS_DIR = "uploads";

	/** 응답·DB에 실리는 상대 경로의 접두사({@code Contents.attachmentFile}/{@code referenceFile}에 저장된다). */
	private static final String PATH_PREFIX = "/uploads/";

	/**
	 * 확장자 재검증 — 좁은 형태만 통과한다. {@code ../}·절대경로·NUL·구분자·대문자·공백·점이 전부 걸린다.
	 * 호출자(업로드 서비스)의 화이트리스트가 1차 방어선이고 이것은 <b>심화 방어</b>다.
	 */
	private static final Pattern EXTENSION = Pattern.compile("^[a-z0-9]{1,10}$");

	/** 발급명 재검증 — {@link SecureRandom} 16바이트의 소문자 hex 32자. */
	private static final Pattern ISSUED_NAME = Pattern.compile("^[0-9a-f]{32}$");

	/** 거부·실패 메시지는 <b>고정 문자열</b>이다 — 입력값도 경로도 담지 않는다. */
	private static final String INVALID_EXTENSION = "업로드 확장자가 저장 가능한 형태가 아니다";

	private static final String INVALID_ISSUED_NAME = "업로드 파일명 발급기가 32자 소문자 hex를 내지 않았다";

	private static final String WRITE_FAILED = "업로드 파일 저장에 실패했다";

	/** 발급 이름 seam — 테스트가 충돌을 강제하기 위한 자리다(빈으로 노출하지 않는다). */
	interface NameSource {

		/** 32자 소문자 hex. */
		String nextName();

	}

	private final Path uploadsRoot;

	private final NameSource names;

	/**
	 * 프로덕션 배선 — 기본 seam으로 고정한다({@code HttpApiSourceFetcher}의 테스트 전용 생성자 선례).
	 *
	 * <p>{@code @Autowired}가 필요한 이유는 <b>생성자가 둘</b>이기 때문이다({@code ArticleRepository}가
	 * 같은 자리에 남긴 기록과 동일하다). 2026-08-28 실측: 표시가 없으면 컨테이너가 어느 쪽도 고르지 못하고
	 * "No default constructor found"로 <b>컨텍스트 기동이 통째로 실패</b>한다(구현 라우트가 전멸하며
	 * {@code mvnw verify}에서 239 error로 나타났다). 공개 생성자가 하나뿐이어도 <b>선언된</b> 생성자가
	 * 둘이면 암묵 선택이 성립하지 않는다.
	 */
	@Autowired
	public UploadStore(AppProperties properties) {
		this(properties, new SecureRandomNames());
	}

	/**
	 * 이름 발급 seam 주입(패키지 한정). <b>경로가 아니라 {@link AppProperties}를 받는다</b> — 루트 도출을
	 * 테스트가 우회하면 cwd 상대 경로로 바꾸는 변이를 아무도 잡지 못한다.
	 */
	UploadStore(AppProperties properties, NameSource names) {
		// 도출은 여기 한 지점뿐이다. 생성자는 파일시스템을 만지지 않는다(lazy mkdir).
		this.uploadsRoot = properties.dataDirPath().resolve(UPLOADS_DIR);
		this.names = names;
	}

	/**
	 * 바이트를 uploads 루트 아래 <b>서버가 발급한 이름</b>으로 저장한다.
	 *
	 * @param bytes 저장할 바이트(0바이트도 그대로 쓴다 — Node 동형)
	 * @param extension 소문자 확장자({@code png}·{@code jpg} …). 점을 포함하지 않는다
	 * @return 응답에 그대로 실리는 상대 경로 {@code /uploads/<32hex>.<ext>}
	 * @throws IllegalArgumentException 확장자가 저장 가능한 형태가 아닐 때({@code null} 포함 — NPE가 아니다)
	 * @throws IllegalStateException 이름 발급기가 32자 소문자 hex를 내지 않을 때
	 * @throws IOException 디렉토리 생성·쓰기 실패, 그리고 <b>이름 충돌</b>(기존 파일은 그대로 남는다)
	 */
	public String save(byte[] bytes, String extension) throws IOException {
		if (extension == null || !EXTENSION.matcher(extension).matches()) {
			throw new IllegalArgumentException(INVALID_EXTENSION);
		}
		String issued = this.names.nextName();
		if (issued == null || !ISSUED_NAME.matcher(issued).matches()) {
			throw new IllegalStateException(INVALID_ISSUED_NAME);
		}
		String fileName = issued + "." + extension;
		try {
			// 쓰기 직전 lazy 생성(멱등). 기존 파일은 손대지 않는다.
			Files.createDirectories(this.uploadsRoot);
			// CREATE_NEW = Node flag:'wx' — 이미 있으면 던지고 재시도하지 않는다.
			Files.write(this.uploadsRoot.resolve(fileName), bytes, StandardOpenOption.CREATE_NEW);
		}
		catch (IOException ex) {
			// 원인 예외의 메시지에는 절대경로가 들어 있다 — 겉면은 고정 문자열로 덮고 원인은 cause로만 남긴다.
			throw new IOException(WRITE_FAILED, ex);
		}
		return PATH_PREFIX + fileName;
	}

	/** 기본 발급기 — {@link SecureRandom} 16바이트를 소문자 hex 32자로 쓴다(Node {@code randomBytes(16)}). */
	private static final class SecureRandomNames implements NameSource {

		private final SecureRandom random = new SecureRandom();

		@Override
		public String nextName() {
			byte[] name = new byte[16];
			this.random.nextBytes(name);
			return HexFormat.of().formatHex(name);
		}

	}

}
