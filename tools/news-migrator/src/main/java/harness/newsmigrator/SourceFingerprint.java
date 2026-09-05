package harness.newsmigrator;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

/**
 * 소스 파일의 <b>바이트 지문</b> — 이 phase 의 완료 게이트를 마이그레이터 자신이 재게 만드는 장치다.
 *
 * <h2>왜 도구가 스스로 재는가</h2>
 * "원본은 읽기 전용이다"는 설정으로 표현되고, 설정은 조용히 무시될 수 있다(잘못된 JDBC 파라미터는 예외를
 * 던지지 않는다). 그래서 <b>결과</b>를 잰다: 실행 전후의 크기와 md5 가 같아야 하고, 부산물 파일이 생기지
 * 않아야 한다. 사람이 나중에 {@code md5sum} 을 치는 것에 기대면, 잊은 실행 한 번이 원본을 바꾼 채로
 * 성공으로 보고된다.
 *
 * <h2>부산물을 왜 실행 <em>전에도</em> 보는가</h2>
 * {@code -wal}·{@code -shm}·{@code -journal} 이 이미 있다면 그 DB 는 다른 프로세스가 쓰는 중이거나 WAL
 * 모드다. 그 상태에서 읽은 스냅샷은 "그 순간의 전부"가 아닐 수 있고, 이관은 조용히 일부만 옮긴다.
 * 그래서 시작 자체를 거부하고 사람에게 넘긴다(정지·체크포인트는 컷오버 런북의 일이다).
 *
 * <h2>md5 를 쓰는 이유</h2>
 * 여기서 재는 것은 <b>우연한 변경</b>이지 공격자의 위조가 아니다(공격자는 이미 파일을 쓸 수 있는 위치에
 * 있다). 기준선 문서와 런북이 이미 md5 로 적혀 있으므로 같은 값을 쓴다 — 사람이 두 값을 눈으로 맞출 수
 * 있어야 한다.
 */
public record SourceFingerprint(long size, String md5) {

	/** SQLite 가 쓰기 경로에서 남기는 부산물들. 하나라도 있으면 원본이 "그대로"가 아니다. */
	public static final List<String> SIDECAR_SUFFIXES = List.of("-wal", "-shm", "-journal");

	private static final int BUFFER_BYTES = 64 * 1024;

	/**
	 * 지금 이 순간의 지문을 잰다.
	 *
	 * @throws IllegalStateException 파일이 없거나 · 일반 파일이 아니거나 · 부산물이 이미 있을 때
	 */
	public static SourceFingerprint of(Path source) {
		if (!Files.isRegularFile(source)) {
			throw new IllegalStateException("소스 파일이 없다(만들지 않는다 — 경로 오타가 '0행 이관 성공'이 되는 것을 막는다): "
					+ source.toAbsolutePath());
		}
		List<String> sidecars = sidecarsOf(source);
		if (!sidecars.isEmpty()) {
			throw new IllegalStateException("소스 옆에 부산물이 있다 " + sidecars
					+ " — 다른 프로세스가 쓰는 중이거나 WAL 모드다. 그 상태의 스냅샷은 전부가 아닐 수 있으므로 시작하지 않는다: "
					+ source.toAbsolutePath());
		}
		try {
			return new SourceFingerprint(Files.size(source), md5Of(source));
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	/**
	 * 처음 잰 지문과 지금이 같은지 확인한다. 다르면 <b>비정상 종료</b>다 — 무엇이 달라졌는지 밝힌다.
	 */
	public void requireUnchanged(Path source) {
		SourceFingerprint now = of(source);
		List<String> changes = new ArrayList<>();
		if (size() != now.size()) {
			changes.add("크기 " + size() + " → " + now.size());
		}
		if (!md5().equals(now.md5())) {
			changes.add("md5 " + md5() + " → " + now.md5());
		}
		if (!changes.isEmpty()) {
			throw new IllegalStateException("소스 파일이 실행 중에 바뀌었다(이 도구는 원본을 읽기만 한다): "
					+ source.toAbsolutePath() + " — " + String.join(" · ", changes));
		}
	}

	/** 사람이 런북의 값과 눈으로 맞출 수 있는 형태. */
	public String describe() {
		return size() + " B · md5 " + md5();
	}

	private static List<String> sidecarsOf(Path source) {
		List<String> found = new ArrayList<>();
		for (String suffix : SIDECAR_SUFFIXES) {
			Path sidecar = source.resolveSibling(source.getFileName() + suffix);
			if (Files.exists(sidecar)) {
				found.add(sidecar.getFileName().toString());
			}
		}
		return found;
	}

	private static String md5Of(Path source) throws IOException {
		MessageDigest digest = digest();
		byte[] buffer = new byte[BUFFER_BYTES];
		try (InputStream stream = Files.newInputStream(source)) {
			int read;
			while ((read = stream.read(buffer)) > 0) {
				digest.update(buffer, 0, read);
			}
		}
		return HexFormat.of().formatHex(digest.digest());
	}

	private static MessageDigest digest() {
		try {
			return MessageDigest.getInstance("MD5");
		}
		catch (NoSuchAlgorithmException ex) {
			throw new IllegalStateException("이 JVM 에 MD5 가 없다", ex);
		}
	}

}
