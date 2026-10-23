package dev.lecturn.broker;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import org.json.*;

/** Fixed phone-loopback API; credentials never become runtime state or receipts. */
final class LecturnApi {
    static final String ORIGIN = "http://127.0.0.1:3773";
    interface ConfigSource { byte[] read() throws Exception; }
    interface Connections { HttpURLConnection open(URL url) throws IOException; }
    private final ConfigSource configSource;
    private final Connections connections;
    LecturnApi() {
        this(() -> SecureFiles.privateFile(RuntimeAdapter.STATUS,16384,0),
                url -> (HttpURLConnection)url.openConnection(Proxy.NO_PROXY));
    }
    LecturnApi(ConfigSource configSource, Connections connections) {
        this.configSource=configSource;this.connections=connections;
    }
    private String bearer() throws Exception {
        JSONObject config=Protocol.json(configSource.read());
        Protocol.fields(config,"schemaVersion","uiUrl","lecturnBearerToken");
        Protocol.integer(config,"schemaVersion",1,1);
        if (!ORIGIN.equals(Protocol.string(config,"uiUrl"))) throw new IOException("invalid_runtime_origin");
        String token=Protocol.string(config,"lecturnBearerToken");
        if (token.length()<16 || token.length()>4096 || !token.matches("[A-Za-z0-9._~+/-]+=*"))
            throw new IOException("invalid_runtime_token");
        return token;
    }
    JSONObject shell() throws Exception { return request("/api/orchestration/shell",null,2*1024*1024); }
    String environmentId() throws Exception {
        String id=Protocol.string(request("/.well-known/lecturn/environment",null,65536),"environmentId");
        routeSegment(id);
        return id;
    }
    JSONObject bootstrap() throws Exception {
        // Omitted scopes selects AuthStandardClientScopes, which include access:write and relay:write.
        JSONObject result=request("/api/auth/pairing-token",new JSONObject().put("label","Lecturn Android host"),16384);
        String credential=Protocol.string(result,"credential");
        if (!credential.matches("[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}")) throw new IOException("invalid_pairing_credential");
        String expiresAt=Protocol.string(result,"expiresAt");
        if (!Instant.parse(expiresAt).isAfter(Instant.now())) throw new IOException("expired_pairing_credential");
        // shared/remote.ts uses a fragment: it is never sent in an HTTP request URL.
        return new JSONObject().put("schemaVersion",1).put("pairingUrl",ORIGIN+"/pair#token="+credential).put("expiresAt",expiresAt);
    }
    private JSONObject request(String path,JSONObject body,int max) throws Exception {
        String token=bearer();
        HttpURLConnection conn=connections.open(new URL(ORIGIN+path));
        conn.setInstanceFollowRedirects(false);conn.setConnectTimeout(1500);conn.setReadTimeout(2000);
        conn.setUseCaches(false);
        conn.setRequestProperty("Authorization","Bearer "+token);
        conn.setRequestProperty("Accept","application/json");
        try {
            if (body!=null) {
                byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);
                conn.setRequestMethod("POST");conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type","application/json");
                conn.setFixedLengthStreamingMode(bytes.length);
                try(OutputStream out=conn.getOutputStream()) { out.write(bytes); }
            }
            if (conn.getResponseCode()!=200) throw new IOException("lecturn_api_failed");
            String type=conn.getContentType();
            if(type==null || !type.split(";",2)[0].trim().equalsIgnoreCase("application/json"))
                throw new IOException("invalid_lecturn_response");
            long deadline=System.nanoTime()+5_000_000_000L;
            try(InputStream in=new FilterInputStream(conn.getInputStream()) {
                public int read(byte[] b,int off,int len) throws IOException {
                    if(System.nanoTime()>deadline) throw new IOException("lecturn_api_deadline");
                    return super.read(b,off,len);
                }
            }) { return Protocol.json(Protocol.bounded(in,max)); }
        } finally { conn.disconnect(); }
    }
    static String routeSegment(String id) throws Exception {
        if(id.isEmpty() || id.length()>1024 || !id.equals(id.trim()) || id.equals(".") || id.equals("..")
                || id.chars().anyMatch(c -> c<32 || c==127) || !StandardCharsets.UTF_8.newEncoder().canEncode(id))
            throw new IOException("invalid_route_id");
        return URLEncoder.encode(id,StandardCharsets.UTF_8.name()).replace("+","%20");
    }
}
