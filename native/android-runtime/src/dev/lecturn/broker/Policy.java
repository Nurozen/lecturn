package dev.lecturn.broker;

/** One process-wide grant for ALL Lecturn tasks. Never persisted or set by the guest. */
final class Policy {
    interface Visibility {
        boolean userDataAvailable();
        boolean unlockedAndVisible();
    }
    interface Action<T> { T run() throws Exception; }
    final Visibility visibility;
    private volatile long revision;
    private volatile boolean fullAccess, computerUse;
    private volatile long leaseDeadline;
    private volatile String leaseId;
    private final java.util.concurrent.atomic.AtomicLong generation=new java.util.concurrent.atomic.AtomicLong();
    private volatile long leaseGeneration;
    private volatile java.util.function.BooleanSupplier arbitrationSupported;
    private volatile Runnable cancel = () -> {};
    private final java.util.function.LongSupplier clock;

    Policy(Visibility visibility, boolean arbitrationSupported) {
        this(visibility, arbitrationSupported, System::nanoTime);
    }
    Policy(Visibility visibility, boolean arbitrationSupported, java.util.function.LongSupplier clock) {
        this.visibility = visibility;
        this.arbitrationSupported = () -> arbitrationSupported;
        this.clock = clock;
    }
    synchronized long revision() { return revision; }
    synchronized boolean fullAccess() { return fullAccess; }
    synchronized boolean computerUse() { return computerUse; }
    boolean screenSupported() { return arbitrationSupported.getAsBoolean(); }
    void setArbitration(java.util.function.BooleanSupplier supported, Runnable cancellation) {
        arbitrationSupported=supported;cancel=cancellation;
    }
    void update(long expected, boolean full, boolean computer) throws Failure {
        synchronized(this) {
            if (expected != revision) throw new Failure(409, "stale_policy_revision");
            if (computer && !full) throw new Failure(400, "computer_use_requires_full_access");
            revision++;
            fullAccess = full;
            computerUse = computer;
            clearLease();
        }
        cancel.run();
    }
    void reset() { synchronized(this) { revision++; fullAccess = false; computerUse = false; clearLease(); } cancel.run(); }
    void revokeLease() { clearLease(); cancel.run(); }
    private void clearLease() { generation.incrementAndGet(); leaseId = null; leaseDeadline = 0; }
    synchronized long capture() throws Failure { check(revision); return revision; }
    synchronized void check(long epoch) throws Failure {
        if (epoch != revision || !fullAccess) throw new Failure(403, "full_access_revoked_or_disabled");
        if (!visibility.userDataAvailable()) { clearLease(); throw new Failure(423, "user_data_locked_or_unavailable"); }
    }
    private void checkVisibility() throws Failure {
        if (!visibility.unlockedAndVisible()) { clearLease(); throw new Failure(423, "user_locked_hidden_or_unknown"); }
    }
    synchronized String acquireLease(int seconds) throws Failure {
        long observed=generation.get();
        check(revision);
        checkVisibility();
        if (!computerUse) throw new Failure(403, "computer_use_disabled");
        if (!screenSupported()) throw new Failure(501, "physical_input_arbitration_unavailable");
        if (seconds < 1 || seconds > 15) throw new Failure(400, "lease_duration_out_of_range");
        if (leaseId!=null && clock.getAsLong()<leaseDeadline) throw new Failure(409,"screen_lease_already_active");
        leaseGeneration=observed;
        String acquired=java.util.UUID.randomUUID().toString();
        leaseId=acquired;
        leaseDeadline = clock.getAsLong() + seconds * 1_000_000_000L;
        if(generation.get()!=observed) { clearLease();throw new Failure(403,"physical_input_during_lease_acquisition"); }
        return acquired;
    }
    synchronized <T> T commit(long epoch, Action<T> action) throws Exception {
        check(epoch);
        return action.run(); // Linearizes revocation against a bounded native rename/unlink.
    }
    synchronized void checkScreen(long epoch, String lease) throws Failure {
        check(epoch);
        checkVisibility();
        checkScreenLease(epoch,lease);
    }
    void checkScreenLease(long epoch,String lease) throws Failure {
        if(epoch!=revision || !fullAccess) throw new Failure(403,"full_access_revoked_or_disabled");
        if (!computerUse || !screenSupported()) throw new Failure(501, "computer_use_unavailable");
        if (leaseId == null || !lease.equals(leaseId) || generation.get()!=leaseGeneration || clock.getAsLong() >= leaseDeadline)
            throw new Failure(403, "screen_lease_expired_or_revoked");
    }
    <T> T screen(long epoch, String lease, Action<T> action) throws Exception {
        checkScreen(epoch,lease);
        T result=action.run();
        checkScreen(epoch,lease);
        return result;
    }
}
