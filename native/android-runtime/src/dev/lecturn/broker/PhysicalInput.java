package dev.lecturn.broker;

/** Native source contains only health/idle state; input coordinates never cross JNI. */
final class PhysicalInput implements ScreenArbiter.TouchSource {
    private long handle;
    private volatile Runnable revoke = () -> {};
    private static native long start(PhysicalInput callback);
    private static native boolean ready(long handle);
    private static native void stop(long handle);
    public synchronized void start(Runnable listener) { revoke=listener;handle=start(this); }
    public synchronized boolean ready() { return handle!=0 && ready(handle); }
    // Called by the native poll thread on physical input AND any detector failure.
    private void changed() { revoke.run(); }
    public void close() {
        long owned;
        synchronized(this) { owned=handle;handle=0; }
        if(owned!=0) stop(owned);
    }
}
