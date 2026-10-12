package com.cloudgatherer.lecturn.symba;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class StartupLeaseTest {
    private HostState state(String runtime, String activity) throws Exception {
        JSONObject value = new JSONObject("""
                {"schemaVersion":1,"runtime":{"status":"starting","message":"Starting"},"uiUrl":null,
                "activity":{"state":"idle","threadId":null,"title":"","detail":"","taskUrl":null,
                "completedSteps":null,"totalSteps":null,"hasWorkingTasks":false,"workingCount":0},"policy":{"revision":1,"fullAccess":false,"computerUse":false},
                "capabilities":{"appData":false,"computerUse":false}}
                """);
        value.getJSONObject("runtime").put("status", runtime);
        value.getJSONObject("activity").put("state", activity);
        return HostState.parse(value.toString());
    }
    private static final class ClockLock {
        final StartupLease lease = new StartupLease();
        long now, expiresAt;
        boolean held() { return now < expiresAt; }
        WorkLease.Action receipt(HostState state, boolean verified, long receipt) {
            WorkLease.Action action = lease.update(state, verified, receipt, now, held(), false);
            if (action == WorkLease.Action.ACQUIRE) expiresAt = now + lease.timeoutMs();
            if (action == WorkLease.Action.RELEASE) expiresAt = now;
            return action;
        }
    }
    @Test public void startingWithIdleActivityCanStayAwakeButNeverBeyondFiveMinutes() throws Exception {
        ClockLock lock = new ClockLock();
        HostState starting = state("starting", "idle");
        for (lock.now = 0; lock.now < 300000; lock.now += 8000) {
            lock.receipt(starting, true, lock.now);
            assertTrue(lock.held());
            assertTrue(lock.expiresAt <= 300000);
        }
        lock.now = 300000;
        assertFalse(lock.held());
        lock.receipt(starting, true, lock.now);
        assertFalse(lock.held());
        lock.now = 600000;
        lock.receipt(starting, true, lock.now);
        assertFalse(lock.held());
    }
    @Test public void noCallbackIsNeededForFreshnessExpiry() throws Exception {
        ClockLock lock = new ClockLock();
        lock.receipt(state("starting", "idle"), true, 0);
        assertEquals(20000, lock.expiresAt);
        lock.now = 20000;
        assertFalse(lock.held());
        assertEquals(WorkLease.Action.NONE, lock.receipt(state("starting", "idle"), true, 0));
        assertFalse(lock.held());
    }
    @Test public void cachedUiCallbacksAndOutOfOrderReceiptsCannotRenew() throws Exception {
        ClockLock lock = new ClockLock();
        HostState starting = state("starting", "idle");
        lock.receipt(starting, true, 0);
        lock.now = 8000;
        lock.receipt(starting, true, 8000);
        lock.now = 16000;
        assertEquals(WorkLease.Action.NONE, lock.receipt(starting, true, 8000));
        assertEquals(WorkLease.Action.NONE, lock.receipt(starting, true, 7000));
        assertEquals(20000, lock.expiresAt);
        assertEquals(WorkLease.Action.ACQUIRE, lock.receipt(starting, true, 16000));
        assertEquals(36000, lock.expiresAt);
    }
    @Test public void unverifiedFutureAndExpiredReceiptsCannotAcquire() throws Exception {
        HostState starting = state("starting", "idle");
        assertEquals(WorkLease.Action.NONE, new StartupLease().update(starting, false, 0, 0, false, false));
        assertEquals(WorkLease.Action.NONE, new StartupLease().update(starting, true, 1, 0, false, false));
        assertEquals(WorkLease.Action.NONE, new StartupLease().update(starting, true, 0, 20000, false, false));
        assertEquals(WorkLease.Action.NONE, new StartupLease().update(null, true, 0, 0, false, false));
    }
    @Test public void readyIdleWorkingErrorStoppedAndStaleReleaseStartupLock() throws Exception {
        for (String[] next : new String[][]{{"ready", "idle"}, {"ready", "working"}, {"error", "idle"},
                {"stopped", "idle"}, {"starting", "error"}, {"starting", "stale"}}) {
            ClockLock lock = new ClockLock();
            lock.receipt(state("starting", "idle"), true, 0);
            lock.now = 1000;
            assertEquals(WorkLease.Action.RELEASE, lock.receipt(state(next[0], next[1]), true, lock.now));
            assertFalse(lock.held());
        }
    }
    @Test public void stopOrLostAuthenticationReleasesWithoutResettingTheBudget() throws Exception {
        ClockLock lock = new ClockLock();
        HostState starting = state("starting", "idle");
        lock.receipt(starting, true, 0);
        lock.now = 1000;
        assertEquals(WorkLease.Action.RELEASE, lock.receipt(starting, false, 0));
        lock.now = 299000;
        lock.receipt(starting, true, lock.now);
        assertEquals(300000, lock.expiresAt);
        lock.now = 300000;
        lock.receipt(starting, true, lock.now);
        assertFalse(lock.held());
    }
    @Test public void onlyAFreshConfirmedExitAllowsANewStartupBudget() throws Exception {
        ClockLock lock = new ClockLock();
        HostState starting = state("starting", "idle");
        lock.receipt(starting, true, 0);
        lock.now = 300000;
        lock.receipt(state("stopped", "idle"), false, lock.now);
        lock.now++;
        lock.receipt(starting, true, lock.now);
        assertFalse(lock.held());
        lock.now++;
        lock.receipt(state("stopped", "idle"), true, lock.now);
        lock.now++;
        assertEquals(WorkLease.Action.ACQUIRE, lock.receipt(starting, true, lock.now));
        assertTrue(lock.held());
    }
    @Test public void confirmedStopDuringServiceShutdownResetsBudgetForNextStart() throws Exception {
        StartupLease lease = new StartupLease();
        HostState starting = state("starting", "idle");
        lease.update(starting, true, 0, 0, false, false);
        assertEquals(WorkLease.Action.RELEASE, lease.update(starting, true, 1000, 1000, true, true));
        lease.update(state("stopped", "idle"), true, 300000, 300000, false, true);
        assertEquals(WorkLease.Action.ACQUIRE, lease.update(starting, true, 300001, 300001, false, false));
        assertEquals(20000, lease.timeoutMs());
    }
    @Test public void delayedFreshReceiptUsesReceiptTimeNotCallbackTime() throws Exception {
        ClockLock lock = new ClockLock();
        lock.now = 19000;
        lock.receipt(state("starting", "idle"), true, 0);
        assertEquals(20000, lock.expiresAt);
        assertEquals(1000, lock.lease.timeoutMs());
    }
    @Test public void unavailableBrokerReceiptCannotResetStartupBudget() throws Exception {
        ClockLock lock = new ClockLock();
        HostState starting = state("starting", "idle");
        lock.receipt(starting, true, 0);
        lock.now = 16000;
        assertEquals(WorkLease.Action.RELEASE, lock.receipt(state("error", "stale"), true, lock.now));
        lock.now = 299000;
        lock.receipt(starting, true, lock.now);
        assertEquals(300000, lock.expiresAt);
        lock.now = 300000;
        assertEquals(WorkLease.Action.NONE, lock.receipt(starting, true, lock.now));
        assertFalse(lock.held());
    }

}
