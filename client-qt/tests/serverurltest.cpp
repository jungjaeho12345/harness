#include "serverurltest.h"

#include "shell/serverurl.h"

#include <QByteArray>
#include <QString>
#include <QtTest>

#include <optional>

using shell::FinalOrigin;
using shell::HealthVerdict;
using shell::NormalizedUrl;

// ---------------------------------------------------------------------------
// normalizeServerUrl - accepted input.
void ServerUrlTest::normalizesOperatorInput_data()
{
    QTest::addColumn<QString>("input");
    QTest::addColumn<QString>("origin");

    // --- lifted from test/client-shell-core.test.js:24-59, 88-94 ---
    QTest::newRow("ip-and-port (operators type bare IP:port)")
        << QStringLiteral("192.168.0.10:3001") << QStringLiteral("http://192.168.0.10:3001");
    QTest::newRow("localhost:port is host:port, not a scheme")
        << QStringLiteral("localhost:3001") << QStringLiteral("http://localhost:3001");
    QTest::newRow("https is kept as typed")
        << QStringLiteral("https://news.example.com") << QStringLiteral("https://news.example.com");
    QTest::newRow("path, query and hash are dropped")
        << QStringLiteral("http://h:3001/login.do?x=1#top") << QStringLiteral("http://h:3001");
    QTest::newRow("trailing slash is dropped")
        << QStringLiteral("http://h:3001/") << QStringLiteral("http://h:3001");
    QTest::newRow("scheme and host are lowercased")
        << QStringLiteral("HTTP://MyServer:3001") << QStringLiteral("http://myserver:3001");
    QTest::newRow("IPv6 keeps its brackets")
        << QStringLiteral("http://[::1]:3001") << QStringLiteral("http://[::1]:3001");
    QTest::newRow("default port 80 is omitted")
        << QStringLiteral("http://h:80") << QStringLiteral("http://h");
    QTest::newRow("default port 443 is omitted")
        << QStringLiteral("https://h:443") << QStringLiteral("https://h");
    QTest::newRow("surrounding spaces are trimmed")
        << QStringLiteral("  http://h:3001  ") << QStringLiteral("http://h:3001");
    QTest::newRow("IPv6 without a scheme gets http://")
        << QStringLiteral("[::1]:3001") << QStringLiteral("http://[::1]:3001");
    QTest::newRow("scheme lookalike keeps only the origin")
        << QStringLiteral("localhost:3001/list.do?x=1") << QStringLiteral("http://localhost:3001");

    // --- Qt-only rows ---
    // R2: QString::trimmed() vs JS String.trim(). Tab/CR/LF/space agree in both; the sets
    // diverge only on exotic separators (see README).
    QTest::newRow("[qt] tabs and newlines are trimmed too")
        << QStringLiteral("\t\n http://h:3001 \r\n") << QStringLiteral("http://h:3001");
    // R11: QUrl::port() is -1 when absent but 0 when the input really says ":0". Guards an
    // origin helper written as "if (port > 0)", which would silently drop the port.
    QTest::newRow("[qt] explicit port 0 is not treated as absent")
        << QStringLiteral("http://h:0") << QStringLiteral("http://h:0");
    QTest::newRow("[qt] uppercase input with a default port")
        << QStringLiteral("HTTPS://H:443/x") << QStringLiteral("https://h");
    // (e) IPv4 octet ranges: new URL("http://192.168.0.300:3001") throws (measured with
    // node), QUrl reads it as an ordinary hostname. This port inherits QUrl's leniency - a
    // typo'd address is accepted here and dies at the probe instead (unreachable). Octet
    // validation belongs to the secure-origin rules (S-N2, step5), not to this module.
    QTest::newRow("[qt] out-of-range IPv4 octet is accepted as a hostname")
        << QStringLiteral("192.168.0.300:3001") << QStringLiteral("http://192.168.0.300:3001");
}

void ServerUrlTest::normalizesOperatorInput()
{
    QFETCH(QString, input);
    QFETCH(QString, origin);

    const NormalizedUrl result = shell::normalizeServerUrl(input);
    QVERIFY2(result.ok, qPrintable(QStringLiteral("rejected with reason=%1").arg(result.reason)));
    QCOMPARE(result.origin, origin);
    QVERIFY(result.reason.isEmpty());
}

