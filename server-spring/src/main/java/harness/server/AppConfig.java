package harness.server;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 서버 구성 단일 출처(주입) — 런타임 탐지 대신 명시 주입(ADR-010/011 철학 동형).
 *
 * <ul>
 *   <li>{@code app.db-path} — SQLite 파일 경로(읽기·쓰기). 계약 하네스가 임시 시드 DB 경로를 주입한다.
 *       <b>리포 원본 news.db 를 기본값으로 두지 않는다</b>(DB 비파괴). 미주입이면 db 소비 계층이 부팅을 실패시킨다(step1).</li>
 *   <li>{@code app.prod-cookie} — 세션 쿠키 속성 모드. true = Secure + SameSite=None(프로덕션), false = SameSite=Lax(기본).</li>
 * </ul>
 */
@ConfigurationProperties(prefix = "app")
public class AppConfig {

    /** SQLite DB 파일 경로(읽기·쓰기). 기본값 없음 — 하네스/운영이 주입한다. */
    private String dbPath;

    /** 세션 쿠키를 프로덕션 속성(Secure + SameSite=None)으로 발급할지. 기본 false(SameSite=Lax). */
    private boolean prodCookie = false;

    public String getDbPath() {
        return dbPath;
    }

    public void setDbPath(String dbPath) {
        this.dbPath = dbPath;
    }

    public boolean isProdCookie() {
        return prodCookie;
    }

    public void setProdCookie(boolean prodCookie) {
        this.prodCookie = prodCookie;
    }
}
