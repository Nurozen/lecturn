package com.cloudgatherer.lecturn.symba;

import java.time.Instant;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class UiBootstrapTest {
    private static final Instant NOW = Instant.parse("2026-10-10T00:00:00Z");
    static String response() {
        return "{\"schemaVersion\":1,\"pairingUrl\":\"http://127.0.0.1:3773/pair#token=23456789ABCD\",\"expiresAt\":\"2099-01-01T00:00:00Z\"}";
    }
    @Test public void acceptsExactBrokerResponseSeparatelyFromState() throws Exception {
        UiBootstrap value = UiBootstrap.parse(response(), NOW);
        assertEquals("http://127.0.0.1:3773/pair#token=23456789ABCD", value.pairingUrl);
        assertThrows(JSONException.class, () -> HostState.parse(response()));
    }
    @Test public void retryNavigatesFreshDocumentWithoutPuttingCredentialInRequestUrl() throws Exception {
        UiBootstrap bootstrap = UiBootstrap.parse(response(), NOW);
        java.net.URI first = java.net.URI.create(bootstrap.navigationUrl());
        java.net.URI second = java.net.URI.create(bootstrap.navigationUrl());
        assertTrue(OriginPolicy.isUi(first.toString()));
        assertEquals("/pair", first.getPath());
        assertNotEquals(first.getQuery(), second.getQuery());
        assertFalse(first.getQuery().contains("23456789ABCD"));
        assertEquals("token=23456789ABCD", first.getFragment());
    }
    @Test public void rejectsOriginsAlternatePathsQueryTokensAndMalformedCredentials() throws Exception {
        for (String url : new String[]{"https://127.0.0.1:3773/pair#token=23456789ABCD",
                "http://localhost:3773/pair#token=23456789ABCD", "http://127.0.0.1:18768/pair#token=23456789ABCD",
                "http://127.0.0.1:3773@evil.test/pair#token=23456789ABCD", "http://127.0.0.1:3773/pair?token=23456789ABCD",
                "http://127.0.0.1:3773/other#token=23456789ABCD", "http://127.0.0.1:3773/pair#token=23456789ABC0",
                "http://127.0.0.1:3773/pair#token=23456789ABCD&next=https://evil.test"}) {
            String json = new JSONObject(response()).put("pairingUrl", url).toString();
            assertThrows(JSONException.class, () -> UiBootstrap.parse(json, NOW));
        }
    }
    @Test public void rejectsExpirySchemaCoercionAndUnexpectedFields() throws Exception {
        for (Object expiry : new Object[]{"2026-10-10T00:00:00Z", "2020-01-01T00:00:00Z", "invalid", 123, JSONObject.NULL}) {
            String json = new JSONObject(response()).put("expiresAt", expiry).toString();
            assertThrows(JSONException.class, () -> UiBootstrap.parse(json, NOW));
        }
        for (Object version : new Object[]{"1", 1.0, 2, JSONObject.NULL}) {
            JSONObject value = new JSONObject(response()).put("schemaVersion", version);
            // JSON serializes 1.0 as 1; use the literal wire value to exercise coercion.
            String json = version.equals(1.0) ? response().replace(":1,", ":1.0,") : value.toString();
            assertThrows(JSONException.class, () -> UiBootstrap.parse(json, NOW));
        }
        String extra = new JSONObject(response()).put("fullAccess", true).toString();
        assertThrows(JSONException.class, () -> UiBootstrap.parse(extra, NOW));
    }
    @Test public void pollingCannotRemintAndOnlyExplicitRetryResetsAttempt() {
        UiPairing pairing = new UiPairing();
        assertTrue(pairing.begin());
        pairing.await(1000, 5000);
        for (int i = 0; i < 100; i++) assertFalse(pairing.begin());
        assertFalse(pairing.expired(5999)); assertTrue(pairing.expired(6000));
        pairing.fail("Expired"); assertFalse(pairing.begin());
        pairing.retry(); assertTrue(pairing.begin());
        pairing.confirm(); assertTrue(pairing.authenticated); assertFalse(pairing.waiting);
        assertFalse(pairing.begin());
    }
    @Test public void pairingWaitIsBoundedEvenForLongExpiry() {
        UiPairing pairing = new UiPairing(); pairing.begin(); pairing.await(1000, 900000);
        assertTrue(pairing.expired(31000));
    }
    @Test public void resumeSessionChecksPreserveHistoryAfterBootstrap() {
        UiPairing pairing = new UiPairing();
        assertFalse(pairing.confirm());
        pairing.retry(); pairing.begin(); pairing.await(1000, 5000);
        assertTrue(pairing.confirm());
        for (int i = 0; i < 5; i++) assertFalse(pairing.confirm());
        assertTrue(pairing.authenticated);
    }
}