// ---------------------------------------------------------------------------
// normalizeServerUrl - rejected input. The reason string is part of the contract.
void ServerUrlTest::rejectsWithCanonicalReason_data()
{
    QTest::addColumn<QString>("input");
    QTest::addColumn<QString>("reason");

    // --- lifted from test/client-shell-core.test.js:61-98 ---
    QTest::newRow("empty string") << QString::fromLatin1("") << QStringLiteral("empty");
    QTest::newRow("whitespace only") << QStringLiteral("   ") << QStringLiteral("empty");
    // The canonical also feeds null/undefined/123/{} here; in C++ the signature is QString,
    // so the closest reachable member of that class is a null QString.
    QTest::newRow("null QString") << QString() << QStringLiteral("empty");

    QTest::newRow("javascript: scheme")
        << QStringLiteral("javascript:alert(1)") << QStringLiteral("unsupported-scheme");
    QTest::newRow("file: scheme")
        << QStringLiteral("file:///C:/x") << QStringLiteral("unsupported-scheme");
    QTest::newRow("data: scheme")
        << QStringLiteral("data:text/html,x") << QStringLiteral("unsupported-scheme");
    QTest::newRow("ws: scheme")
        << QStringLiteral("ws://h:3001") << QStringLiteral("unsupported-scheme");
    QTest::newRow("app: scheme")
        << QStringLiteral("app://x") << QStringLiteral("unsupported-scheme");
    // The exact boundary of the host:port heuristic: the rest after the colon is not digits.
    QTest::newRow("mailto: (non-digit rest)")
        << QStringLiteral("mailto:user@h") << QStringLiteral("unsupported-scheme");

    QTest::newRow("user:pass@host")
        << QStringLiteral("http://user:pass@h:3001") << QStringLiteral("credentials");
    QTest::newRow("user@host")
        << QStringLiteral("http://user@h:3001") << QStringLiteral("credentials");

    QTest::newRow("scheme with an empty authority")
        << QStringLiteral("http://") << QStringLiteral("invalid");
    QTest::newRow("non-numeric port")
        << QStringLiteral("http://h:port") << QStringLiteral("invalid");
    QTest::newRow("space inside the host")
        << QStringLiteral("http://my server:3001") << QStringLiteral("invalid");
    QTest::newRow("space inside the IP")
        << QStringLiteral("192.168. 0.10:3001") << QStringLiteral("invalid");

    // --- Qt-only rows: deliberate divergence, see README ---
    // WHATWG collapses the slashes for special schemes and infers the host ("http:/x" and
    // "http:///x" both parse to origin http://x - measured with node). QUrl does not, so
    // this port rejects them instead of guessing a host. Rejecting is fail-closed: the
    // stored server address is never a host the operator did not type.
    QTest::newRow("[qt] single slash, no authority")
        << QStringLiteral("http:/x") << QStringLiteral("invalid");
    QTest::newRow("[qt] empty authority with a path")
        << QStringLiteral("http:///x") << QStringLiteral("invalid");
}

void ServerUrlTest::rejectsWithCanonicalReason()
{
    QFETCH(QString, input);
    QFETCH(QString, reason);

    const NormalizedUrl result = shell::normalizeServerUrl(input);
    QVERIFY2(!result.ok, qPrintable(QStringLiteral("accepted as origin=%1").arg(result.origin)));
    QCOMPARE(result.reason, reason);
    QVERIFY(result.origin.isEmpty());
}

// ---------------------------------------------------------------------------
void ServerUrlTest::buildsHealthUrl()
{
    // test/client-shell-core.test.js:100-103. appUrl() is intentionally not ported (R13).
    QCOMPARE(shell::healthUrl(QStringLiteral("http://h:3001")),
             QStringLiteral("http://h:3001/api/health"));
    QCOMPARE(shell::healthUrl(QStringLiteral("https://news.example.com")),
             QStringLiteral("https://news.example.com/api/health"));
}

