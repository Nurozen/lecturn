package dev.lecturn.broker;

import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** One injected stream, independent of background file/code work. No policy lock across gestures. */
final class ScreenArbiter implements AutoCloseable {
    interface TouchSource extends AutoCloseable {
        void start(Runnable physicalInput);
        boolean ready();
        void close();
    }
    interface GestureAdapter {
        void touch(int action, float x, float y) throws Exception;
        void key(int action, int code) throws Exception;
        void cancelKey(int code) throws Exception;
    }
    interface Guard {
        void check() throws Exception;
        default void current() throws Exception { check(); }
    }
    private final TouchSource source;
    private final GestureAdapter adapter;
    private final Policy policy;
    private final ScheduledExecutorService watchdog;
    private final AtomicBoolean busy=new AtomicBoolean();
    private volatile boolean broken;
    private volatile Guard active;
    private boolean touching;
    private int heldKey=-1;
    ScreenArbiter(Policy policy,TouchSource source,GestureAdapter adapter) {
        this.policy=policy;this.source=source;this.adapter=adapter;
        policy.setArbitration(this::ready,this::cancel);
        source.start(policy::revokeLease);
        watchdog=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"screen-lease-watchdog");t.setDaemon(true);return t;});
        watchdog.scheduleWithFixedDelay(this::tick,0,10,TimeUnit.MILLISECONDS);
    }
    boolean ready() { return !broken && source.ready(); }
    void tick() {
        Guard guard=active;
        try { if(guard!=null) guard.current(); }
        catch(Exception e) { synchronized(this) { if(active==guard) policy.revokeLease(); } }
    }
    // Revocation is visible in Policy before this bounded, per-event critical section.
    synchronized void cancel() {
        try {
            if(touching) { touching=false;adapter.touch(3,0,0); } // ACTION_CANCEL
            if(heldKey!=-1) { int key=heldKey;heldKey=-1;adapter.cancelKey(key); }
        } catch(Exception e) { broken=true; }
    }
    <T> T run(Guard guard,Policy.Action<T> action) throws Exception {
        if(!busy.compareAndSet(false,true)) throw new Failure(409,"screen_operation_in_progress");
        try {
            guard.check();
            synchronized(this) { guard.current();active=guard; }
            T result=action.run();guard.check();return result;
        } finally { synchronized(this) { cancel();active=null; } busy.set(false); }
    }
    <T> T step(Policy.Action<T> action) throws Exception {
        Guard guard=active;
        if(guard==null) throw new Failure(403,"screen_lease_required");
        // Visibility may call Binder. Never make physical cancellation wait for it.
        guard.check();
        T result;
        synchronized(this) {
            if(active!=guard) throw new Failure(403,"screen_operation_finished");
            guard.current();
            result=action.run();
        }
        guard.check();return result;
    }
    void touch(int action,float x,float y) throws Exception {
        step(()->{
            // A throwing adapter may already have delivered DOWN.
            if(action==0) touching=true;
            try { adapter.touch(action,x,y); } catch(Exception e) { broken=true;throw e; }
            if(action==1 || action==3) touching=false;
            return null;
        });
    }
    void key(int action,int code) throws Exception {
        step(()->{
            if(action==0) heldKey=code;
            try { adapter.key(action,code); } catch(Exception e) { broken=true;throw e; }
            if(action==1) heldKey=-1;
            return null;
        });
    }
    void swipe(float x1,float y1,float x2,float y2,int duration) throws Exception {
        touch(0,x1,y1);
        long begin=System.nanoTime();
        while(true) {
            long elapsed=(System.nanoTime()-begin)/1_000_000;
            if(elapsed>=duration) break;
            float fraction=(float)elapsed/duration;
            touch(2,x1+(x2-x1)*fraction,y1+(y2-y1)*fraction);
            Thread.sleep(Math.min(8,duration-elapsed));
        }
        touch(1,x2,y2);
    }
    public void close() { policy.revokeLease();watchdog.shutdownNow();source.close(); }
}
