package harness.p0_spring;

import java.nio.file.Paths;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 정적 서빙 + 빈 배선 — web/dist 를 같은 origin 에서 서빙 (CONTRACT.md 정적 절).
 * 경로는 application.properties 로 외부화(app.spa-dir / app.db-path).
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final String spaDir;
    private final String dbPath;

    public WebConfig(@Value("${app.spa-dir}") String spaDir, @Value("${app.db-path}") String dbPath) {
        this.spaDir = spaDir;
        this.dbPath = dbPath;
    }

    @Bean
    public NewsDb newsDb() {
        return new NewsDb(dbPath); // 사본 읽기 전용 — 리포 원본 news.db 미바인딩.
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        String location = Paths.get(spaDir).toUri().toString();
        if (!location.endsWith("/")) {
            location += "/";
        }
        registry.addResourceHandler("/**").addResourceLocations(location);
    }
}