// ---------------------------------------------------------------------------
void ServerUrlTest::comparesOrigins_data()
{
    QTest::addColumn<QString>("url");
    QTest::addColumn<QString>("origin");
    QTest::addColumn<bool>("same");

    // --- lifted from test/client-shell-core.test.js:105-111 ---
    QTest::newRow("same origin, different path")
        << QStringLiteral("http://h:3001/list.do?p=1") << QStringLiteral("http://h:3001") << true;
    QTest::newRow("different port")
        << QStringLiteral("http://h:3002/list.do") << QStringLiteral("http://h:3001") << false;
    QTest::newRow("different scheme")
        << QStringLiteral("https://h:3001/") << QStringLiteral("http://h:3001") << false;
    QTest::newRow("unparseable url (fail-closed)")
        << QStringLiteral("not a url") << QStringLiteral("http://h:3001") << false;
    QTest::newRow("unparseable origin (fail-closed)")
        << QStringLiteral("http://h:3001/") << QStringLiteral("garbage") << false;

    // --- Qt-only rows ---
    QTest::newRow("[qt] default port spelling is the same origin")
        << QStringLiteral("http://h:80/x") << QStringLiteral("http://h") << true;
    QTest::newRow("[qt] IPv6 spelling is the same origin")
        << QStringLiteral("http://[::1]:3001/x") << QStringLiteral("http://[::1]:3001") << true;
    QTest::newRow("[qt] non-special scheme, same host")
        << QStringLiteral("ftp://h/x") << QStringLiteral("ftp://h/y") << true;
    // Deliberate divergence (README): WHATWG gives every non-special URL the opaque origin
    // string "null", so the canonical answers true for two different app:// URLs. This port
    // compares real components and answers false - fail-closed, which is the direction the
    // caller (open-in-default-browser policy) wants.
    QTest::newRow("[qt] non-special scheme, different host")
        << QStringLiteral("app://a") << QStringLiteral("app://b") << false;
}

void ServerUrlTest::comparesOrigins()
{
    QFETCH(QString, url);
    QFETCH(QString, origin);
    QFETCH(bool, same);

    QCOMPARE(shell::isSameOrigin(url, origin), same);
}

