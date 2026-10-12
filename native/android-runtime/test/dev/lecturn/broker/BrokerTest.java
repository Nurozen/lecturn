package dev.lecturn.broker;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.json.*;

public final class BrokerTest {
    interface Checked { void run() throws Exception; }
    static int assertions;
    static void check(boolean value) { assertions++;if(!value)throw new AssertionError("check "+assertions); }
    static void fail(int status,Checked action) throws Exception {
        try { action.run();throw new AssertionError("expected "+status); }
        catch(Failure f) { check(f.status==status); }
    }
    static Policy.Visibility visibility(java.util.function.BooleanSupplier visible) {
        return new Policy.Visibility() {
            public boolean userDataAvailable() { return true; }
            public boolean unlockedAndVisible() { return visible.getAsBoolean(); }
        };
    }
    static final class UserFixture implements Policy.Visibility {
        int currentUser=0;
        boolean ceUnlocked, interactive=true, keyguard;
        public boolean userDataAvailable() { return currentUser==0 && ceUnlocked; }
        public boolean unlockedAndVisible() { return userDataAvailable() && interactive && !keyguard; }
    }
    static final String TOKEN="a".repeat(64);
    static Protocol.Request request(String method,String path,String body,String extra) throws Exception {
        String raw=method+" "+path+" HTTP/1.1\r\nHost: 127.0.0.1:18768\r\nAuthorization: Bearer "+TOKEN+"\r\n"+extra;
        if(body!=null) raw+="Content-Type: application/json\r\nContent-Length: "+body.getBytes(StandardCharsets.UTF_8).length+"\r\n";
        raw+="\r\n"+(body==null?"":body);
        return Protocol.read(new ByteArrayInputStream(raw.getBytes(StandardCharsets.UTF_8)),TOKEN,18768);
    }
    static void protocol() throws Exception {
        check(request("GET","/v1/state",null,"").body.length()==0);
        check(request("POST","/v1/policy","{}","").body.length()==0);
        fail(403,()->request("GET","/v1/state",null,"Origin: null\r\n"));
        fail(403,()->request("GET","/v1/state",null,"Origin: http://evil.example\r\n"));
        fail(403,()->request("GET","/v1/state",null,"Sec-Fetch-Site: cross-site\r\n"));
        fail(400,()->request("GET","/v1/state",null,"Authorization: Bearer bad\r\n"));
        fail(400,()->request("GET","/v1/state",null,"Transfer-Encoding: chunked\r\n"));
        fail(413,()->request("POST","/v1/policy",null,"Content-Length: 393217\r\n"));
        fail(400,()->request("GET","/v1/state","{}",""));
        fail(400,()->request("POST","/v1/policy",null,""));
        fail(400,()->request("POST","/v1/policy","{}{}",""));
        for (String invalid:new String[]{"{a:1}","{'a':1}","{\"a\":1,}","{\"a\":1,\"a\":2}","{\"a\":NaN}","{\"a\":01}"})
            fail(400,()->request("POST","/v1/policy",invalid,""));
        fail(400,()->request("POST","/v1/policy","{\"a\":"+"[".repeat(40)+"0"+"]".repeat(40)+"}",""));
        String wrong="GET /v1/state HTTP/1.1\r\nHost: 127.0.0.1:18768\r\nAuthorization: Bearer "+"b".repeat(64)+"\r\n\r\n";
        fail(401,()->Protocol.read(new ByteArrayInputStream(wrong.getBytes(StandardCharsets.US_ASCII)),TOKEN,18768));
        fail(403,()->Protocol.read(new ByteArrayInputStream(wrong.replace("18768","evil").getBytes(StandardCharsets.US_ASCII)),TOKEN,18768));
        fail(431,()->request("GET","/v1/state",null,"X-Large: "+"x".repeat(8192)+"\r\n"));
        fail(400,()->Protocol.bool(new JSONObject("{\"fullAccess\":\"true\"}"),"fullAccess"));
        fail(400,()->Protocol.integer(new JSONObject("{\"revision\":1.0}"),"revision",0,10));
    }
    static void policy() throws Exception {
        AtomicBoolean visible=new AtomicBoolean(true);
        Policy p=new Policy(visibility(visible::get),true);
        fail(403,p::capture);p.update(0,true,false);long epoch=p.capture();
        fail(409,()->p.update(0,true,true));fail(403,()->p.acquireLease(1));
        p.update(1,true,true);String lease=p.acquireLease(1);epoch=p.capture();final long active=epoch;
        check(p.screen(active,lease,()->"ok").equals("ok"));
        p.revokeLease();fail(403,()->p.screen(active,lease,()->"bad"));
        String next=p.acquireLease(1);visible.set(false);fail(423,()->p.screen(active,next,()->"bad"));
        visible.set(true);fail(403,()->p.screen(active,next,()->"bad"));
        p.update(2,false,false);AtomicBoolean committed=new AtomicBoolean();
        fail(403,()->p.commit(active,()->{committed.set(true);return null;}));check(!committed.get());
        fail(400,()->p.update(3,false,true));
        p.update(3,true,true);p.reset();check(!p.fullAccess() && !p.computerUse());
        AtomicLong clock=new AtomicLong(0); Policy expiring=new Policy(visibility(()->true),true,clock::get);
        expiring.update(0,true,true);String expiringLease=expiring.acquireLease(1);long leaseEpoch=expiring.capture();
        clock.set(1_000_000_000L);fail(403,()->expiring.screen(leaseEpoch,expiringLease,()->null));
        Policy unavailable=new Policy(visibility(()->true),false);unavailable.update(0,true,true);fail(501,()->unavailable.acquireLease(1));
        // A completed native commit precedes the revoke acknowledgement; later work cannot commit.
        Policy serial=new Policy(visibility(()->true),false);serial.update(0,true,false);long captured=serial.capture();
        CountDownLatch entered=new CountDownLatch(1), release=new CountDownLatch(1);
        ExecutorService pool=Executors.newFixedThreadPool(2);
        try {
            Future<?> write=pool.submit(()->{try {serial.commit(captured,()->{entered.countDown();release.await();return null;});}catch(Exception e){throw new RuntimeException(e);}});
            entered.await();Future<?> revoke=pool.submit(serial::reset);release.countDown();write.get();revoke.get();
            fail(403,()->serial.commit(captured,()->null));
        }finally{pool.shutdownNow();}
    }
    static void backgroundData() throws Exception {
        UserFixture user=new UserFixture();Policy p=new Policy(user,true);
        check(!p.fullAccess() && !p.computerUse() && p.revision()==0);
        p.update(0,true,true);
        fail(423,p::capture);fail(423,()->p.acquireLease(1));
        AtomicInteger mutations=new AtomicInteger(), screens=new AtomicInteger();
        fail(423,()->p.commit(p.revision(),mutations::incrementAndGet));
        user.ceUnlocked=true;long epoch=p.capture();
        for(boolean screenOff:new boolean[]{false,true}) {
            String lease=p.acquireLease(1);
            user.interactive=!screenOff;user.keyguard=!screenOff;
            check(p.capture()==epoch);p.check(epoch); // admission and read/list response check
            check(p.commit(epoch,mutations::incrementAndGet)==(screenOff?2:1));
            fail(423,()->p.screen(epoch,lease,screens::incrementAndGet));
            fail(423,()->p.acquireLease(1));check(screens.get()==0);
            user.interactive=true;user.keyguard=false;
            fail(403,()->p.checkScreen(epoch,lease)); // visibility failure invalidates the lease
        }
        String captureLease=p.acquireLease(1);
        fail(423,()->p.screen(epoch,captureLease,()->{user.keyguard=true;return "captured bytes";}));
        p.check(epoch);user.keyguard=false;
        for(int otherUser:new int[]{10,-1}) {
            String lease=p.acquireLease(1);user.currentUser=otherUser;
            fail(423,p::capture);fail(423,()->p.check(epoch));
            fail(423,()->p.commit(epoch,mutations::incrementAndGet));
            fail(423,()->p.screen(epoch,lease,screens::incrementAndGet));
            fail(423,()->p.acquireLease(1));
            user.currentUser=0;fail(403,()->p.checkScreen(epoch,lease));
        }
        user.ceUnlocked=false;
        fail(423,()->p.check(epoch));fail(423,()->p.commit(epoch,mutations::incrementAndGet));
        user.ceUnlocked=true;user.keyguard=true;
        p.update(epoch,false,false);
        fail(403,p::capture);fail(403,()->p.check(epoch));
        fail(403,()->p.commit(epoch,mutations::incrementAndGet));
        fail(403,()->p.acquireLease(1));
        fail(409,()->p.update(epoch,true,true));
        p.update(p.revision(),true,false);
        fail(403,()->p.commit(epoch,mutations::incrementAndGet));
        check(mutations.get()==2 && screens.get()==0);
    }
    static final class TouchFixture implements ScreenArbiter.TouchSource {
        Runnable notify; volatile boolean ready=true;
        public void start(Runnable listener) { notify=listener; }
        public boolean ready() { return ready; }
        public void close() { ready=false; }
        void physical() { notify.run(); }
    }
    static final class GestureFixture implements ScreenArbiter.GestureAdapter {
        final java.util.List<Integer> touches=new java.util.concurrent.CopyOnWriteArrayList<>();
        final java.util.List<Integer> keys=new java.util.concurrent.CopyOnWriteArrayList<>();
        boolean cancelFails;
        public void touch(int action,float x,float y) throws Exception {
            touches.add(action);if(action==3 && cancelFails) throw new IOException("cancel failed");
        }
        public void key(int action,int code) { keys.add(action); }
        public void cancelKey(int code) { keys.add(3); }
    }
    static void arbitration() throws Exception {
        AtomicBoolean visible=new AtomicBoolean(true);AtomicLong clock=new AtomicLong();
        Policy p=new Policy(visibility(visible::get),false,clock::get);
        TouchFixture source=new TouchFixture();GestureFixture gestures=new GestureFixture();
        ExecutorService worker=Executors.newSingleThreadExecutor();
        try(ScreenArbiter arbiter=new ScreenArbiter(p,source,gestures)) {
            p.update(0,true,true);String lease=p.acquireLease(1);long epoch=p.capture();
            fail(409,()->p.acquireLease(1));
            CountDownLatch down=new CountDownLatch(1), proceed=new CountDownLatch(1);
            Future<?> flight=worker.submit(()->{
                try { fail(403,()->arbiter.run(()->p.checkScreen(epoch,lease),()->{
                    arbiter.touch(0,10,20);down.countDown();proceed.await();arbiter.touch(2,20,30);return null;
                })); } catch(Exception e) { throw new RuntimeException(e); }
            });
            check(down.await(5,TimeUnit.SECONDS));
            fail(409,()->arbiter.run(()->p.checkScreen(epoch,lease),()->null));
            source.physical(); // revoke completes while the gesture task is still in flight
            check(gestures.touches.equals(java.util.Arrays.asList(0,3)));
            proceed.countDown();flight.get(5,TimeUnit.SECONDS);
            check(gestures.touches.equals(java.util.Arrays.asList(0,3)));
            check(p.fullAccess() && p.computerUse()); // background work retains native full access
            fail(403,()->p.checkScreen(epoch,lease));
            String screenshotLease=p.acquireLease(1);
            fail(403,()->p.screen(epoch,screenshotLease,()->{source.physical();return "secret screenshot";}));
            String expiry=p.acquireLease(1);
            fail(403,()->arbiter.run(()->p.checkScreen(epoch,expiry),()->{
                arbiter.touch(0,0,0);clock.set(1_000_000_000L);arbiter.tick();return "expired";
            }));
            check(gestures.touches.equals(java.util.Arrays.asList(0,3,0,3)));
            String locked=p.acquireLease(1);
            fail(423,()->arbiter.run(()->p.checkScreen(epoch,locked),()->{
                arbiter.key(0,4);visible.set(false);arbiter.tick();return null;
            }));
            check(gestures.keys.equals(java.util.Arrays.asList(0,3)));visible.set(true);
            source.ready=false;fail(501,()->p.acquireLease(1));source.ready=true;
            String detector=p.acquireLease(1);
            fail(501,()->arbiter.run(()->p.checkScreen(epoch,detector),()->{
                arbiter.touch(0,1,2);source.ready=false;arbiter.tick();return null;
            }));
            source.ready=true;String badCancel=p.acquireLease(1);gestures.cancelFails=true;
            fail(501,()->arbiter.run(()->p.checkScreen(epoch,badCancel),()->{
                arbiter.touch(0,1,2);source.physical();return null;
            }));
            check(!p.screenSupported());fail(501,()->p.acquireLease(1));
        } finally { worker.shutdownNow(); }
        // A lease acquisition cannot overwrite physical revocation during qualification.
        Policy raced=new Policy(visibility(()->true),false);
        raced.setArbitration(()->{raced.revokeLease();return true;},()->{});
        raced.update(0,true,true);fail(403,()->raced.acquireLease(1));
    }
    static void cancellationDoesNotWaitForVisibility() throws Exception {
        for(boolean physical:new boolean[]{true,false}) {
        AtomicLong clock=new AtomicLong();
        AtomicReference<Thread> blockedThread=new AtomicReference<>();
        CountDownLatch waiting=new CountDownLatch(1), release=new CountDownLatch(1);
        Policy p=new Policy(visibility(()->{
            if(Thread.currentThread()==blockedThread.get()) {
                waiting.countDown();try { release.await(); } catch(InterruptedException e) { return false; }
            }
            return true;
        }),false,clock::get);
        TouchFixture source=new TouchFixture();GestureFixture gestures=new GestureFixture();
        ExecutorService workers=Executors.newFixedThreadPool(2);
        try(ScreenArbiter arbiter=new ScreenArbiter(p,source,gestures)) {
            p.update(0,true,true);String lease=p.acquireLease(1);long epoch=p.capture();
            ScreenArbiter.Guard guard=new ScreenArbiter.Guard() {
                public void check() throws Exception { p.checkScreen(epoch,lease); }
                public void current() throws Exception { p.checkScreenLease(epoch,lease); }
            };
            Future<?> flight=workers.submit(()->{
                try { fail(403,()->arbiter.run(guard,()->{
                    arbiter.touch(0,1,1);blockedThread.set(Thread.currentThread());arbiter.touch(2,2,2);return null;
                })); } catch(Exception e) { throw new RuntimeException(e); }
            });
            try {
                check(waiting.await(5,TimeUnit.SECONDS));
                if(physical) workers.submit(source::physical).get(5,TimeUnit.SECONDS);
                else { clock.set(1_000_000_000L);workers.submit(arbiter::tick).get(5,TimeUnit.SECONDS); }
                check(gestures.touches.equals(java.util.Arrays.asList(0,3)));
            } finally { release.countDown(); }
            flight.get(5,TimeUnit.SECONDS);
        } finally { release.countDown();workers.shutdownNow(); }
        }
    }
    static void paths() throws Exception {
        SecureFilesTest.paths();
        SecureFiles.target("ce","com.example.app","files/normal.txt");
        SecureFiles.target("downloads","","report.txt");SecureFiles.target("documents","","folder/report.txt");
        fail(400,()->SecureFiles.target("downloads","com.example.app","report.txt"));
        fail(400,()->SecureFiles.target("documents","","../Android/data/secret"));
        for(String root:new String[]{"ce","de","shared","media","obb","storage","downloads","documents"}) {
            for(String pkg:new String[]{"com.example.app","com.example.credentialmanager","com.example.keychain","com.example.keystore"}) {
                for(String path:new String[]{"keys/private","key","files/private.key","files/cert.pem","files/keystore.db","databases/credentials.db","files/keychain"}) {
                    SecureFiles.target(root,SecureFiles.publicRoot(root)?"":pkg,path);
                    check(true);
                }
            }
        }
        for(String path:new String[]{"../outside","a/../../b","/data/system","a//b","a/./b",".lecturn-test","a\\b","a\0b"}) fail(400,()->SecureFiles.target("ce","com.example.app",path));
        fail(400,()->SecureFiles.target("ce","com.cloudgatherer.lecturn.symba","files/token"));
        fail(400,()->SecureFiles.target("user10","com.example.app","file"));
        fail(400,()->SecureFiles.target("ce","../system","file"));
        fail(400,()->SecureFiles.target("ce","com.android.keychain","file"));
    }
    static JSONObject shell() throws Exception { return new JSONObject().put("snapshotSequence",3).put("projects",new JSONArray()).put("threads",new JSONArray()).put("updatedAt","2026-01-01T00:00:00Z"); }
    static final class FakeRuntime implements RuntimeAdapter.Backend {
        String status="stopped", instance="boot1";boolean health=true,missing=false;int shellCalls;
        public JSONObject command(String verb) throws Exception {
            if(missing)throw new IOException("synthetic missing");
            if(verb.equals("start"))status="starting";if(verb.equals("stop"))status="stopped";
            JSONObject result=new JSONObject().put("schemaVersion",1).put("status",status).put("instanceId",instance);
            if(status.equals("starting")) result.put("message","Guest runtime is starting");
            RuntimeAdapter.validateStatus(result);
            return result;
        }
        public JSONObject shell() throws Exception {shellCalls++;if(!health)throw new IOException("synthetic unauthenticated");return snapshot;}
        JSONObject snapshot=BrokerTest.shell();
        String origin=LecturnApi.ORIGIN, environment="environment-fixture";
        public String uiUrl(){return origin;}
        public String environmentId(){return environment;}
        public JSONObject bootstrap() throws Exception { return new JSONObject().put("schemaVersion",1).put("pairingUrl",LecturnApi.ORIGIN+"/pair#token=23456789ABCD").put("expiresAt","2099-01-01T00:00:00Z"); }
        FakeRuntime() throws Exception {}
    }
    static void refused(Checked action) throws Exception {
        try { action.run();throw new AssertionError("expected invalid runtime metadata"); }
        catch(IOException | Failure expected) { assertions++; }
    }
    static void runtimeValidation() throws Exception {
        JSONObject starting=Protocol.json("{\"schemaVersion\":1,\"status\":\"starting\",\"instanceId\":\"boot-1\",\"message\":\"Starting VM\"}".getBytes(StandardCharsets.UTF_8));
        RuntimeAdapter.validateStatus(starting);check(starting.getString("status").equals("starting"));
        starting.remove("message");RuntimeAdapter.validateStatus(starting);
        starting.put("message","x".repeat(512));RuntimeAdapter.validateStatus(starting);
        for(Object message:new Object[]{"x".repeat(513),true,1,JSONObject.NULL}) {
            starting.put("message",message);refused(()->RuntimeAdapter.validateStatus(starting));
        }
        starting.remove("message");starting.remove("instanceId");refused(()->RuntimeAdapter.validateStatus(starting));
        starting.put("instanceId","../bad");refused(()->RuntimeAdapter.validateStatus(starting));
        starting.put("instanceId","boot-1").put("unknown",true);refused(()->RuntimeAdapter.validateStatus(starting));
        starting.remove("unknown");starting.put("status","launching");refused(()->RuntimeAdapter.validateStatus(starting));
        starting.put("status","starting").put("schemaVersion",2);refused(()->RuntimeAdapter.validateStatus(starting));
        java.nio.file.Path data=java.nio.file.Paths.get("/data");
        RuntimeAdapter.validateControlPath(data,1000,1000,040771,true,false); // real platform mode includes file type
        for(java.nio.file.Path path=java.nio.file.Paths.get(RuntimeAdapter.CONTROL);path!=null;path=path.getParent()) {
            RuntimeAdapter.validateControlPath(path,0,0,0755,!path.toString().equals(RuntimeAdapter.CONTROL),false);
        }
        for(int[] metadata:new int[][]{{1001,1000,0771},{1000,1001,0771},{1000,1000,0777},{1000,1000,0755},{1000,1000,04771},{0,0,0771}})
            refused(()->RuntimeAdapter.validateControlPath(data,metadata[0],metadata[1],metadata[2],true,false));
        refused(()->RuntimeAdapter.validateControlPath(data,1000,1000,0771,false,false));
        refused(()->RuntimeAdapter.validateControlPath(data,1000,1000,0771,true,true));
        for(String path:new String[]{"/data/local","/data/local/symba-runtime","/other/data",RuntimeAdapter.CONTROL})
            refused(()->RuntimeAdapter.validateControlPath(java.nio.file.Paths.get(path),1000,1000,0771,true,false));
        refused(()->RuntimeAdapter.validateControlPath(java.nio.file.Paths.get(RuntimeAdapter.CONTROL),0,0,0775,false,false));
        refused(()->RuntimeAdapter.validateControlPath(java.nio.file.Paths.get(RuntimeAdapter.CONTROL),0,0,0755,false,true));
    }
    static void runtime() throws Exception {
        FakeRuntime fake=new FakeRuntime();RuntimeAdapter r=new RuntimeAdapter(fake);
        check(r.state().getJSONObject("runtime").getString("status").equals("stopped"));
        fake.health=false;r.transition("start");check(r.state().getJSONObject("runtime").getString("status").equals("starting"));check(r.state().isNull("uiUrl"));
        check(r.state().getJSONObject("activity").getString("state").equals("idle"));
        check(fake.shellCalls==0);
        fake.health=true;r.refresh();check(r.state().getJSONObject("runtime").getString("status").equals("starting"));
        check(fake.shellCalls==0);check(r.state().isNull("uiUrl"));fail(503,r::bootstrap);
        fake.status="ready";fake.health=false;r.refresh();
        check(r.state().getJSONObject("runtime").getString("status").equals("error"));
        fake.health=true;r.refresh();check(r.state().getJSONObject("runtime").getString("status").equals("ready"));
        fake.status="starting";r.refresh();check(r.state().getJSONObject("runtime").getString("status").equals("starting"));
        check(r.state().getJSONObject("activity").getString("state").equals("idle"));
        fake.missing=true;r.refresh();check(r.state().getJSONObject("runtime").getString("status").equals("error"));
        check(r.state().getJSONObject("activity").getString("state").equals("stale"));
        fake.missing=false;fake.status="ready";r.refresh();
        fake.status="error";r.refresh();check(r.state().getJSONObject("runtime").getString("status").equals("error"));
        check(r.state().isNull("uiUrl"));
        fake.status="ready";r.refresh();
        fake.health=false;r.refresh();check(r.state().getJSONObject("activity").getString("state").equals("stale"));check(r.state().isNull("uiUrl"));
        r.transition("stop");check(r.state().getJSONObject("runtime").getString("status").equals("stopped"));
        Policy restartPolicy=new Policy(visibility(()->true),false);
        FakeRuntime restarting=new FakeRuntime();restarting.status="ready";
        RuntimeAdapter guarded=new RuntimeAdapter(restarting,restartPolicy::reset);
        guarded.refresh();restartPolicy.update(restartPolicy.revision(),true,false);
        restarting.instance="boot2";guarded.refresh();check(!restartPolicy.fullAccess());
        restartPolicy.update(restartPolicy.revision(),true,false);guarded.refresh();check(restartPolicy.fullAccess());
        restarting.status="stopped";guarded.refresh();check(!restartPolicy.fullAccess());
        AtomicLong healthClock = new AtomicLong(0);
        restarting.status="ready";
        RuntimeAdapter expiring = new RuntimeAdapter(restarting,()->{},healthClock::get);
        expiring.refresh();check(expiring.state().getJSONObject("runtime").getString("status").equals("ready"));
        healthClock.set(10_000_000_001L);
        check(expiring.state().getJSONObject("activity").getString("state").equals("stale"));
        check(expiring.state().isNull("uiUrl"));
        restarting.status="starting";expiring.refresh();
        check(expiring.state().getJSONObject("runtime").getString("status").equals("starting"));
        check(expiring.state().getJSONObject("activity").getString("state").equals("idle"));
        healthClock.addAndGet(10_000_000_001L);
        check(expiring.state().getJSONObject("runtime").getString("status").equals("error"));
        check(expiring.state().getJSONObject("activity").getString("state").equals("stale"));
        check(!expiring.state().getJSONObject("activity").getBoolean("hasWorkingTasks"));
        expiring.refresh();check(expiring.state().getJSONObject("runtime").getString("status").equals("starting"));
        fake.missing=true;fail(503,()->r.transition("start"));check(r.state().getJSONObject("runtime").getString("status").equals("error"));
        JSONObject s=shell(), t=new JSONObject().put("id","t").put("title","Example").put("archivedAt",JSONObject.NULL).put("updatedAt","2026-01-01T00:00:00Z").put("session",JSONObject.NULL).put("hasPendingApprovals",false).put("hasPendingUserInput",false).put("hasActionableProposedPlan",false).put("latestTurn",new JSONObject().put("state","running"));
        s.getJSONArray("threads").put(t);check(RuntimeAdapter.derive(s).getString("state").equals("working"));
        t.put("hasPendingApprovals",true);check(RuntimeAdapter.derive(s).getString("state").equals("waiting"));
        t.put("hasPendingApprovals",false).put("latestTurn",new JSONObject().put("state","completed")).put("backgroundLiveness","monitoring");
        check(RuntimeAdapter.derive(s).getString("state").equals("monitoring"));check(RuntimeAdapter.derive(s).isNull("completedSteps"));
        t.put("backgroundLiveness","working").put("planProgress",new JSONObject().put("step","Build").put("completedSteps",2).put("totalSteps",4));
        check(RuntimeAdapter.derive(s).getInt("completedSteps")==2);
    }
    static void routes() throws Exception {
        Policy p=new Policy(visibility(()->true),false);Broker b=new Broker(p,new RuntimeAdapter(new FakeRuntime()),null,true);
        fail(404,()->b.route(false,new Protocol.Request("POST","/v1/policy",new JSONObject())));
        fail(404,()->b.route(false,new Protocol.Request("GET","/v1/state",new JSONObject())));
        JSONObject grant=new JSONObject().put("expectedRevision",0).put("fullAccess",true).put("computerUse",false);
        JSONObject state=b.route(true,new Protocol.Request("POST","/v1/policy",grant));
        check(state.getJSONObject("policy").getBoolean("fullAccess"));check(!state.getJSONObject("capabilities").getBoolean("computerUse"));
        fail(409,()->b.route(true,new Protocol.Request("POST","/v1/policy",grant)));
        b.route(true,new Protocol.Request("POST","/v1/runtime/stop",new JSONObject()));check(!p.fullAccess());
        JSONObject args=new JSONObject().put("name","mobile_read_file").put("arguments",new JSONObject());
        fail(403,()->b.route(false,new Protocol.Request("POST","/v1/tools/call",args)));
        JSONObject receipts=b.route(true,new Protocol.Request("GET","/v1/receipts",new JSONObject()));
        check(receipts.getJSONArray("receipts").length()==2);
        for(int i=0;i<140;i++) {
            JSONObject update = new JSONObject().put("expectedRevision",p.revision()).put("fullAccess",false).put("computerUse",false);
            b.route(true,new Protocol.Request("POST","/v1/policy",update));
        }
        check(b.route(true,new Protocol.Request("GET","/v1/receipts",new JSONObject())).getJSONArray("receipts").length()==128);
        check(!Broker.known("mobile_shell"));check(Broker.known("mobile_screenshot"));
    }
    public static void main(String[] args) throws Exception { protocol();policy();backgroundData();arbitration();cancellationDoesNotWaitForVisibility();paths();runtimeValidation();runtime();routes();BootstrapTest.run();System.out.println("BrokerTest: "+assertions+" assertions passed"); }
}
