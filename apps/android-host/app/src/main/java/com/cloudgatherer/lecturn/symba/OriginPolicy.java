package com.cloudgatherer.lecturn.symba;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Map;

final class OriginPolicy {
    static final String ORIGIN = "http://127.0.0.1:3773";

    static boolean isUi(String value) {
        URI uri = parse(value);
        return uri != null && "http".equals(uri.getScheme())
                && "127.0.0.1:3773".equals(uri.getRawAuthority());
    }

    static boolean isStateUrl(String value) {
        URI uri = parse(value);
        return isUi(value) && uri.getRawQuery() == null && uri.getRawFragment() == null
                && !"/pair".equals(uri.getPath());
    }

    static String chatStateUrl(String value) {
        if (!isUi(value)) return null;
        String route = ORIGIN + parse(value).getRawPath();
        return isStateUrl(route) ? route : null;
    }

    static boolean isExternal(String value) {
        URI uri = parse(value);
        return uri != null && "https".equals(uri.getScheme()) && uri.getHost() != null
                && uri.getRawUserInfo() == null && !"127.0.0.1".equals(uri.getHost())
                && !"localhost".equalsIgnoreCase(uri.getHost());
    }

    /** Connect APIs use CORS fetch; external documents and executable resources stay outside the host. */
    static boolean isConnectRequest(String value, boolean mainFrame, Map<String, String> headers) {
        if (mainFrame || !isExternal(value)) return false;
        String origin = header(headers, "Origin");
        String destination = header(headers, "Sec-Fetch-Dest");
        // WebView adds Fetch Metadata after this callback on some versions.
        if (!ORIGIN.equals(origin) || (destination != null && !"empty".equals(destination))) return false;
        String accept = header(headers, "Accept");
        String authorization = header(headers, "Authorization");
        String preflight = header(headers, "Access-Control-Request-Method");
        return (accept != null && accept.toLowerCase(java.util.Locale.ROOT).contains("application/json"))
                || (authorization != null && (authorization.startsWith("Bearer ") || authorization.startsWith("DPoP ")))
                || (preflight != null && java.util.Set.of("GET", "POST", "PUT", "PATCH", "DELETE").contains(preflight));
    }

    private static String header(Map<String, String> headers, String name) {
        for (Map.Entry<String, String> entry : headers.entrySet())
            if (name.equalsIgnoreCase(entry.getKey())) return entry.getValue();
        return null;
    }

    private static URI parse(String value) {
        if (value == null || value.contains("\\") || value.chars().anyMatch(c -> c < 32 || c == 127)) return null;
        try { return new URI(value); } catch (URISyntaxException e) { return null; }
    }
}