// ---------------------------------------------------------------------------
void ServerUrlTest::resolvesFinalOrigin_data()
{
    QTest::addColumn<QString>("requested");
    QTest::addColumn<bool>("hasResponseUrl");
    QTest::addColumn<QString>("responseUrl");
    QTest::addColumn<QString>("origin");
    QTest::addColumn<bool>("changed");

    const QString req = QStringLiteral("http://h:3001");

    // --- promotion: test/client-probe-origin.test.js:22-43 ---
    QTest::newRow("promote another host")
        << QStringLiteral("http://a:3001") << true
        << QStringLiteral("http://b:4000/api/health?x=1#top") << QStringLiteral("http://b:4000") << true;
    QTest::newRow("promote another port")
        << req << true << QStringLiteral("http://h:8080/api/health")
        << QStringLiteral("http://h:8080") << true;
    QTest::newRow("promote the https upgrade")
        << req << true << QStringLiteral("https://h:3001/api/health")
        << QStringLiteral("https://h:3001") << true;

    // --- same origin: test/client-probe-origin.test.js:46-71 ---
    QTest::newRow("no redirect at all")
        << req << true << QStringLiteral("http://h:3001/api/health") << req << false;
    QTest::newRow("redirect inside the same origin")
        << req << true << QStringLiteral("http://h:3001/login.do?next=1") << req << false;
    QTest::newRow(":80 spelled out is the same origin")
        << QStringLiteral("http://h") << true << QStringLiteral("http://h:80/api/health")
        << QStringLiteral("http://h") << false;
    QTest::newRow(":443 spelled out is the same origin")
        << QStringLiteral("https://h") << true << QStringLiteral("https://h:443/api/health")
        << QStringLiteral("https://h") << false;

    // --- fail-safe: test/client-probe-origin.test.js:74-117 ---
    // The canonical also feeds 123/{}/[..] here; the C++ signature makes those unreachable.
    QTest::newRow("no final URL observed")
        << req << false << QString() << req << false;
    QTest::newRow("null QString final URL")
        << req << true << QString() << req << false;
    QTest::newRow("not a url")
        << req << true << QStringLiteral("not a url") << req << false;
    QTest::newRow("scheme only")
        << req << true << QStringLiteral("http://") << req << false;
    QTest::newRow("empty string")
        << req << true << QString::fromLatin1("") << req << false;
    QTest::newRow("chrome-error scheme")
        << req << true << QStringLiteral("chrome-error://chromewebdata/") << req << false;
    QTest::newRow("file scheme")
        << req << true << QStringLiteral("file:///C:/x.html") << req << false;
    QTest::newRow("data scheme")
        << req << true << QStringLiteral("data:text/html,x") << req << false;
    QTest::newRow("ftp scheme")
        << req << true << QStringLiteral("ftp://h/x") << req << false;
    QTest::newRow("credentials user:pass")
        << req << true << QStringLiteral("http://user:pass@evil:9/api/health") << req << false;
    QTest::newRow("credentials user only")
        << req << true << QStringLiteral("http://user@evil:9/") << req << false;
    // The one direction that is blocked. Its mirror image (http -> https) is promoted three
    // rows up; implementing this symmetrically re-opens the hole it exists to close.
    QTest::newRow("https downgraded to http, same host")
        << QStringLiteral("https://h:3001") << true << QStringLiteral("http://h:3001/api/health")
        << QStringLiteral("https://h:3001") << false;
    QTest::newRow("https downgraded to http, other host")
        << QStringLiteral("https://a") << true << QStringLiteral("http://b:8080/api/health")
        << QStringLiteral("https://a") << false;

    // --- Qt-only rows ---
    // R24 has no fixture in the canonical: isHttpsOrigin() is fail-open-to-general-rule, so an
    // unparseable requested origin must NOT block a downgrade-looking promotion. Flipping that
    // helper to fail-closed is invisible to every canonical test (verified against node).
    QTest::newRow("[qt] unparseable requested origin still promotes (R24 fail-open)")
        << QStringLiteral("garbage") << true << QStringLiteral("http://h:3001/api/health")
        << QStringLiteral("http://h:3001") << true;
    QTest::newRow("[qt] empty requested origin still promotes (R24 fail-open)")
        << QString::fromLatin1("") << true << QStringLiteral("http://h:3001/api/health")
        << QStringLiteral("http://h:3001") << true;
    // Same origin helper as normalizeServerUrl: uppercase + default port must fold here too.
    QTest::newRow("[qt] uppercase final URL folds to the same origin")
        << QStringLiteral("http://h") << true << QStringLiteral("HTTP://H:80/x")
        << QStringLiteral("http://h") << false;
}

void ServerUrlTest::resolvesFinalOrigin()
{
    QFETCH(QString, requested);
    QFETCH(bool, hasResponseUrl);
    QFETCH(QString, responseUrl);
    QFETCH(QString, origin);
    QFETCH(bool, changed);

    std::optional<QString> response;
    if (hasResponseUrl)
        response = responseUrl;

    const FinalOrigin result = shell::resolveFinalOrigin(requested, response);
    QCOMPARE(result.origin, origin);
    QCOMPARE(result.changed, changed);
}

