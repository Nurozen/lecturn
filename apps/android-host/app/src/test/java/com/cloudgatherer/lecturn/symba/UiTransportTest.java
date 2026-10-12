package com.cloudgatherer.lecturn.symba;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import static org.junit.Assert.*;

public class UiTransportTest {
    private static final String TOKEN = "a".repeat(64); // Synthetic fixture only.
    static final class Connection extends HttpURLConnection {
        int status = 200;
        String type = "application/json", response;
        boolean closed;
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        Connection(String response) throws Exception { super(new URL("http://fixture.invalid")); this.response = response; }
        @Override public int getResponseCode() { return status; }
        @Override public String getContentType() { return type; }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8)); }
        @Override public OutputStream getOutputStream() { return body; }
        @Override public void disconnect() { closed = true; }
        @Override public void connect() {}
        @Override public boolean usingProxy() { return false; }
    }
    private ControlClient control(Connection connection) {
        return new ControlClient(() -> "{\"controlPort\":18768,\"controlToken\":\"" + TOKEN + "\"}", url -> {
            assertEquals("http://127.0.0.1:18768/v1/ui/bootstrap", url.toString());
            return connection;
        });
    }
    @Test public void bootstrapUsesNativeBearerPostAndEmptyBodyOnly() throws Exception {
        Connection connection = new Connection(UiBootstrapTest.response());
        UiBootstrap result = control(connection).bootstrap();
        assertNotNull(result);
        assertEquals("POST", connection.getRequestMethod());
        assertEquals("Bearer " + TOKEN, connection.getRequestProperty("Authorization"));
        assertEquals("{}", connection.body.toString(StandardCharsets.UTF_8));
        assertFalse(connection.getInstanceFollowRedirects()); assertTrue(connection.closed);
        assertFalse(result.pairingUrl.contains(TOKEN));
    }
    @Test public void bootstrapNeverFollowsRedirectsOrReturnsRawErrors() throws Exception {
        for (int status : new int[]{301, 302, 401, 409, 503}) {
            Connection connection = new Connection("secret-response-" + TOKEN); connection.status = status;
            ControlClient.Failure error = assertThrows(ControlClient.Failure.class, () -> control(connection).bootstrap());
            assertFalse(error.getMessage().contains(TOKEN)); assertFalse(error.getMessage().contains("secret-response"));
            assertTrue(connection.closed); assertFalse(connection.getInstanceFollowRedirects());
        }
        Connection connection = new Connection(UiBootstrapTest.response()); connection.type = "text/html";
        assertThrows(ControlClient.Failure.class, () -> control(connection).bootstrap());
    }
    @Test public void webSessionProbeUsesOnlyWebViewCookieAndStrictBoolean() throws Exception {
        for (boolean authenticated : new boolean[]{true, false}) {
            Connection connection = new Connection("{\"authenticated\":" + authenticated + "}");
            UiSessionClient client = new UiSessionClient(url -> {
                assertEquals(OriginPolicy.ORIGIN + "/api/auth/session", url.toString()); return connection;
            });
            assertEquals(authenticated, client.authenticated("session=synthetic"));
            assertEquals("session=synthetic", connection.getRequestProperty("Cookie"));
            assertNull(connection.getRequestProperty("Authorization"));
            assertEquals("GET", connection.getRequestMethod()); assertTrue(connection.closed);
            assertFalse(connection.getInstanceFollowRedirects());
        }
    }
    @Test public void errorsCannotMasqueradeAsUnauthenticatedSessions() throws Exception {
        for (String body : new String[]{"{}", "{\"authenticated\":\"false\"}", "{\"authenticated\":null}", "invalid"}) {
            Connection connection = new Connection(body);
            assertThrows(Exception.class, () -> new UiSessionClient(url -> connection).authenticated(null));
            assertTrue(connection.closed);
        }
        for (int status : new int[]{302, 401, 503}) {
            Connection connection = new Connection("{\"authenticated\":false}"); connection.status = status;
            assertThrows(IOException.class, () -> new UiSessionClient(url -> connection).authenticated(null));
        }
        Connection connection = new Connection("{\"authenticated\":false}"); connection.type = "text/html";
        assertThrows(IOException.class, () -> new UiSessionClient(url -> connection).authenticated(null));
    }
}
