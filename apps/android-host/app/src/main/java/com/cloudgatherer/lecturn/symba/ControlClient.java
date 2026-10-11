package com.cloudgatherer.lecturn.symba;

import android.content.Context;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class ControlClient {
    static final class Failure extends Exception {
        final boolean conflict, transitionConflict;
        Failure(String safeMessage, boolean conflict) { this(safeMessage, conflict, false); }
        Failure(String safeMessage, boolean conflict, boolean transitionConflict) {
            super(safeMessage); this.conflict = conflict; this.transitionConflict = transitionConflict;
        }
    }
    interface ConfigSource { String read() throws Exception; }
    interface Connections { HttpURLConnection open(URL url) throws IOException; }
    private final ConfigSource configSource;
    private final Connections connections;
    ControlClient(Context context) {
        this(() -> {
            try (InputStream in = new FileInputStream(new File(context.getFilesDir(), "host-config.json"))) {
                return readLimited(in, 4096);
            }
        }, url -> (HttpURLConnection) url.openConnection(Proxy.NO_PROXY));
    }
    ControlClient(ConfigSource configSource, Connections connections) {
        this.configSource = configSource; this.connections = connections;
    }

    HostState request(String method, String path, JSONObject body) throws Failure {
        try { return HostState.parse(requestJson(method, path, body)); }
        catch (org.json.JSONException e) { throw new Failure("Control state is invalid. Runtime and device access are unverified.", false); }
    }

    UiBootstrap bootstrap() throws Failure {
        try { return UiBootstrap.parse(requestJson("POST", "/v1/ui/bootstrap", new JSONObject()), java.time.Instant.now()); }
        catch (org.json.JSONException e) { throw new Failure("Pairing response is invalid or expired. Retry pairing in Lecturn.", false); }
    }

    private String requestJson(String method, String path, JSONObject body) throws Failure {
        HttpURLConnection connection = null;
        try {
            JSONObject config;
            try {
                config = new JSONObject(configSource.read());
            } catch (Exception e) {
                throw new Failure("Private host configuration is missing or invalid. Runtime is not connected.", false);
            }
            Object rawToken = config.opt("controlToken");
            Object port = config.opt("controlPort");
            if (!(rawToken instanceof String) || !((String) rawToken).matches("[0-9a-fA-F]{64}")
                    || !(port instanceof Integer) || (Integer) port != 18768) {
                throw new Failure("Private host configuration is invalid. Runtime is not connected.", false);
            }
            connection = connections.open(new URL("http://127.0.0.1:18768" + path));
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(3000);
            // The controller may spend 28 seconds stopping; allow the confirmation overhead too.
            connection.setReadTimeout("POST".equals(method) && "/v1/runtime/stop".equals(path) ? 32000 : 12000);
            connection.setUseCaches(false);
            connection.setRequestMethod(method);
            connection.setRequestProperty("Authorization", "Bearer " + rawToken);
            connection.setRequestProperty("Accept", "application/json");
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (var out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status == 409) {
                String code = "";
                try (InputStream in = connection.getErrorStream()) {
                    if (in != null) code = new JSONObject(readLimited(in, 4096)).optString("error", "");
                } catch (Exception ignored) { /* Unknown conflicts must never authorize replay. */ }
                boolean runtime = "POST".equals(method)
                        && ("/v1/runtime/stop".equals(path) || "/v1/runtime/start".equals(path));
                if (runtime && "runtime_transition_in_progress".equals(code))
                    throw new Failure("Runtime is busy with another control operation. Try again shortly.", false, true);
                if ("/v1/policy".equals(path) && "stale_policy_revision".equals(code))
                    throw new Failure("Device access changed. Review the refreshed policy before trying again.", true);
                throw new Failure("Control request conflicted. Refresh status before trying again.", false);
            }
            if (status != 200) throw new Failure("Control request failed (HTTP " + status + "). No access change confirmed.", false);
            String type = connection.getContentType();
            if (type == null || !"application/json".equalsIgnoreCase(type.split(";", 2)[0].trim()))
                throw new IOException("Invalid content type");
            try (InputStream in = connection.getInputStream()) {
                return readLimited(in, 262144);
            }
        } catch (Failure e) {
            throw e;
        } catch (Exception e) {
            // Never propagate response bodies, URLs, config, or transport exception text to logs/UI.
            throw new Failure("Control status unavailable or invalid. Runtime and device access are unverified.", false);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static String readLimited(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = in.read(buffer)) != -1) {
            if (out.size() + count > max) throw new IOException("Response too large");
            out.write(buffer, 0, count);
        }
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
