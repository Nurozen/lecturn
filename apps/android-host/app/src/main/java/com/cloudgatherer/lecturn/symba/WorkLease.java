package com.cloudgatherer.lecturn.symba;

final class WorkLease {
    static final long TIMEOUT_MS = 30000;
    static final long FRESH_MS = 20000;
    enum Action { ACQUIRE, RELEASE, NONE }
    private long deadline, lastReceipt = -1;

    Action update(HostState state, boolean verified, long receipt, long now, boolean held) {
        boolean newReceipt = receipt > lastReceipt;
        if (newReceipt) lastReceipt = receipt;
        boolean fresh = verified && receipt <= now && now - receipt < FRESH_MS;
        if (!fresh || state == null || !state.working()) {
            deadline = 0;
            return held ? Action.RELEASE : Action.NONE;
        }
        // A UI callback cannot extend the lease. Only a new authenticated working receipt can.
        if (newReceipt && (!held || now >= deadline - 15000)) {
            deadline = now + TIMEOUT_MS;
            return Action.ACQUIRE;
        }
        return Action.NONE;
    }
}