// ---------------------------------------------------------------------------
void ServerUrlTest::interpretsHealthResponse_data()
{
    QTest::addColumn<int>("status");
    QTest::addColumn<QByteArray>("body");
    QTest::addColumn<bool>("ok");
    QTest::addColumn<QString>("reason");

    const QByteArray okBody = QByteArrayLiteral("{\"ok\":true}");

    // --- lifted from test/client-shell-core.test.js:113-136 ---
    QTest::newRow("200 with {ok:true}") << 200 << okBody << true << QString();

    QTest::newRow("200 with {}")
        << 200 << QByteArrayLiteral("{}") << false << QStringLiteral("not-article-server");
    QTest::newRow("200 with {ok:false}")
        << 200 << QByteArrayLiteral("{\"ok\":false}") << false << QStringLiteral("not-article-server");
    QTest::newRow("200 with an html portal page")
        << 200 << QByteArrayLiteral("<html>portal</html>") << false << QStringLiteral("not-article-server");
    QTest::newRow("200 with no body at all")
        << 200 << QByteArray() << false << QStringLiteral("not-article-server");
    QTest::newRow("200 with a json null")
        << 200 << QByteArrayLiteral("null") << false << QStringLiteral("not-article-server");
    QTest::newRow("200 with a json array")
        << 200 << QByteArrayLiteral("[1]") << false << QStringLiteral("not-article-server");
    QTest::newRow("200 with a json string")
        << 200 << QByteArrayLiteral("\"ok\"") << false << QStringLiteral("not-article-server");
    QTest::newRow("200 with {ok:\"true\"} (string, not boolean)")
        << 200 << QByteArrayLiteral("{\"ok\":\"true\"}") << false << QStringLiteral("not-article-server");

    QTest::newRow("401") << 401 << okBody << false << QStringLiteral("http-status");
    QTest::newRow("404") << 404 << okBody << false << QStringLiteral("http-status");
    QTest::newRow("500") << 500 << okBody << false << QStringLiteral("http-status");
    QTest::newRow("302") << 302 << okBody << false << QStringLiteral("http-status");

    QTest::newRow("no http response at all") << -1 << QByteArray() << false << QStringLiteral("unreachable");

    // --- Qt-only rows ---
    QTest::newRow("[qt] 200 with {ok:1} (number, not boolean)")
        << 200 << QByteArrayLiteral("{\"ok\":1}") << false << QStringLiteral("not-article-server");
    QTest::newRow("[qt] 200 with truncated json")
        << 200 << QByteArrayLiteral("{\"ok\":true") << false << QStringLiteral("not-article-server");
    QTest::newRow("[qt] 200 with a whitespace body")
        << 200 << QByteArrayLiteral("   ") << false << QStringLiteral("not-article-server");
    QTest::newRow("[qt] 200 with extra keys is still ok")
        << 200 << QByteArrayLiteral("{\"ok\":true,\"extra\":\"x\"}") << true << QString();
    // status 0 is a real (if odd) HTTP status here, not the network-failure sentinel: the
    // canonical only treats a *missing* status as unreachable.
    QTest::newRow("[qt] status 0 is an http status, not unreachable")
        << 0 << okBody << false << QStringLiteral("http-status");
    QTest::newRow("[qt] any negative status is unreachable")
        << -99 << QByteArray() << false << QStringLiteral("unreachable");
}

void ServerUrlTest::interpretsHealthResponse()
{
    QFETCH(int, status);
    QFETCH(QByteArray, body);
    QFETCH(bool, ok);
    QFETCH(QString, reason);

    const HealthVerdict verdict = shell::interpretHealthResponse(status, body);
    QCOMPARE(verdict.ok, ok);
    QCOMPARE(verdict.reason, reason);
}

// ---------------------------------------------------------------------------
// X3: there must be exactly one origin-assembly helper. QUrl has no origin accessor, so the
// spelling is hand-built - and a second, slightly different builder would make the same
// origin come out two ways, splitting the same-origin decision. This test walks one input
// through all three entry points and demands one spelling.
void ServerUrlTest::originSpellingIsConsistentAcrossEntryPoints_data()
{
    QTest::addColumn<QString>("input");

    QTest::newRow("plain host and port") << QStringLiteral("http://h:3001/x?y=1#z");
    QTest::newRow("default port 80 spelled out") << QStringLiteral("http://h:80/x");
    QTest::newRow("default port 443 spelled out") << QStringLiteral("https://h:443/x");
    QTest::newRow("IPv6 literal") << QStringLiteral("http://[::1]:3001/x");
    QTest::newRow("uppercase scheme and host") << QStringLiteral("HTTP://H:3001/x");
    QTest::newRow("explicit port 0") << QStringLiteral("http://h:0/x");
}

