package com.cloudgatherer.lecturn.symba;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class ControlClientTest {
    static final class Connection extends HttpURLConnection {
        int status = 409;
        int responseDelayMs;
        String response = "{\"error\":\"runtime_transition_in_progress\"}";
        boolean closed, timeout;
        Connection() throws Exception { super(new URL("http://fixture.invalid")); }
        @Override public int getResponseCode() throws IOException {
            if (timeout || getReadTimeout() < responseDelayMs) throw new SocketTimeoutException("synthetic-private-error");
            return status;
        }
        @Override public String getContentType() { return "application/json"; }
        @Override public InputStream getErrorStream() {
            return new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8));
        }
        @Override public InputStream getInputStream() { return getErrorStream(); }
        @Override public OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
        @Override public void disconnect() { closed = true; }
        @Override public void connect() {}
        @Override public boolean usingProxy() { return false; }
    }
    ControlClient client(Connection c) {
        return new ControlClient(() -> "{\"controlPort\":18768,\"controlToken\":\"" + "a".repeat(64) + "\"}", url -> c);
    }
    ControlClient.Failure failure(Connection c, String path) {
        return assertThrows(ControlClient.Failure.class, () -> client(c).request("POST", path, new JSONObject()));
    }
    @Test public void runtimeConflictIsDistinctFromPolicyConflict() throws Exception {
        for (String path : new String[]{"/v1/runtime/stop", "/v1/runtime/start"}) {
            Connection c = new Connection();
            ControlClient.Failure f = failure(c, path);
            assertTrue(f.transitionConflict); assertFalse(f.conflict);
            assertFalse(f.getMessage().contains("Device access")); assertTrue(c.closed);
        }
        Connection c = new Connection(); c.response = "{\"error\":\"stale_policy_revision\"}";
        ControlClient.Failure f = failure(c, "/v1/policy");
        assertTrue(f.conflict); assertFalse(f.transitionConflict);
        assertFalse(failure(c, "/v1/runtime/stop").conflict);
    }
    @Test public void onlyExactRuntime409AuthorizesReplay() throws Exception {
        for (String response : new String[]{"{}", "invalid", "{\"error\":\"operation_failed_reconcile_before_retry\"}",
                "{\"error\":\"stale_policy_revision\"}", "{\"error\":\"runtime_transition_in_progress-private\"}", "x".repeat(4097)}) {
            Connection c = new Connection(); c.response = response;
            ControlClient.Failure f = failure(c, "/v1/runtime/stop");
            assertFalse(f.transitionConflict); assertFalse(f.conflict);
            assertFalse(f.getMessage().contains("private")); assertTrue(c.closed);
        }
        for (int status : new int[]{400, 401, 503}) {
            Connection c = new Connection(); c.status = status;
            assertFalse(failure(c, "/v1/runtime/stop").transitionConflict);
        }
        Connection c = new Connection(); c.timeout = true;
        ControlClient.Failure f = failure(c, "/v1/runtime/stop");
        assertFalse(f.transitionConflict); assertFalse(f.getMessage().contains("private"));
        assertFalse(failure(new Connection(), "/v1/policy").transitionConflict);
        assertFalse(failure(new Connection(), "/v1/ui/bootstrap").transitionConflict);
    }
    @Test public void stopWaitsForControllerDeadlineAndConfirmationOverhead() throws Exception {
        Connection stop = new Connection(); failure(stop, "/v1/runtime/stop");
        assertEquals(32000, stop.getReadTimeout()); assertEquals(3000, stop.getConnectTimeout());
        assertFalse(stop.getInstanceFollowRedirects());
        Connection start = new Connection(); failure(start, "/v1/runtime/start");
        assertEquals(12000, start.getReadTimeout());
    }
    @Test public void slowShutdownReceiptIsReceivedInsteadOfTimingOut() throws Exception {
        Connection c = new Connection(); c.status = 200; c.responseDelayMs = 29000;
        c.response = """
                {"schemaVersion":1,"runtime":{"status":"stopped","message":"Stopped"},"uiUrl":null,
                "activity":{"state":"idle","threadId":null,"title":"Stopped","detail":"Stopped",
                "taskUrl":null,"completedSteps":null,"totalSteps":null},
                "policy":{"revision":2,"fullAccess":false,"computerUse":false},
                "capabilities":{"appData":true,"computerUse":false}}
                """;
        HostState result = client(c).request("POST", "/v1/runtime/stop", new JSONObject());
        assertEquals("stopped", result.runtime); assertFalse(result.fullAccess); assertTrue(c.closed);
    }
}
