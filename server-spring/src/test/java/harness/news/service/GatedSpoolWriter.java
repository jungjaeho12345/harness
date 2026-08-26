package harness.news.service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 게시 직전에 멈출 수 있는 스풀 파일 seam(<b>테스트 전용</b>) — 재전송 1건이 "쓰기 중"인 창을 결정적으로
 * 연다.
 *
 * <p>{@code retry-in-flight}는 실패 원장 시드로는 도달하지 않는다: 같은 {@code (articleId, targetId)}에
 * 대한 <b>두 요청이 실제로 겹쳐야</b> 한다. main 소스에 지연을 심는 것은 ADR-008 정적 게이트
 * ({@code Adr008DisciplineTest} 1군)가 막으므로, 지연은 <b>테스트 전용 구현체</b>에만 둔다
 * ({@code DistributionRetryServiceTest}의 {@code BlockingFs}와 같은 구성이며, 여기서는 전 기동 와이어
 * 테스트가 빈으로 갈아끼울 수 있도록 별도 파일로 둔다).
 *
 * <p>{@link SpoolWriter.SpoolFs}와 패키지 한정 생성자는 {@code harness.news.service} 안에서만 보이므로
 * 이 클래스도 같은 패키지에 있다 — 컨트롤러 테스트는 {@link #writerFor}만 부른다.
 */
public final class GatedSpoolWriter implements SpoolWriter.SpoolFs {

	private final CountDownLatch entered = new CountDownLatch(1);

	private final CountDownLatch released = new CountDownLatch(1);

	private volatile boolean armed;

	/** 이 seam을 쓰는 스풀 라이터 — 패키지 한정 생성자를 대신 부른다. */
	public static SpoolWriter writerFor(Path rootDir, Clock clock, GatedSpoolWriter gate) {
		return new SpoolWriter(rootDir, clock, gate);
	}

	/** 다음 게시 1회를 멈춘다(그 뒤 게시는 그대로 통과한다). */
	public void arm() {
		this.armed = true;
	}

	/** 쓰기 창이 열릴 때까지 기다린다. */
	public boolean awaitEntered(long timeoutSeconds) throws InterruptedException {
		return this.entered.await(timeoutSeconds, TimeUnit.SECONDS);
	}

	/** 멈춘 게시를 이어가게 한다. */
	public void release() {
		this.released.countDown();
	}

	@Override
	public void createDirectories(Path dir) throws IOException {
		Files.createDirectories(dir);
	}

	@Override
	public void write(Path file, byte[] bytes) throws IOException {
		Files.write(file, bytes);
	}

	@Override
	public void moveAtomically(Path source, Path target) throws IOException {
		if (this.armed) {
			this.armed = false;
			this.entered.countDown();
			try {
				this.released.await(30, TimeUnit.SECONDS);
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
				throw new IOException(ex);
			}
		}
		Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
	}

}