void ServerUrlTest::originSpellingIsConsistentAcrossEntryPoints()
{
    QFETCH(QString, input);

    const NormalizedUrl normalized = shell::normalizeServerUrl(input);
    QVERIFY2(normalized.ok, qPrintable(QStringLiteral("rejected with reason=%1").arg(normalized.reason)));

    const FinalOrigin resolved =
        shell::resolveFinalOrigin(QStringLiteral("http://seed.example:1"), input);
    QCOMPARE(resolved.origin, normalized.origin);
    QVERIFY(resolved.changed);

    QVERIFY2(shell::isSameOrigin(input, normalized.origin),
             qPrintable(QStringLiteral("isSameOrigin(%1, %2) was false").arg(input, normalized.origin)));
}

// ---------------------------------------------------------------------------
// X2: QUrl and WHATWG URL disagree, and the port carries a correction for each disagreement
// it relies on. This test pins the raw QUrl behaviour those corrections are built on, so that
// a Qt upgrade which changes one of them fails here (loudly) instead of inside a policy
// decision. Every value below was measured on this machine (Qt 6.8.3 / MSVC, 2026-09-10).
void ServerUrlTest::documentsQUrlDivergencesThisPortCorrects()
{
    // (b) A bare "host:port" parses as a scheme - exactly the mis-read the canonical's
    // digit-lookahead repair exists for. Without it, the most common operator input is lost.
    QCOMPARE(QUrl(QStringLiteral("localhost:3001"), QUrl::StrictMode).scheme(),
             QStringLiteral("localhost"));
    // (d) scheme() carries no trailing colon, unlike JS url.protocol ("mailto:").
    QCOMPARE(QUrl(QStringLiteral("mailto:user@h"), QUrl::StrictMode).scheme(),
             QStringLiteral("mailto"));

    // (a) QUrl never throws. "http://" is a *valid* QUrl with an empty host, while
    // new URL("http://") throws - so this port maps "valid but host-less" onto `invalid`.
    const QUrl emptyAuthority(QStringLiteral("http://"), QUrl::StrictMode);
    QVERIFY(emptyAuthority.isValid());
    QVERIFY(emptyAuthority.host(QUrl::FullyEncoded).isEmpty());
    // WHATWG collapses the slashes and infers host "x" from "http:/x"; QUrl keeps it host-less.
    const QUrl oneSlash(QStringLiteral("http:/x"), QUrl::StrictMode);
    QVERIFY(oneSlash.isValid());
    QVERIFY(oneSlash.host(QUrl::FullyEncoded).isEmpty());
    // A non-numeric port is one of the few inputs QUrl itself calls invalid.
    QVERIFY(!QUrl(QStringLiteral("http://h:port"), QUrl::StrictMode).isValid());

    // (c) No origin accessor, and no default-port folding: the ":80" survives parsing, so the
    // omission is the helper's job. -1 (absent) and 0 (written) are different answers.
    QCOMPARE(QUrl(QStringLiteral("http://h:80"), QUrl::StrictMode).port(), 80);
    QCOMPARE(QUrl(QStringLiteral("http://h"), QUrl::StrictMode).port(), -1);
    QCOMPARE(QUrl(QStringLiteral("http://h:0"), QUrl::StrictMode).port(), 0);
    // host() drops the IPv6 brackets that url.origin keeps - the helper puts them back.
    QCOMPARE(QUrl(QStringLiteral("http://[::1]:3001"), QUrl::StrictMode).host(QUrl::FullyEncoded),
             QStringLiteral("::1"));

    // (e) QUrl is more permissive about IPv4 literals than WHATWG, which rejects an octet
    // above 255 outright. The dead range check the canonical inherits from new URL() is
    // therefore alive in Qt - and deliberately left unimplemented here (see README).
    QVERIFY(QUrl(QStringLiteral("http://192.168.0.300:3001"), QUrl::StrictMode).isValid());

    // Case normalisation of scheme and host QUrl does do for us.
    const QUrl uppercase(QStringLiteral("HTTP://MyServer:3001"), QUrl::StrictMode);
    QCOMPARE(uppercase.scheme(), QStringLiteral("http"));
    QCOMPARE(uppercase.host(QUrl::FullyEncoded), QStringLiteral("myserver"));
}
