package com.cloudgatherer.lecturn.symba;

import org.junit.Test;
import static org.junit.Assert.*;

public class OriginPolicyTest {
    @Test public void connectAllowsOnlySecureFetchFromLocalDocument() {
        var headers = java.util.Map.of("Origin", OriginPolicy.ORIGIN, "Sec-Fetch-Dest", "empty", "Accept", "application/json");
        assertTrue(OriginPolicy.isConnectRequest("https://relay.example.test/api/environments", false, headers));
        assertTrue(OriginPolicy.isConnectRequest("https://remote.example.test/api/auth/bootstrap", false,
                java.util.Map.of("origin", OriginPolicy.ORIGIN, "accept", "application/json")));
        assertTrue(OriginPolicy.isConnectRequest("https://relay.example.test/v1/environments", false,
                java.util.Map.of("Origin", OriginPolicy.ORIGIN, "Authorization", "DPoP synthetic")));
        assertTrue(OriginPolicy.isConnectRequest("https://relay.example.test/v1/environments", false,
                java.util.Map.of("Origin", OriginPolicy.ORIGIN, "Access-Control-Request-Method", "POST")));
        assertFalse(OriginPolicy.isConnectRequest("https://relay.example.test/runtime.js", false,
                java.util.Map.of("Origin", OriginPolicy.ORIGIN, "Accept", "*/*")));
        assertFalse(OriginPolicy.isConnectRequest("https://relay.example.test/", true, headers));
        for (String url : new String[]{"http://relay.example.test/api", "https://user@relay.example.test/api", "https://localhost/api", "http://127.0.0.1:18768/v1/state", "file:///data/private"})
            assertFalse(url, OriginPolicy.isConnectRequest(url, false, headers));
        for (String destination : new String[]{"script", "iframe", "document", "style", "worker", "image"})
            assertFalse(destination, OriginPolicy.isConnectRequest("https://relay.example.test/api", false,
                    java.util.Map.of("Origin", OriginPolicy.ORIGIN, "Sec-Fetch-Dest", destination, "Accept", "application/json")));
        assertFalse(OriginPolicy.isConnectRequest("https://relay.example.test/api", false, java.util.Map.of()));
        assertFalse(OriginPolicy.isConnectRequest("https://relay.example.test/api", false,
                java.util.Map.of("Origin", "https://other.example.test", "Sec-Fetch-Dest", "empty")));
    }
    @Test public void acceptsOnlyExactLoopbackOrigin() {
        assertTrue(OriginPolicy.isUi("http://127.0.0.1:3773"));
        assertTrue(OriginPolicy.isUi("http://127.0.0.1:3773/projects/a?x=b"));
        for (String url : new String[]{null, "http://localhost:3773", "http://127.0.0.1", "https://127.0.0.1:3773", "http://127.0.0.1:18768/v1/state", "http://127.0.0.1:3773.evil.test", "http://127.0.0.1:3773@evil.test", "http://user@127.0.0.1:3773", "http://127.0.0.1:03773", "http://127.0.0.1:3773\\@evil.test", "http://127.0.0.1:3773\n/", "http://[::1]:3773", "file:///data/private", "javascript:alert(1)", "intent://launch", "content://private", "data:text/html,evil"}) {
            assertFalse(String.valueOf(url), OriginPolicy.isUi(url));
        }
    }
    @Test public void chatEntryKeepsSelectedPathWithoutQueryOrFragmentCredentials() {
        assertEquals(OriginPolicy.ORIGIN + "/env/thread", OriginPolicy.chatStateUrl(OriginPolicy.ORIGIN + "/env/thread?token=synthetic#secret"));
        assertNull(OriginPolicy.chatStateUrl(OriginPolicy.ORIGIN + "/pair?token=synthetic"));
        assertNull(OriginPolicy.chatStateUrl("https://evil.test/env/thread"));
        assertNull(OriginPolicy.chatStateUrl("http://user@127.0.0.1:3773/env/thread"));
    }
    @Test public void browserOnlyAcceptsHttpsWithoutUserinfo() {
        assertTrue(OriginPolicy.isExternal("https://accounts.example.test/oauth?code=synthetic"));
        for (String url : new String[]{"http://accounts.example.test", "https://user:pass@example.test", "javascript:alert(1)", "intent://x", "file:///x", "https://localhost:3773", "https://127.0.0.1:3773", "https:///missing-host", "//example.test"}) {
            assertFalse(url, OriginPolicy.isExternal(url));
        }
    }
}
