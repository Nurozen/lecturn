package dev.lecturn.broker;

import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/** Privileged Android-only daemon. The guest receives ONLY the agent credential. */
public final class Broker {
    static final int CONTROL_PORT=18768, AGENT_PORT=18769;
    private final Policy policy;
    private final RuntimeAdapter runtime;
    private final AndroidAccess device;
    private final ArrayDeque<JSONObject> receipts=new ArrayDeque<>();
    private final boolean fileSupported;
    Broker(Policy policy,RuntimeAdapter runtime,AndroidAccess android,boolean fileSupported) {
        this.policy=policy;this.runtime=runtime;this.device=android;this.fileSupported=fileSupported;
    }
    public static void main(String[] args) {
        String stage="launch";
        try {
            if (args.length!=3 || android.os.Process.myUid()!=0) throw new IOException("invalid_launch");
            System.load(args[0]);
            android.os.Looper.class.getMethod("prepareMainLooper").invoke(null);
            stage="android_services";
            AndroidAccess access=new AndroidAccess();
            String controlPath=args[1], agentPath=args[2];
            String pkg="com.cloudgatherer.lecturn.symba";
            if (!(controlPath.startsWith("/data/data/"+pkg+"/files/") || controlPath.startsWith("/data/user_de/0/"+pkg+"/files/"))
                    || !agentPath.equals("/data/local/symba-runtime/state/agent-token")) throw new IOException("invalid_token_location");
            stage="host_identity";
            int hostUid=access.context.getPackageManager().getApplicationInfo(pkg,0).uid;
            if (hostUid<10000 || hostUid>=100000) throw new IOException("invalid_host_uid");
            stage="credentials";
            String control=token(SecureFiles.privateFile(controlPath,65,hostUid));
            String agent=token(SecureFiles.privateFile(agentPath,65,0));
            if (MessageDigest.isEqual(control.getBytes(StandardCharsets.US_ASCII),agent.getBytes(StandardCharsets.US_ASCII))) throw new IOException("tokens_must_differ");
            stage="device_adapter";
            Policy policy=new Policy(access,false);
            access.initializeArbitration(policy);
            Broker broker=new Broker(policy,new RuntimeAdapter(new RuntimeAdapter.AndroidBackend(),policy::reset),access,SecureFiles.supported());
            stage="listeners";
            ServerSocket controlSocket=bind(CONTROL_PORT), agentSocket=bind(AGENT_PORT);
            ScheduledExecutorService poll=Executors.newSingleThreadScheduledExecutor();
            poll.scheduleWithFixedDelay(broker.runtime::refresh,0,2,TimeUnit.SECONDS);
            Thread agentThread=new Thread(() -> broker.serve(agentSocket,agent,false),"agent-listener");agentThread.start();
            broker.serve(controlSocket,control,true);
        } catch (Exception | LinkageError e) {
            System.err.println("lecturn-device-broker: startup failed at "+stage+" ("+e.getClass().getSimpleName()+")");System.exit(1);
        }
    }
    static String token(byte[] bytes) throws IOException {
        String value=new String(bytes,StandardCharsets.US_ASCII);
        if (value.endsWith("\n")) value=value.substring(0,value.length()-1);
        if (!value.matches("[a-fA-F0-9]{64}")) throw new IOException("invalid_token");
        return value;
    }
    private static ServerSocket bind(int port) throws IOException {
        // Allow restart after closed connections enter TIME_WAIT; a live listener still owns its port.
        ServerSocket socket=new ServerSocket();socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"),port),8);return socket;
    }
    private void serve(ServerSocket server,String token,boolean control) {
        ThreadPoolExecutor workers=new ThreadPoolExecutor(2,2,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(8));
        try {
            while (!server.isClosed()) {
                Socket socket=server.accept();socket.setSoTimeout(3000);
                try { workers.execute(() -> connection(socket,token,control)); }
                catch (RejectedExecutionException e) { socket.close(); }
            }
        } catch (IOException e) { policy.reset(); }
        finally { workers.shutdownNow(); }
    }
    private void connection(Socket socket,String token,boolean control) {
        try (Socket owned=socket) {
            int status=200;JSONObject response;
            try {
                long deadline=System.nanoTime()+5_000_000_000L;
                InputStream boundedTime=new FilterInputStream(owned.getInputStream()) {
                    private void check() throws IOException { if (System.nanoTime()>deadline) throw new IOException("request_deadline"); }
                    public int read() throws IOException { check();return super.read(); }
                    public int read(byte[] b,int off,int len) throws IOException { check();return super.read(b,off,len); }
                };
                Protocol.Request request=Protocol.read(boundedTime,token,control?CONTROL_PORT:AGENT_PORT);
                response=route(control,request);
            } catch (Failure e) { status=e.status;response=new JSONObject().put("error",e.getMessage()); }
            catch (Exception e) { status=400;response=new JSONObject().put("error","request_failed"); }
            Protocol.respond(owned.getOutputStream(),status,response);
        } catch (Exception ignored) { /* Do not log headers, tokens, file content, or provider errors. */ }
    }
    JSONObject route(boolean control,Protocol.Request r) throws Exception {
        if (control) {
            if (r.method.equals("GET") && r.path.equals("/v1/state")) return state();
            if (r.method.equals("POST") && r.path.equals("/v1/ui/bootstrap")) {
                Protocol.fields(r.body);
                return runtime.bootstrap();
            }
            if (r.method.equals("GET") && r.path.equals("/v1/receipts")) { synchronized(receipts) { return new JSONObject().put("receipts",new JSONArray(receipts)); } }
            if (r.method.equals("POST") && r.path.equals("/v1/policy")) {
                Protocol.fields(r.body,"expectedRevision","fullAccess","computerUse");
                policy.update(Protocol.integer(r.body,"expectedRevision",0,Long.MAX_VALUE),Protocol.bool(r.body,"fullAccess"),Protocol.bool(r.body,"computerUse"));
                audit("policy",policy.revision(),"applied"); return state();
            }
            if (r.method.equals("POST") && (r.path.equals("/v1/runtime/start") || r.path.equals("/v1/runtime/stop"))) {
                Protocol.fields(r.body);
                // Runtime restarts never retain a broad grant. Revocation precedes stop/start.
                policy.reset();
                runtime.transition(r.path.endsWith("start")?"start":"stop"); return state();
            }
        } else if (r.method.equals("POST") && r.path.equals("/v1/tools/call")) {
            Protocol.fields(r.body,"name","arguments");
            String tool=Protocol.string(r.body,"name");
            if (!known(tool)) throw new Failure(404,"unknown_tool");
            JSONObject args=r.body.getJSONObject("arguments");
            long epoch=policy.revision();
            try {
                JSONObject out=call(tool,args);
                return new JSONObject().put("result",out).put("receipt",audit(tool,epoch,"completed"));
            } catch (Exception e) {
                audit(tool,epoch,"refused_or_failed");
                if (e instanceof Failure) throw e;
                throw new Failure(409,"operation_failed_reconcile_before_retry");
            }
        }
        throw new Failure(404,"route_not_found");
    }
    private JSONObject state() throws Exception {
        JSONObject out=runtime.state();
        synchronized(policy) {
            return out.put("schemaVersion",1).put("policy",new JSONObject().put("revision",policy.revision()).put("fullAccess",policy.fullAccess()).put("computerUse",policy.computerUse()))
                    .put("capabilities",new JSONObject().put("appData",fileSupported).put("computerUse",policy.screenSupported()));
        }
    }
    private JSONObject audit(String op,long epoch,String result) throws Exception {
        JSONObject receipt=new JSONObject().put("id",UUID.randomUUID().toString()).put("operation",op).put("policyRevision",epoch)
                .put("result",result).put("atEpochMs",System.currentTimeMillis());
        synchronized(receipts) { if(receipts.size()==128) receipts.removeFirst();receipts.addLast(receipt); }
        return receipt;
    }
    static boolean known(String tool) {
        return Arrays.asList("mobile_list_packages","mobile_list_files","mobile_read_file","mobile_write_file","mobile_delete_file", "mobile_screen_lease", "mobile_screen_release", "mobile_screenshot", "mobile_tap", "mobile_swipe", "mobile_key", "mobile_launch_package").contains(tool);
    }
    private JSONObject call(String tool,JSONObject args) throws Exception {
        if(tool.equals("mobile_screen_release")) { Protocol.fields(args);policy.revokeLease();return new JSONObject().put("released",true); }
        long epoch=policy.capture();
        if(tool.equals("mobile_screen_lease")) { Protocol.fields(args,"seconds");return new JSONObject().put("leaseId",policy.acquireLease((int)Protocol.integer(args,"seconds",1,15))).put("expiresInSeconds",args.getInt("seconds")); }
        if (tool.equals("mobile_list_packages")) {
            Protocol.fields(args);JSONArray packages=device.packages();policy.check(epoch);return new JSONObject().put("packages",packages);
        }
        if(tool.matches("mobile_(screenshot|tap|swipe|key|launch_package)")) {
            String lease=Protocol.string(args,"leaseId");
            return policy.screen(epoch,lease,() -> device.screen(tool,args,policy,epoch,lease));
        }
        if(!fileSupported) throw new Failure(501,"secure_files_unavailable");
        if(tool.equals("mobile_write_file")) Protocol.fields(args,"root","package","path","data");
        else if(tool.equals("mobile_read_file")) Protocol.fields(args,"root","package","path","offset","length");
        else Protocol.fields(args,"root","package","path");
        String root=Protocol.string(args,"root"), pkg=Protocol.string(args,"package"), path=Protocol.string(args,"path");
        SecureFiles.target(root,pkg,path);
        if(!SecureFiles.publicRoot(root) && !device.installed(pkg)) throw new Failure(404,"package_not_installed");
        if(path.isEmpty() && !tool.equals("mobile_list_files")) throw new Failure(400,"file_path_required");
        switch(tool) {
            case "mobile_list_files":
                String[] entries=SecureFiles.list(root,pkg,path);JSONArray names=new JSONArray();
                for(String name:entries) { try { SecureFiles.target(root,pkg,path.isEmpty()?name:path+"/"+name);names.put(name); } catch(Failure excluded) { /* denied names stay hidden */ } }
                policy.check(epoch);return new JSONObject().put("entries",names);
            case "mobile_read_file":
                long offset=args.has("offset")?Protocol.integer(args,"offset",0,Long.MAX_VALUE-SecureFiles.MAX_FILE):0;
                int length=args.has("length")?(int)Protocol.integer(args,"length",1,SecureFiles.MAX_FILE):SecureFiles.MAX_FILE;
                SecureFiles.Chunk chunk=SecureFiles.read(root,pkg,path,offset,length);policy.check(epoch);
                return new JSONObject().put("data",Base64.getEncoder().encodeToString(chunk.data)).put("encoding","base64").put("untrusted",true)
                        .put("offset",offset).put("bytesRead",chunk.data.length).put("fileTotalBytes",chunk.totalBytes)
                        .put("eof",offset+chunk.data.length>=chunk.totalBytes);
            case "mobile_write_file":
                String encoded=Protocol.string(args,"data");
                if(encoded.length()>349528) throw new Failure(413,"file_too_large");
                byte[] content;
                try { content=Base64.getDecoder().decode(encoded); } catch(IllegalArgumentException e) { throw new Failure(400,"invalid_base64"); }
                if(content.length>SecureFiles.MAX_FILE) throw new Failure(413,"file_too_large");
                long handle=SecureFiles.stage(root,pkg,path,content);
                try { return policy.commit(epoch,() -> { SecureFiles.commit(handle);return new JSONObject().put("bytesWritten",content.length); }); }
                finally { SecureFiles.discard(handle); }
            case "mobile_delete_file":
                return policy.commit(epoch,() -> { SecureFiles.delete(root,pkg,path);return new JSONObject().put("deleted",true); });
            default: throw new Failure(404,"unknown_tool");
        }
    }
}
