package com.cloudgatherer.lecturn.symba;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class WorkLeaseTest {
    private HostState state(String activity, boolean full, String thread) throws Exception {
        return HostState.parse(new JSONObject("""
                {"schemaVersion":1,"runtime":{"status":"ready","message":"Ready"},"uiUrl":"http://127.0.0.1:3773",
                "activity":{"state":"working","threadId":"task","title":"Task","detail":"", "taskUrl":null,
                "completedSteps":null,"totalSteps":null},"policy":{"revision":1,"fullAccess":true,"computerUse":false},
                "capabilities":{"appData":true,"computerUse":true}}
                """).put("activity", new JSONObject().put("state", activity).put("threadId", thread).put("title", "Task")
                .put("detail", "").put("taskUrl", JSONObject.NULL).put("completedSteps", JSONObject.NULL).put("totalSteps", JSONObject.NULL))
                .put("policy", new JSONObject().put("revision", 1).put("fullAccess", full).put("computerUse", false)).toString());
    }
    @Test public void freshWorkRenewsAcrossLongScreenOffTasks() throws Exception {
        WorkLease lease = new WorkLease(); HostState work = state("working", false, "task");
        assertEquals(WorkLease.Action.ACQUIRE, lease.update(work, true, 0, 0, false));
        for (long now = 15000; now < 3600000; now += 15000)
            assertEquals(WorkLease.Action.ACQUIRE, lease.update(work, true, now, now, true));
    }
    @Test public void repeatedCallbacksCannotRenewAnOldReceipt() throws Exception {
        WorkLease lease = new WorkLease(); HostState work = state("working", true, "task");
        lease.update(work, true, 10, 10, false);
        assertEquals(WorkLease.Action.NONE, lease.update(work, true, 10, 20000, true));
        assertEquals(WorkLease.Action.NONE, lease.update(work, true, 10, 40000, false));
        assertEquals(WorkLease.Action.RELEASE, lease.update(work, false, 10, 20010, true));
    }
    @Test public void uiCallbackCannotTurnAnEarlierReceiptIntoARenewal() throws Exception {
        WorkLease lease = new WorkLease(); HostState work = state("working", false, "task");
        lease.update(work, true, 0, 0, false);
        assertEquals(WorkLease.Action.NONE, lease.update(work, true, 3000, 3000, true));
        assertEquals(WorkLease.Action.NONE, lease.update(work, true, 3000, 16000, true));
        assertEquals(WorkLease.Action.ACQUIRE, lease.update(work, true, 18000, 18000, true));
    }
    @Test public void stopAndNonworkingStatesReleaseImmediately() throws Exception {
        for (String activity : new String[]{"idle", "waiting", "monitoring", "completed", "error", "stale"}) {
            WorkLease lease = new WorkLease(); lease.update(state("working", true, "task"), true, 0, 0, false);
            assertEquals(WorkLease.Action.RELEASE, lease.update(state(activity, true, "task"), true, 1, 1, true));
        }
        assertEquals(WorkLease.Action.RELEASE, new WorkLease().update(state("working", true, "task"), false, 1, 1, true));
    }
    @Test public void deviceGrantOffDoesNotStopOngoingLinuxWork() throws Exception {
        WorkLease lease = new WorkLease(); lease.update(state("working", true, "task"), true, 0, 0, false);
        assertEquals(WorkLease.Action.NONE, lease.update(state("working", false, "task"), true, 1, 1, true));
        assertEquals(WorkLease.Action.ACQUIRE, lease.update(state("working", false, "task"), true, 15000, 15000, true));
        assertEquals(WorkLease.Action.ACQUIRE, lease.update(state("working", false, "task"), true, 30000, 30000, false));
    }
    private HostState aggregate(String runtime, String activity, int count, boolean capability) throws Exception {
        return HostState.parse(new JSONObject()
                .put("schemaVersion", 1).put("runtime", new JSONObject().put("status", runtime).put("message", "Observed"))
                .put("uiUrl", JSONObject.NULL)
                .put("activity", new JSONObject().put("state", activity).put("threadId", "attention").put("title", "Attention")
                        .put("detail", "Approval needed").put("taskUrl", JSONObject.NULL).put("completedSteps", JSONObject.NULL)
                        .put("totalSteps", JSONObject.NULL).put("hasWorkingTasks", count > 0).put("workingCount", count))
                .put("policy", new JSONObject().put("revision", 1).put("fullAccess", true).put("computerUse", true))
                .put("capabilities", new JSONObject().put("appData", true).put("computerUse", capability)).toString());
    }
    @Test public void physicalInputAndCapabilityRecoveryCannotLatchLeaseOff() throws Exception {
        WorkLease lease = new WorkLease();
        assertEquals(WorkLease.Action.ACQUIRE, lease.update(aggregate("ready", "working", 1, true), true, 0, 0, false));
        assertEquals(WorkLease.Action.NONE, lease.update(aggregate("ready", "working", 1, false), true, 3000, 3000, true));
        assertEquals(WorkLease.Action.ACQUIRE, lease.update(aggregate("ready", "working", 1, false), true, 15000, 15000, true));
        assertEquals(WorkLease.Action.ACQUIRE, lease.update(aggregate("ready", "working", 1, true), true, 30000, 30000, true));
    }
    @Test public void attentionOnAnotherThreadKeepsLeaseUntilAllWorkEnds() throws Exception {
        WorkLease lease = new WorkLease();
        for (String attention : new String[]{"waiting", "error"}) {
            assertEquals(WorkLease.Action.ACQUIRE, lease.update(aggregate("ready", attention, 2, false), true, 15000, 15000, false));
            assertEquals(WorkLease.Action.ACQUIRE, lease.update(aggregate("ready", attention, 1, false), true, 30000, 30000, true));
            assertEquals(WorkLease.Action.RELEASE, lease.update(aggregate("ready", attention, 0, false), true, 45000, 45000, true));
            lease = new WorkLease();
        }
    }
    @Test public void runtimeStopErrorOrStaleOverridesAggregateWork() throws Exception {
        for (String runtime : new String[]{"stopped", "error", "starting"})
            assertEquals(WorkLease.Action.RELEASE, new WorkLease().update(aggregate(runtime, "working", 1, true), true, 1, 1, true));
        assertEquals(WorkLease.Action.RELEASE, new WorkLease().update(aggregate("ready", "stale", 1, true), true, 1, 1, true));
        // The service marks an explicit Stop unverified before its controller request completes.
        assertEquals(WorkLease.Action.RELEASE, new WorkLease().update(aggregate("ready", "working", 1, true), false, 1, 1, true));
    }
    @Test public void futureExpiredAndOutOfOrderReceiptsCannotRenew() throws Exception {
        HostState work = aggregate("ready", "waiting", 1, false);
        assertEquals(WorkLease.Action.NONE, new WorkLease().update(work, true, 1, 0, false));
        assertEquals(WorkLease.Action.RELEASE, new WorkLease().update(work, true, 0, 20000, true));
        WorkLease lease = new WorkLease();
        lease.update(work, true, 1000, 1000, false);
        assertEquals(WorkLease.Action.NONE, lease.update(work, true, 999, 16000, true));
        assertEquals(WorkLease.Action.NONE, lease.update(work, true, 1000, 16000, true));
        assertEquals(WorkLease.Action.ACQUIRE, lease.update(work, true, 16000, 16000, true));
    }
}
