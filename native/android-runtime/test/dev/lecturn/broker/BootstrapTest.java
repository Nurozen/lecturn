package dev.lecturn.broker;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.json.*;

import static dev.lecturn.broker.BrokerTest.*;

/** In-memory HTTP boundary fixtures: no listener, device, or real credential. */
final class BootstrapTest {
    static final String BEARER="synthetic-bearer-0123456789", PAIR="23456789ABCD";
    static final class Connection extends HttpURLConnection {
        int status=200;
        String response, type="application/json; charset=utf-8";
        boolean closed;
        final ByteArrayOutputStream posted=new ByteArrayOutputStream();
        Connection(URL url,String response) { super(url);this.response=response; }
        public void connect() {}
        public void disconnect() {closed=true;}
        public boolean usingProxy() {return false;}
        public int getResponseCode() {return status;}
        public String getContentType() {return type;}
        public InputStream getInputStream() {return new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8));}
        public OutputStream getOutputStream() {return posted;}
    }
    static final class ApiFixture {
        String origin=LecturnApi.ORIGIN, bearer=BEARER;
        int status=200;
        String type="application/json", response;
        final List<Connection> calls=new ArrayList<>();
        final LecturnApi api=new LecturnApi(() -> new JSONObject().put("schemaVersion",1).put("uiUrl",origin)
                .put("lecturnBearerToken",bearer).toString().getBytes(StandardCharsets.UTF_8),url -> {
            Connection c=new Connection(url,response);c.status=status;c.type=type;calls.add(c);return c;
        });
        ApiFixture() throws Exception { pairing(PAIR,"2099-01-01T00:00:00Z"); }
        void pairing(String credential,String expiry) throws Exception {
            response=new JSONObject().put("id","synthetic-link").put("credential",credential).put("expiresAt",expiry).toString();
        }
    }
    static void rejects(Checked operation) throws Exception {
        try {operation.run();throw new AssertionError("expected rejection");}
        catch(IOException | org.json.JSONException | java.time.format.DateTimeParseException | Failure expected) {check(true);}
    }
    static void api() throws Exception {
        ApiFixture f=new ApiFixture();JSONObject result=f.api.bootstrap();
        check(result.getInt("schemaVersion")==1);
        check(result.getString("pairingUrl").equals(LecturnApi.ORIGIN+"/pair#token="+PAIR));
        check(!result.toString().contains(BEARER));
        Connection c=f.calls.get(0);
        check(c.getURL().toString().equals(LecturnApi.ORIGIN+"/api/auth/pairing-token"));
        check(c.getRequestMethod().equals("POST"));
        check(c.getRequestProperty("Authorization").equals("Bearer "+BEARER));
        check(c.getRequestProperty("Content-Type").equals("application/json"));
        check(!new JSONObject(c.posted.toString("UTF-8")).has("scopes"));
        check(!c.getInstanceFollowRedirects() && !c.getUseCaches() && c.closed);
        for(String bad:new String[]{"https://127.0.0.1:3773","http://localhost:3773","http://127.0.0.1:3773/",
                "http://127.0.0.1:3773@evil.test","http://127.0.0.1:3773#token=secret","http://127.0.0.1:3773?token=secret",
                "http://127.0.0.1:3774","file:///private","http://127.0.0.1:3773/pair"}) {
            f.origin=bad;int before=f.calls.size();rejects(f.api::bootstrap);check(before==f.calls.size());
        }
        f.origin=LecturnApi.ORIGIN;f.bearer=BEARER+"\r\nX-Evil: yes";rejects(f.api::bootstrap);f.bearer=BEARER;
        for(int code:new int[]{301,302,307,308,401,403,404,500}) {
            f.status=code;rejects(f.api::bootstrap);check(f.calls.get(f.calls.size()-1).closed);
        }
        f.status=200;f.type="text/html";rejects(f.api::bootstrap);f.type="application/json";
        for(String bad:new String[]{"{\"credential\":true}","{\"credential\":\"first\",\"credential\":\"second\"}","<html>Login</html>","x".repeat(16385)}) {
            f.response=bad;rejects(f.api::bootstrap);
        }
        for(String bad:new String[]{BEARER,"http://evil.test",PAIR+"\r\n",PAIR+"&redirect=evil",""}) {
            f.pairing(bad,"2099-01-01T00:00:00Z");rejects(f.api::bootstrap);
        }
        f.pairing(PAIR,"2000-01-01T00:00:00Z");rejects(f.api::bootstrap);
        f.pairing(PAIR,"invalid");rejects(f.api::bootstrap);
        f.response="{\"environmentId\":\"env /?#%\"}";
        check(f.api.environmentId().equals("env /?#%"));
        check(f.calls.get(f.calls.size()-1).getURL().getPath().equals("/.well-known/lecturn/environment"));
        for(String id:new String[]{"", "..", ".", " id", "id\n"}) {
            f.response=new JSONObject().put("environmentId",id).toString();rejects(f.api::environmentId);
        }
        rejects(()->LecturnApi.routeSegment("\uD800"));
        f.response="{\"environmentId\":7}";rejects(f.api::environmentId);
        f.response=shell().toString();check(f.api.shell().getInt("snapshotSequence")==3);
        check(f.calls.get(f.calls.size()-1).getURL().getPath().equals("/api/orchestration/shell"));
    }
    static JSONObject thread(String id,String updated) throws Exception {
        return new JSONObject().put("id",id).put("title","Synthetic work").put("updatedAt",updated)
                .put("archivedAt",JSONObject.NULL).put("session",JSONObject.NULL)
                .put("latestTurn",new JSONObject().put("state","running"))
                .put("hasPendingApprovals",false).put("hasPendingUserInput",false).put("hasActionableProposedPlan",false);
    }
    static void routing() throws Exception {
        FakeRuntime backend=new FakeRuntime();backend.status="ready";
        JSONObject older=thread("older","2026-01-01T00:00:00Z"), fresh=thread("fresh /?#%","2026-01-02T00:00:00Z");
        backend.snapshot.getJSONArray("threads").put(older).put(fresh);
        AtomicLong clock=new AtomicLong();RuntimeAdapter runtime=new RuntimeAdapter(backend,()->{},clock::get);
        runtime.refresh();JSONObject state=runtime.state();
        check(state.getJSONObject("activity").getString("threadId").equals("fresh /?#%"));
        check(state.getJSONObject("activity").getString("taskUrl").equals(LecturnApi.ORIGIN+"/environment-fixture/fresh%20%2F%3F%23%25"));
        check(state.getString("uiUrl").equals(LecturnApi.ORIGIN));
        check(state.getJSONObject("activity").getBoolean("hasWorkingTasks"));
        check(state.getJSONObject("activity").getInt("workingCount")==2);
        older.put("hasPendingApprovals",true);runtime.refresh();
        JSONObject attention=runtime.state().getJSONObject("activity");
        check(attention.getString("threadId").equals("older"));
        check(attention.getString("state").equals("waiting"));
        check(attention.getBoolean("hasWorkingTasks") && attention.getInt("workingCount")==1);
        older.put("hasPendingApprovals",false).put("latestTurn",new JSONObject().put("state","error"));runtime.refresh();
        attention=runtime.state().getJSONObject("activity");
        check(attention.getString("state").equals("error"));
        check(attention.getBoolean("hasWorkingTasks") && attention.getInt("workingCount")==1);
        fresh.put("archivedAt","2026-01-03T00:00:00Z");runtime.refresh();
        check(!runtime.state().getJSONObject("activity").getBoolean("hasWorkingTasks"));
        check(runtime.state().getJSONObject("activity").getInt("workingCount")==0);
        fresh.put("archivedAt",JSONObject.NULL);
        older.put("latestTurn",new JSONObject().put("state","running"));
        backend.environment="env /?#%";runtime.refresh();
        check(runtime.state().getJSONObject("activity").getString("taskUrl").equals(LecturnApi.ORIGIN+"/env%20%2F%3F%23%25/fresh%20%2F%3F%23%25"));
        backend.origin=LecturnApi.ORIGIN+"#token="+PAIR;runtime.refresh();
        check(runtime.state().isNull("uiUrl") && runtime.state().getJSONObject("activity").isNull("taskUrl"));
        backend.origin=LecturnApi.ORIGIN;runtime.refresh();
        fresh.put("archivedAt","2026-01-03T00:00:00Z");runtime.refresh();
        check(runtime.state().getJSONObject("activity").getString("threadId").equals("older"));
        clock.set(10_000_000_001L);check(runtime.state().getJSONObject("activity").isNull("taskUrl"));
        fail(503,runtime::bootstrap);
        runtime.refresh();older.put("hasPendingApprovals","false");runtime.refresh();
        check(runtime.state().getJSONObject("activity").getString("state").equals("stale"));
        check(runtime.state().isNull("uiUrl"));check(runtime.state().getJSONObject("activity").isNull("taskUrl"));
        older.put("hasPendingApprovals",false).put("latestTurn",new JSONObject().put("state","invented"));
        rejects(()->RuntimeAdapter.derive(backend.snapshot));
        older.put("latestTurn",JSONObject.NULL).put("updatedAt","bad-time");rejects(()->RuntimeAdapter.derive(backend.snapshot));
        older.put("updatedAt","2026-01-01T00:00:00Z").put("id","..");rejects(()->RuntimeAdapter.derive(backend.snapshot));
        backend.snapshot=shell();runtime.refresh();check(runtime.state().getJSONObject("activity").isNull("taskUrl"));
        backend.health=false;runtime.refresh();check(runtime.state().getJSONObject("activity").isNull("taskUrl"));
    }
    static void control() throws Exception {
        ApiFixture api=new ApiFixture();AtomicInteger issues=new AtomicInteger();AtomicBoolean health=new AtomicBoolean(true);
        CountDownLatch entered=new CountDownLatch(1), release=new CountDownLatch(1);AtomicBoolean block=new AtomicBoolean();
        RuntimeAdapter.Backend backend=new RuntimeAdapter.Backend() {
            public JSONObject command(String verb) throws Exception {return new JSONObject().put("status","ready").put("instanceId","synthetic-boot");}
            public JSONObject shell() throws Exception {if(!health.get())throw new IOException(BEARER);return BrokerTest.shell();}
            public String uiUrl(){return LecturnApi.ORIGIN;}
            public String environmentId(){return "synthetic-env";}
            public JSONObject bootstrap() throws Exception {
                issues.incrementAndGet();if(block.get()){entered.countDown();release.await();}return api.api.bootstrap();
            }
        };
        RuntimeAdapter runtime=new RuntimeAdapter(backend);runtime.refresh();
        Broker broker=new Broker(new Policy(BrokerTest.visibility(()->true),false),runtime,null,true);
        Protocol.Request post=request("POST","/v1/ui/bootstrap","{}","");
        fail(404,()->broker.route(false,post));check(issues.get()==0);
        fail(404,()->broker.route(true,request("GET","/v1/ui/bootstrap",null,"")));
        fail(400,()->broker.route(true,request("POST","/v1/ui/bootstrap","{\"url\":\"http://evil.test\"}","")));
        fail(403,()->request("POST","/v1/ui/bootstrap","{}","Origin: null\r\n"));
        fail(403,()->request("POST","/v1/ui/bootstrap","{}","Referer: http://127.0.0.1:3773\r\n"));
        String raw="POST /v1/ui/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:18768\r\nAuthorization: Bearer agent-token\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        fail(401,()->Protocol.read(new ByteArrayInputStream(raw.getBytes(StandardCharsets.US_ASCII)),TOKEN,18768));
        check(broker.route(true,post).getString("pairingUrl").contains(PAIR));
        ByteArrayOutputStream wire=new ByteArrayOutputStream();Protocol.respond(wire,200,broker.route(true,post));
        check(wire.toString("UTF-8").contains("Cache-Control: no-store"));
        for(String path:new String[]{"/v1/state","/v1/receipts"}) {
            String response=broker.route(true,request("GET",path,null,"")).toString();
            check(!response.contains(PAIR) && !response.contains(BEARER) && !response.contains("pairingUrl"));
        }
        api.status=403;
        try {broker.route(true,post);throw new AssertionError("auth failure");}
        catch(Failure error) {check(error.status==503 && error.getMessage().equals("ui_bootstrap_failed"));}
        api.status=200;api.response="invalid "+BEARER+PAIR;
        fail(503,()->broker.route(true,post));
        api.pairing(PAIR,"2099-01-01T00:00:00Z");block.set(true);
        ExecutorService worker=Executors.newSingleThreadExecutor();
        try {
            Future<JSONObject> flight=worker.submit(()->broker.route(true,post));
            check(entered.await(5,TimeUnit.SECONDS));fail(409,()->broker.route(true,post));
            check(!runtime.state().toString().contains(PAIR));release.countDown();flight.get(5,TimeUnit.SECONDS);
        } finally {release.countDown();worker.shutdownNow();}
        health.set(false);int before=issues.get();fail(503,()->broker.route(true,post));check(issues.get()==before);
        check(runtime.state().getJSONObject("activity").isNull("taskUrl"));
    }
    static void run() throws Exception {api();routing();control();}
}
