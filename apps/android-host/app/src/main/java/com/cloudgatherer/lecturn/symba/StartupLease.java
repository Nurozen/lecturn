package com.cloudgatherer.lecturn.symba;

final class StartupLease {
    static final long MAX_STARTUP_MS = 5 * 60 * 1000;
    static final long FRESH_MS = 20000;
    private long startedAt = -1, deadline, lastReceipt = -1;
    private long timeout;

    long timeoutMs() { return timeout; }

    WorkLease.Action update(HostState state, boolean verified, long receipt, long now, boolean held, boolean stopping) {
        boolean fresh = verified && state != null && receipt <= now && now - receipt < FRESH_MS;
        boolean newReceipt = receipt > lastReceipt;
        if (newReceipt) lastReceipt = receipt;
        // Lost contact must not reset the continuous-startup budget.
        if (fresh && newReceipt && ("stopped".equals(state.runtime) || "ready".equals(state.runtime))) startedAt = -1;
        if (stopping || !fresh || !"starting".equals(state.runtime)
                || "error".equals(state.activity) || "stale".equals(state.activity)) {
            deadline = 0;
            return held ? WorkLease.Action.RELEASE : WorkLease.Action.NONE;
        }
        if (startedAt < 0 && newReceipt) startedAt = receipt;
        if (startedAt < 0 || now - startedAt >= MAX_STARTUP_MS) {
            return held ? WorkLease.Action.RELEASE : WorkLease.Action.NONE;
        }
        if (newReceipt && (!held || now >= deadline - 10000)) {
            deadline = Math.min(receipt + FRESH_MS, startedAt + MAX_STARTUP_MS);
            timeout = deadline - now;
            return WorkLease.Action.ACQUIRE;
        }
        return WorkLease.Action.NONE;
    }
}
