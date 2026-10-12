package com.cloudgatherer.lecturn.symba;

/** The attempt latch survives polls and activity pause; only native Retry resets it. */
final class UiPairing {
    boolean attempted, authenticated, waiting;
    String error;
    long deadline;
    boolean begin() {
        if (attempted || error != null) return false;
        attempted = true;
        return true;
    }
    void await(long now, long remainingMillis) {
        waiting = true;
        deadline = now + Math.min(30000, Math.max(0, remainingMillis));
    }
    boolean expired(long now) { return waiting && now >= deadline; }
    boolean confirm() {
        boolean completedBootstrap = waiting;
        authenticated = true; waiting = false; error = null;
        return completedBootstrap;
    }
    void fail(String message) { authenticated = false; waiting = false; error = message; }
    void retry() { attempted = false; authenticated = false; waiting = false; error = null; }
}
