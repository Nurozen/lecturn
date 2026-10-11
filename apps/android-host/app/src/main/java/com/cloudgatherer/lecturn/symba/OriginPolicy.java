package com.cloudgatherer.lecturn.symba;

import java.net.URI;
import java.net.URISyntaxException;

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

    static boolean isExternal(String value) {
        URI uri = parse(value);
        return uri != null && "https".equals(uri.getScheme()) && uri.getHost() != null
                && uri.getRawUserInfo() == null && !"127.0.0.1".equals(uri.getHost())
                && !"localhost".equalsIgnoreCase(uri.getHost());
    }

    private static URI parse(String value) {
        if (value == null || value.contains("\\") || value.chars().anyMatch(c -> c < 32 || c == 127)) return null;
        try { return new URI(value); } catch (URISyntaxException e) { return null; }
    }
}
