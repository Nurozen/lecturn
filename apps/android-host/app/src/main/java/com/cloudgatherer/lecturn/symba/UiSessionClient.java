package com.cloudgatherer.lecturn.symba;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import org.json.JSONObject;

/** Checks exactly the WebView cookie session; never reads the native control configuration. */
final class UiSessionClient {
    private final ControlClient.Connections connections;
    UiSessionClient() { this(url -> (HttpURLConnection) url.openConnection(Proxy.NO_PROXY)); }
    UiSessionClient(ControlClient.Connections connections) { this.connections = connections; }
    boolean authenticated(String cookie) throws Exception {
        HttpURLConnection connection = connections.open(new URL(OriginPolicy.ORIGIN + "/api/auth/session"));
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(3000); connection.setReadTimeout(5000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            if (connection.getResponseCode() != 200) throw new IOException("Session unavailable");
            String type = connection.getContentType();
            if (type == null || !"application/json".equalsIgnoreCase(type.split(";", 2)[0].trim()))
                throw new IOException("Invalid session response");
            try (var in = connection.getInputStream()) {
                Object authenticated = new JSONObject(ControlClient.readLimited(in, 16384)).opt("authenticated");
                if (!(authenticated instanceof Boolean)) throw new IOException("Invalid session state");
                return (Boolean) authenticated;
            }
        } finally { connection.disconnect(); }
    }
}
