package com.cloudgatherer.lecturn.symba;

import org.json.JSONObject;
import org.junit.Test;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public class AccessProtocolTest {
    private HostState state(long revision, boolean full, boolean computer, boolean support) throws Exception {
        return HostState.parse(new JSONObject().put("schemaVersion", 1)
                .put("runtime", new JSONObject().put("status", "ready").put("message", "Synthetic"))
                .put("uiUrl", JSONObject.NULL)
                .put("activity", new JSONObject().put("state", "idle").put("threadId", JSONObject.NULL)
                        .put("title", "").put("detail", "").put("taskUrl", JSONObject.NULL)
                        .put("completedSteps", JSONObject.NULL).put("totalSteps", JSONObject.NULL))
                .put("policy", new JSONObject().put("revision", revision).put("fullAccess", full).put("computerUse", computer))
                .put("capabilities", new JSONObject().put("appData", true).put("computerUse", support)).toString());
    }
    @Test public void confirmationRequiresAppliedRevisionAndExactGrants() throws Exception {
        assertTrue(AccessProtocol.applied(state(10, true, false, false), 9, true, false));
        assertFalse(AccessProtocol.applied(state(9, true, false, false), 9, true, false));
        assertFalse(AccessProtocol.applied(state(8, true, false, false), 9, true, false));
        assertFalse(AccessProtocol.applied(state(10, false, false, false), 9, true, false));
        assertFalse(AccessProtocol.applied(null, 9, true, false)); // conflict/disconnect/Stop
        assertFalse(AccessProtocol.applied(state(10, true, true, false), 9, true, true));
        assertTrue(AccessProtocol.applied(state(10, true, true, true), 9, true, true));
    }
    @Test public void revokedAndUnknownNeverReportFull() throws Exception {
        JSONObject missing = AccessProtocol.state(null);
        assertFalse(missing.getBoolean("verified")); assertFalse(missing.getBoolean("fullAccess"));
        assertTrue(missing.isNull("revision"));
        JSONObject revoked = AccessProtocol.state(state(11, false, false, false));
        assertTrue(revoked.getBoolean("verified")); assertFalse(revoked.getBoolean("fullAccess"));
        assertFalse(revoked.getJSONObject("capabilities").getBoolean("computerUse"));
        assertEquals(5, revoked.length());
    }
    @Test public void onlyResumedMainFrameAtExactOriginMayRequestAccess() {
        String origin = "http://127.0.0.1:3773";
        assertTrue(AccessProtocol.acceptsSource(true, true, origin, origin + "/thread"));
        assertFalse(AccessProtocol.acceptsSource(false, true, origin, origin));
        assertFalse(AccessProtocol.acceptsSource(true, false, origin, origin));
        assertFalse(AccessProtocol.acceptsSource(true, true, "https://evil.test", origin));
        assertFalse(AccessProtocol.acceptsSource(true, true, origin, "https://evil.test"));
        assertFalse(AccessProtocol.acceptsSource(true, true, "http://127.0.0.1:18768", origin));
    }
    @Test public void idsAreStrictAndBounded() {
        assertTrue(AccessProtocol.validId("document_12"));
        assertFalse(AccessProtocol.validId(12)); assertFalse(AccessProtocol.validId(""));
        assertFalse(AccessProtocol.validId("x".repeat(97))); assertFalse(AccessProtocol.validId("x\n"));
    }
    @Test public void pendingRequestsAreBoundedAndDrainOnce() {
        AccessRequests requests = new AccessRequests();
        AtomicInteger replies = new AtomicInteger();
        for (int i = 0; i < 16; i++) assertNotNull(requests.add("r" + i, s -> { assertNull(s); replies.incrementAndGet(); }));
        assertNull(requests.add("overflow", s -> fail()));
        assertNull(requests.add("r0", s -> fail()));
        requests.drain(); requests.drain(); assertEquals(16, replies.get());
        assertNotNull(requests.add("next", s -> {}));
    }
    @Test public void canceledDocumentCannotSettleReplacementWithLateReceipt() throws Exception {
        AccessRequests requests = new AccessRequests();
        AtomicInteger replies = new AtomicInteger();
        AccessRequests.Pending old = requests.add("same", s -> { assertNull(s); replies.incrementAndGet(); });
        AtomicInteger cleanups = new AtomicInteger(); old.cleanup = cleanups::incrementAndGet;
        requests.drain();
        AccessRequests.Pending replacement = requests.add("same", s -> replies.incrementAndGet());
        old.finish(state(10, true, false, false));
        assertTrue(replacement.active()); assertEquals(1, replies.get()); assertEquals(1, cleanups.get());
        replacement.finish(null); assertEquals(2, replies.get());
    }
}
