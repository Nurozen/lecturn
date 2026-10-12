package dev.lecturn.broker;

import java.io.*;
import java.nio.file.*;
import java.util.concurrent.*;
import org.json.*;

final class RuntimeAdapter {
    static final String CONTROL = "/data/local/symba-runtime/bin/runtime-control";
    static final String STATUS = "/data/local/symba-runtime/state/runtime.json";
    interface Backend { JSONObject command(String verb) throws Exception; JSONObject shell() throws Exception; String uiUrl(); String environmentId(); JSONObject bootstrap() throws Exception; }
    static final class AndroidBackend implements Backend {
        private final LecturnApi api = new LecturnApi();
        private String environment;
        public JSONObject command(String verb) throws Exception {
            if (!verb.matches("start|stop|status")) throw new IOException("invalid_runtime_verb");
            // Every ancestor must be immutable to app/guest UIDs; no PATH lookup or shell.
            for (Path p = Paths.get(CONTROL); p != null; p = p.getParent()) {
                int uid = ((Number)Files.getAttribute(p,"unix:uid",LinkOption.NOFOLLOW_LINKS)).intValue();
                int mode = ((Number)Files.getAttribute(p,"unix:mode",LinkOption.NOFOLLOW_LINKS)).intValue();
                int gid = ((Number)Files.getAttribute(p,"unix:gid",LinkOption.NOFOLLOW_LINKS)).intValue();
                validateControlPath(p,uid,gid,mode,Files.isDirectory(p,LinkOption.NOFOLLOW_LINKS),Files.isSymbolicLink(p));
            }
            if (!Files.isRegularFile(Paths.get(CONTROL),LinkOption.NOFOLLOW_LINKS) || !Files.isExecutable(Paths.get(CONTROL)))
                throw new IOException("runtime_control_missing");
            JSONObject result = Protocol.json(run(30,65536,CONTROL,verb));
            validateStatus(result);
            return result;
        }
        public JSONObject shell() throws Exception {
            JSONObject shell = api.shell();
            validateShell(shell);
            environment = api.environmentId();
            return shell;
        }
        public String uiUrl() { return LecturnApi.ORIGIN; }
        public String environmentId() { return environment; }
        public JSONObject bootstrap() throws Exception { return api.bootstrap(); }
    }
    static void validateControlPath(Path path,int uid,int gid,int mode,boolean directory,boolean symlink) throws IOException {
        // Android's platform-owned /data is system:system 0771, not root-owned.
        boolean platformData = path.equals(Paths.get("/data")) && uid == 1000 && gid == 1000
                && (mode & 07777) == 0771 && directory;
        if (symlink || (!platformData && (uid != 0 || (mode & 0022) != 0)))
            throw new IOException("untrusted_runtime_control");
    }
    static void validateStatus(JSONObject result) throws Exception {
        Protocol.fields(result,"schemaVersion","status","instanceId","message");
        if (result.has("message") && Protocol.string(result,"message").length()>512) throw new IOException("invalid_runtime_message");
        if (Protocol.integer(result,"schemaVersion",1,1) != 1 || !Protocol.string(result,"status").matches("stopped|starting|ready|error"))
            throw new IOException("invalid_runtime_status");
        if (!result.getString("status").equals("stopped") && !result.getString("status").equals("error")) {
            String instance = Protocol.string(result,"instanceId");
            if (!instance.matches("[A-Za-z0-9_-]{1,128}")) throw new IOException("invalid_runtime_instance");
        }
    }
    static byte[] run(int seconds, int max, String... argv) throws Exception {
        ProcessBuilder builder = new ProcessBuilder(argv).redirectError(new File("/dev/null"));
        builder.environment().clear();
        builder.environment().put("PATH", "/system/bin");
        builder.environment().put("LANG", "C");
        Process process = builder.start();
        process.getOutputStream().close();
        ExecutorService reader = Executors.newSingleThreadExecutor(r -> { Thread t=new Thread(r,"bounded-process-reader");t.setDaemon(true);return t; });
        Future<byte[]> output = reader.submit(() -> { try (InputStream in=process.getInputStream()) { return Protocol.bounded(in,max); } });
        try {
            if (!process.waitFor(seconds,TimeUnit.SECONDS)) throw new IOException("process_timeout");
            byte[] data=output.get(1,TimeUnit.SECONDS);
            if (process.exitValue()!=0) throw new IOException("process_failed");
            return data;
        } finally { process.destroyForcibly(); output.cancel(true); reader.shutdownNow(); process.getInputStream().close(); }
    }
    private final Backend backend;
    private final Runnable resetPolicy;
    private final java.util.concurrent.locks.ReentrantLock operations = new java.util.concurrent.locks.ReentrantLock();
    private volatile JSONObject view;
    private final java.util.function.LongSupplier clock;
    private volatile long lastHealth;
    private String observedInstance;
    private String observedStatus = "stopped";
    RuntimeAdapter(Backend backend) throws Exception { this(backend, () -> {}); }
    RuntimeAdapter(Backend backend, Runnable resetPolicy) throws Exception { this(backend, resetPolicy, System::nanoTime); }
    RuntimeAdapter(Backend backend, Runnable resetPolicy, java.util.function.LongSupplier clock) throws Exception {
        this.backend = backend; this.resetPolicy = resetPolicy; this.clock = clock;
        publish("stopped", "Runtime not started", null, activity("idle", "Runtime not started"));
    }
    private void publish(String status, String message, String ui, JSONObject activity) throws Exception {
        view = new JSONObject().put("runtime", new JSONObject().put("status",status).put("message",message))
                .put("uiUrl",ui==null ? JSONObject.NULL : ui).put("activity",activity);
    }
    private String observe(JSONObject receipt) throws Exception {
        String actual = Protocol.string(receipt,"status");
        String instance = receipt.optString("instanceId", "");
        if (!instance.equals(observedInstance) || (!actual.equals(observedStatus) && actual.equals("stopped"))) resetPolicy.run();
        observedInstance = instance; observedStatus = actual;
        return actual;
    }
    void transition(String verb) throws Exception {
        if (!verb.equals("start") && !verb.equals("stop")) throw new Failure(400,"invalid_transition");
        if (!operations.tryLock()) throw new Failure(409,"runtime_transition_in_progress");
        try {
            String actual = observe(backend.command(verb));
            if (verb.equals("stop")) {
                if (!actual.equals("stopped") || !observe(backend.command("status")).equals("stopped")) throw new IOException("stop_not_complete");
                publish("stopped", "Runtime stopped", null, activity("idle", "Runtime stopped")); return;
            }
            if (!actual.equals("starting") && !actual.equals("ready")) throw new IOException("start_not_accepted");
            String message = "Waiting for authenticated Lecturn health";
            lastHealth = clock.getAsLong();
            publish("starting", message, null, activity("idle",message));
            refreshLocked();
        } catch (Exception e) {
            publish("error", "Runtime transition failed", null, activity("error", "Runtime transition failed"));
            throw new Failure(503,"runtime_transition_failed");
        } finally { operations.unlock(); }
    }
    void refresh() {
        if (!operations.tryLock()) return;
        try { refreshLocked(); } finally { operations.unlock(); }
    }
    private void refreshLocked() {
        try {
            String actual = observe(backend.command("status"));
            if (actual.equals("stopped")) {
                publish("stopped", "Runtime stopped", null, activity("idle", "Runtime stopped")); return;
            }
            if (actual.equals("starting")) {
                lastHealth = clock.getAsLong();
                publish("starting", "Runtime startup pending", null, activity("idle", "Runtime startup pending"));
                return;
            }
            if (!actual.equals("ready")) throw new IOException("runtime_unavailable");
            JSONObject shell = backend.shell();
            JSONObject activity = derive(shell);
            if (!LecturnApi.ORIGIN.equals(backend.uiUrl())) throw new IOException("invalid_runtime_origin");
            String environment = backend.environmentId();
            if (environment == null) throw new IOException("missing_environment");
            if (!activity.isNull("threadId")) activity.put("taskUrl",LecturnApi.ORIGIN+"/"+LecturnApi.routeSegment(environment)+"/"
                    +LecturnApi.routeSegment(activity.getString("threadId")));
            lastHealth = clock.getAsLong();
            publish("ready", "Authenticated Lecturn API reachable", backend.uiUrl(), activity);
        } catch (Exception e) {
            try {
                String message = "Runtime control or authenticated Lecturn state unavailable";
                publish("error",message,null,activity("stale",message));
            } catch (Exception impossible) { throw new IllegalStateException(impossible); }
        }
    }
    JSONObject bootstrap() throws Exception {
        if (!operations.tryLock()) throw new Failure(409,"runtime_transition_in_progress");
        try {
            if (!state().getJSONObject("runtime").getString("status").equals("ready"))
                throw new Failure(503,"ui_bootstrap_unavailable");
            // Revalidate runtime and authenticated state before issuing a new one-use link.
            refreshLocked();
            if (!state().getJSONObject("runtime").getString("status").equals("ready"))
                throw new Failure(503,"ui_bootstrap_unavailable");
            try { return backend.bootstrap(); }
            catch (Exception e) { throw new Failure(503,"ui_bootstrap_failed"); }
        } finally { operations.unlock(); }
    }
    JSONObject state() throws Exception {
        JSONObject state = new JSONObject(view.toString());
        String status = state.getJSONObject("runtime").getString("status");
        if ((status.equals("ready") || status.equals("starting")) && clock.getAsLong() - lastHealth > 10_000_000_000L) {
            state.put("runtime", new JSONObject().put("status","error").put("message","Runtime observation expired"))
                    .put("uiUrl",JSONObject.NULL).put("activity",activity("stale","Runtime observation expired"));
        }
        return state;
    }
    static void validateShell(JSONObject shell) throws Exception {
        Protocol.integer(shell,"snapshotSequence",0,Long.MAX_VALUE);
        shell.getJSONArray("projects");
        timestamp(shell,"updatedAt");
        JSONArray threads=shell.getJSONArray("threads");
        java.util.Set<String> ids=new java.util.HashSet<>();
        for(int i=0;i<threads.length();i++) {
            JSONObject t=threads.getJSONObject(i);
            String id=Protocol.string(t,"id");LecturnApi.routeSegment(id);
            if(!ids.add(id)) throw new IOException("duplicate_thread_id");
            Protocol.string(t,"title");timestamp(t,"updatedAt");
            if(!t.isNull("archivedAt")) timestamp(t,"archivedAt");
            for(String key:new String[]{"hasPendingApprovals","hasPendingUserInput","hasActionableProposedPlan"}) Protocol.bool(t,key);
            nullableState(t,"session","status","idle|starting|running|ready|interrupted|stopped|error");
            nullableState(t,"latestTurn","state","running|interrupted|completed|error");
            if(!t.isNull("backgroundLiveness") && !Protocol.string(t,"backgroundLiveness").matches("working|monitoring"))
                throw new IOException("invalid_background_liveness");
            if(!t.isNull("planProgress")) {
                JSONObject p=t.getJSONObject("planProgress");
                long total=Protocol.integer(p,"totalSteps",0,Integer.MAX_VALUE);
                Protocol.integer(p,"completedSteps",0,total);Protocol.string(p,"step");
            }
        }
    }
    private static void nullableState(JSONObject t,String key,String field,String allowed) throws Exception {
        if(!t.has(key)) throw new IOException("missing_thread_state");
        if(!t.isNull(key) && !Protocol.string(t.getJSONObject(key),field).matches(allowed)) throw new IOException("invalid_thread_state");
    }
    private static java.time.Instant timestamp(JSONObject object,String key) throws Exception {
        return java.time.Instant.parse(Protocol.string(object,key));
    }
    static JSONObject activity(String state,String detail) throws Exception {
        return new JSONObject().put("state",state).put("threadId",JSONObject.NULL).put("title","").put("detail",detail)
                .put("taskUrl",JSONObject.NULL).put("completedSteps",JSONObject.NULL).put("totalSteps",JSONObject.NULL)
                .put("hasWorkingTasks",false).put("workingCount",0);
    }
    static String threadState(JSONObject t) {
        if (t.optBoolean("hasPendingApprovals") || t.optBoolean("hasPendingUserInput") || t.optBoolean("hasActionableProposedPlan")) return "waiting";
        JSONObject session=t.optJSONObject("session"), turn=t.optJSONObject("latestTurn");
        if ((session!=null && session.optString("status").equals("error")) || (turn!=null && turn.optString("state").equals("error"))) return "error";
        if ((session!=null && session.optString("status").equals("running")) || (turn!=null && turn.optString("state").equals("running")) || t.optString("backgroundLiveness").equals("working")) return "working";
        if (t.optString("backgroundLiveness").equals("monitoring")) return "monitoring";
        if (turn!=null && turn.optString("state").equals("completed")) return "completed";
        return "idle";
    }
    static JSONObject derive(JSONObject shell) throws Exception {
        validateShell(shell);
        JSONArray threads=shell.getJSONArray("threads"); JSONObject selected=null; int rank=-1; String state="idle";
        String order="idle completed monitoring working error waiting";
        int workingCount=0;
        for (int i=0;i<threads.length();i++) {
            JSONObject t=threads.getJSONObject(i);
            if (!t.isNull("archivedAt")) continue;
            String candidate=threadState(t); int r=order.indexOf(candidate);
            if (candidate.equals("working")) workingCount++;
            if (r>rank || (r==rank && selected!=null && timestamp(t,"updatedAt").isAfter(timestamp(selected,"updatedAt")))) { selected=t;state=candidate;rank=r; }
        }
        JSONObject out=activity(state,"Authenticated orchestration snapshot")
                .put("hasWorkingTasks",workingCount>0).put("workingCount",workingCount);
        if (selected==null) return out;
        out.put("threadId",Protocol.string(selected,"id")).put("title",truncate(Protocol.string(selected,"title"),240));
        JSONObject progress=selected.optJSONObject("planProgress");
        if (progress!=null && state.equals("working")) {
            long total=Protocol.integer(progress,"totalSteps",0,Integer.MAX_VALUE), complete=Protocol.integer(progress,"completedSteps",0,total);
            out.put("completedSteps",complete).put("totalSteps",total).put("detail",truncate(Protocol.string(progress,"step"),500));
        }
        return out;
    }
    static String truncate(String s,int max) { return s.length()>max?s.substring(0,max):s; }
}
