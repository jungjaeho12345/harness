package harness.news;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 기사 작성기 Spring 서버 엔트리.
 *
 * <p>이 서버는 스키마를 만들지 않는다(DDL 0 — index.json decisions (4)). 데이터 디렉토리는
 * {@code app.data-dir}(환경변수 {@code DATA_DIR})로 반드시 명시 주입되며, 미주입이면 기동을 거부한다.
 */
@SpringBootApplication
public class NewsServerApplication {

	public static void main(String[] args) {
		SpringApplication.run(NewsServerApplication.class, args);
	}
}
