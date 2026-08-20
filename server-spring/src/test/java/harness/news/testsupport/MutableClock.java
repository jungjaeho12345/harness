package harness.news.testsupport;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

/**
 * 테스트용 가변 시계 — 세션 슬라이딩 만료처럼 "시간이 흐른 뒤"를 결정적으로 재현하기 위한 주입 seam.
 *
 * <p>{@link Clock#fixed}는 값을 바꿀 수 없어 만료 경계(직전/정각/경과)를 한 테스트 안에서 왕복할 수 없다.
 * 프로덕션 코드는 {@code System.currentTimeMillis()}를 직접 부르지 않고 주입된 {@link Clock}만 읽으므로
 * (decisions (14)), 이 시계를 물리면 1시간 만료를 밀리초 단위로 관측할 수 있다.
 *
 * <p>{@code volatile}인 이유는 동시성 테스트가 여러 스레드에서 시각을 읽기 때문이다(값 변경은 테스트
 * 스레드 한 곳에서만 한다).
 */
public final class MutableClock extends Clock {

	private volatile long epochMs;

	public MutableClock(long epochMs) {
		this.epochMs = epochMs;
	}

	/** 시각을 절대값으로 지정한다. */
	public void setMillis(long epochMs) {
		this.epochMs = epochMs;
	}

	/** 시각을 앞으로 감는다(음수면 되감는다). */
	public void advance(long deltaMs) {
		this.epochMs += deltaMs;
	}

	@Override
	public ZoneId getZone() {
		return ZoneOffset.UTC;
	}

	@Override
	public Clock withZone(ZoneId zone) {
		return this; // 저장 표현이 epoch ms라 이 시계에는 지역 개념이 없다.
	}

	@Override
	public Instant instant() {
		return Instant.ofEpochMilli(this.epochMs);
	}

	@Override
	public long millis() {
		return this.epochMs;
	}
}
