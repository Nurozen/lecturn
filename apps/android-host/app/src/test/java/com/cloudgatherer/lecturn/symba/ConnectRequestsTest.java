package com.cloudgatherer.lecturn.symba;

import org.junit.Test;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import static org.junit.Assert.*;

public final class ConnectRequestsTest {
    @Test public void completedAndCancelledIdsCannotReplayWithinTheDocument() {
        ConnectRequests requests = new ConnectRequests();
        List<JSONObject> replies = new ArrayList<>();
        var first = requests.add("session_1", replies::add);
        assertNull(requests.add("session_1", replies::add));
        first.finish(new JSONObject()); first.finish(new JSONObject());
        assertEquals(1, replies.size());
        assertNull(requests.add("session_1", replies::add));
        var second = requests.add("session_2", replies::add); second.cancel();
        assertNull(requests.add("session_2", replies::add));
        assertEquals(1, replies.size());
    }
    @Test public void navigationCancelsLateReceiptsAndResetsReplayScope() {
        ConnectRequests requests = new ConnectRequests();
        List<JSONObject> replies = new ArrayList<>();
        var old = requests.add("session_1", replies::add);
        requests.clear();
        var replacement = requests.add("session_1", replies::add);
        old.finish(new JSONObject()); assertTrue(replies.isEmpty());
        replacement.finish(new JSONObject()); assertEquals(1, replies.size());
    }
    @Test public void eightPendingLimitDoesNotReopenRejectedIdsWhenSlotsAreFreed() {
        ConnectRequests requests = new ConnectRequests();
        List<ConnectRequests.Pending> pending = new ArrayList<>();
        for (int i = 1; i <= 8; i++) {
            var request = requests.add("session_" + i, ignored -> {});
            assertNotNull(request); pending.add(request);
        }
        assertNull(requests.add("session_9", ignored -> {}));
        pending.get(0).cancel();
        assertNull(requests.add("session_9", ignored -> {}));
        assertNull(requests.add("session_1", ignored -> {}));
        assertNotNull(requests.add("session_10", ignored -> {}));
        assertNull(requests.add("session_11", ignored -> {}));
        pending.get(1).finish(new JSONObject());
        assertNull(requests.add("session_11", ignored -> {}));
        assertNotNull(requests.add("session_12", ignored -> {}));
        for (int i = 2; i < 8; i++) assertTrue(pending.get(i).active());
    }
    @Test public void moreThan4096SettledRequestsKeepWorkingWithoutReopeningOldIds() {
        ConnectRequests requests = new ConnectRequests();
        List<JSONObject> replies = new ArrayList<>();
        for (int i = 1; i <= 10_000; i++) {
            var request = requests.add("session_" + i, replies::add);
            assertNotNull(request);
            if (i % 2 == 0) request.finish(new JSONObject()); else request.cancel();
        }
        assertEquals(5_000, replies.size());
        for (int counter : new int[] {1, 2, 4096, 9999, 10000}) {
            assertNull(requests.add("session_" + counter, replies::add));
        }
        assertNotNull(requests.add("session_10001", replies::add));
    }
    @Test public void counterGapsAndOutOfOrderCompletionDoNotBlockNewRequests() {
        ConnectRequests requests = new ConnectRequests();
        List<JSONObject> replies = new ArrayList<>();
        var first = requests.add("abc123_37", replies::add);
        var second = requests.add("abc123_109", replies::add);
        assertNotNull(first); assertNotNull(second);
        second.finish(new JSONObject()); first.finish(new JSONObject());
        assertEquals(2, replies.size());
        assertNull(requests.add("abc123_38", replies::add));
        assertNull(requests.add("abc123_109", replies::add));
        assertNotNull(requests.add("abc123_201", replies::add));
    }
    @Test public void prefixChangesRequireDocumentClearAndCannotResetTheFence() {
        ConnectRequests requests = new ConnectRequests();
        requests.add("first_8", ignored -> {}).cancel();
        assertNull(requests.add("second_1", ignored -> {}));
        assertNull(requests.add("second_999", ignored -> {}));
        assertNull(requests.add("first_8", ignored -> {}));
        assertNotNull(requests.add("first_9", ignored -> {}));
        requests.clear();
        assertNotNull(requests.add("second_1", ignored -> {}));
        assertNull(requests.add("first_10", ignored -> {}));
    }
    @Test public void invalidIdsCannotClaimThePrefixOrAdvanceTheCounter() {
        String[] invalid = {null, "", "session", "_1", "session_", "session_0", "session_00",
                "session_01", "session_-1", "session_+1", "session_1.5", "session_1e3",
                "session_ 2", "session_2\n", "session_\u0662", "SESSION_2", "ses-sion_2",
                "session_extra_2", "session_9223372036854775808", "session_9007199254740992",
                "session_" + "9".repeat(90), "s".repeat(95) + "_2"};
        for (String id : invalid) {
            ConnectRequests requests = new ConnectRequests();
            assertNull("Invalid first ID: " + id, requests.add(id, ignored -> {}));
            assertNotNull(requests.add("other_1", ignored -> {}));
            requests.clear();
            requests.add("session_1", ignored -> {}).cancel();
            assertNull("Invalid later ID: " + id, requests.add(id, ignored -> {}));
            assertNotNull(requests.add("session_2", ignored -> {}));
        }
    }
    @Test public void countersAreComparedNumericallyThroughJavascriptSafeIntegerLimit() {
        ConnectRequests requests = new ConnectRequests();
        for (String counter : new String[] {"9", "10", "2147483648", "9007199254740990", "9007199254740991"}) {
            var request = requests.add("session_" + counter, ignored -> {});
            assertNotNull(counter, request); request.cancel();
        }
        assertNull(requests.add("session_9007199254740990", ignored -> {}));
        assertNull(requests.add("session_9007199254740991", ignored -> {}));
        assertNull(requests.add("session_9007199254740992", ignored -> {}));
        requests.clear();
        assertNotNull(requests.add("session_1", ignored -> {}));
    }
}
