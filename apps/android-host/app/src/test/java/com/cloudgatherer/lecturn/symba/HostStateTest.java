package com.cloudgatherer.lecturn.symba;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class HostStateTest {
    private JSONObject fixture() throws Exception {
        return new JSONObject("""
                {"schemaVersion":1,"runtime":{"status":"ready","message":"Ready"},
                "uiUrl":"http://127.0.0.1:3773",
                "activity":{"state":"working","threadId":"thread-1","title":"Build project","detail":"Compiling",
                "taskUrl":"http://127.0.0.1:3773/projects/a/threads/b","completedSteps":2,"totalSteps":4},
                "policy":{"revision":9,"fullAccess":true,"computerUse":false},
                "capabilities":{"appData":true,"computerUse":false}}
                """);
    }
    private HostState parse(JSONObject json) throws Exception { return HostState.parse(json.toString()); }
    private void rejected(JSONObject json) {
        assertThrows(JSONException.class, () -> HostState.parse(json.toString()));
    }
    @Test public void preservesAuthoritativeActivityAndProgress() throws Exception {
        HostState s = parse(fixture());
        assertTrue(s.working()); assertEquals("Build project", s.title); assertEquals("2 / 4 steps", s.progress());
        assertEquals("thread-1", s.threadId); assertEquals(9, s.revision);
    }
    @Test public void runtimeFailureAndWaitingCannotAnimate() throws Exception {
        JSONObject f = fixture(); f.getJSONObject("runtime").put("status", "error"); assertFalse(parse(f).working());
        f.getJSONObject("runtime").put("status", "ready");
        for (String state : new String[]{"waiting", "idle", "monitoring", "completed", "error", "stale"}) {
            f.getJSONObject("activity").put("state", state); assertFalse(parse(f).working());
        }
    }
    @Test public void nullOptionalDataIsNotInvented() throws Exception {
        JSONObject f = fixture(); f.put("uiUrl", JSONObject.NULL);
        JSONObject a = f.getJSONObject("activity");
        for (String field : new String[]{"threadId", "taskUrl", "completedSteps", "totalSteps"}) a.put(field, JSONObject.NULL);
        HostState s = parse(f); assertNull(s.uiUrl); assertNull(s.threadId); assertNull(s.taskUrl); assertEquals("", s.progress());
    }
    @Test public void rejectsMissingVersionAndNewSchema() throws Exception {
        JSONObject f = fixture(); f.remove("schemaVersion"); rejected(f);
        f.put("schemaVersion", 2); rejected(f); f.put("schemaVersion", "1"); rejected(f);
    }
    @Test public void missingPolicyNeverDefaultsToGranted() throws Exception {
        JSONObject f = fixture(); f.getJSONObject("policy").remove("fullAccess"); rejected(f);
    }
    @Test public void rejectsCoercedBooleansAndRevisions() throws Exception {
        JSONObject f = fixture(); f.getJSONObject("policy").put("fullAccess", "true"); rejected(f);
        f = fixture(); f.getJSONObject("policy").put("revision", 9.5); rejected(f);
        f = fixture(); f.getJSONObject("policy").put("revision", -1); rejected(f);
    }
    @Test public void rejectsInvalidStateAndProgress() throws Exception {
        JSONObject f = fixture(); f.getJSONObject("activity").put("state", "running"); rejected(f);
        f = fixture(); f.getJSONObject("activity").put("completedSteps", 5); rejected(f);
        f = fixture(); f.getJSONObject("activity").put("totalSteps", -1); rejected(f);
        f = fixture(); f.getJSONObject("activity").put("completedSteps", "2"); rejected(f);
    }
    @Test public void rejectsUntrustedUiAndTaskUrls() throws Exception {
        JSONObject f = fixture(); f.put("uiUrl", "https://example.test/pair"); rejected(f);
        f = fixture(); f.getJSONObject("activity").put("taskUrl", "http://127.0.0.1:18768/v1/policy"); rejected(f);
    }
    @Test public void stateUrlsCannotCarryPairingCredentials() throws Exception {
        for (String url : new String[]{"http://127.0.0.1:3773/pair#token=23456789ABCD",
                "http://127.0.0.1:3773/?token=synthetic", "http://127.0.0.1:3773/#token=synthetic"}) {
            JSONObject f = fixture(); f.put("uiUrl", url); rejected(f);
            f = fixture(); f.getJSONObject("activity").put("taskUrl", url); rejected(f);
        }
    }
    @Test public void effectiveGrantRequiresActualCapability() throws Exception {
        JSONObject f = fixture(); f.getJSONObject("capabilities").put("appData", false);
        f.getJSONObject("policy").put("computerUse", true);
        HostState s = parse(f);
        assertFalse(s.effectiveFullAccess()); assertFalse(s.effectiveComputerUse());
        assertFalse(s.allowsPolicy(true, false)); assertFalse(s.allowsPolicy(false, true));
        assertTrue(s.allowsPolicy(false, false));
    }
    @Test public void deviceAndComputerGrantsStayIndependent() throws Exception {
        JSONObject f = fixture(); f.getJSONObject("capabilities").put("computerUse", true);
        HostState s = parse(f); assertTrue(s.effectiveFullAccess()); assertFalse(s.effectiveComputerUse());
        assertFalse(s.allowsPolicy(false, true));
        assertTrue(s.allowsPolicy(true, true));
    }
    @Test public void staleAndConflictingReviewsCannotGrant() throws Exception {
        HostState s = parse(fixture());
        assertTrue(s.canApplyPolicy(9, true, true, false));
        assertFalse(s.canApplyPolicy(8, true, true, false));
        assertFalse(s.canApplyPolicy(9, false, true, false));
        assertFalse(s.canApplyPolicy(9, true, true, true));
    }
    @Test public void aggregateWorkAnimatesWhilePreservingSelectedAttention() throws Exception {
        for (String selected : new String[]{"waiting", "error"}) {
            JSONObject f = fixture();
            f.getJSONObject("activity").put("state", selected).put("hasWorkingTasks", true).put("workingCount", 2);
            HostState state = parse(f);
            assertTrue(state.working()); assertTrue(state.hasWorkingTasks); assertEquals(2, state.workingCount);
            assertEquals(selected, state.activity); assertEquals("thread-1", state.threadId);
            f.getJSONObject("activity").put("hasWorkingTasks", false).put("workingCount", 0);
            assertFalse(parse(f).working());
        }
    }
    @Test public void rejectsPartialInconsistentAndCoercedWorkAggregates() throws Exception {
        for (Object[] pair : new Object[][]{{true, 0}, {false, 1}, {true, -1}, {true, 2147483648L},
                {"true", 1}, {true, "1"}, {true, 1.5}, {JSONObject.NULL, 1}, {true, JSONObject.NULL}}) {
            JSONObject f = fixture();
            f.getJSONObject("activity").put("hasWorkingTasks", pair[0]).put("workingCount", pair[1]);
            rejected(f);
        }
        JSONObject f = fixture(); f.getJSONObject("activity").put("hasWorkingTasks", true); rejected(f);
        f = fixture(); f.getJSONObject("activity").put("workingCount", 1); rejected(f);
    }

}
