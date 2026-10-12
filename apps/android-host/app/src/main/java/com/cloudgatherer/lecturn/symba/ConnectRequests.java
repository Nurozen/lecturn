package com.cloudgatherer.lecturn.symba;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;
import org.json.JSONObject;

/** Correlated bounded requests with replay protection for the lifetime of one local document. */
final class ConnectRequests {
    private final Map<String, Pending> pending = new HashMap<>();
    private String session;
    private long lastCounter;
    final class Pending {
        private final String id;
        private final Consumer<JSONObject> reply;
        Runnable cleanup = () -> {};
        Pending(String id, Consumer<JSONObject> reply) { this.id = id; this.reply = reply; }
        boolean active() { return pending.get(id) == this; }
        void finish(JSONObject result) {
            if (!active()) return;
            pending.remove(id); cleanup.run(); reply.accept(result);
        }
        void cancel() {
            if (!active()) return;
            pending.remove(id); cleanup.run();
        }
    }
    Pending add(String id, Consumer<JSONObject> reply) {
        if (!AccessProtocol.validId(id)) return null;
        int separator = id.indexOf('_');
        if (separator <= 0) return null;
        String prefix = id.substring(0, separator), counterText = id.substring(separator + 1);
        if (!prefix.matches("[a-z0-9]+") || !counterText.matches("[1-9][0-9]{0,15}")) return null;
        long counter = Long.parseLong(counterText);
        // Match the bridge's session_counter IDs and JavaScript's exact integer range.
        if (counter > 9_007_199_254_740_991L || (session != null && !session.equals(prefix))
                || counter <= lastCounter) return null;
        session = prefix;
        // WebMessages arrive in order; other bridge methods may consume counters between ours.
        // Fence even capacity-rejected IDs so freeing a slot cannot reopen a replay.
        lastCounter = counter;
        if (pending.size() >= 8) return null;
        Pending request = new Pending(id, reply);
        pending.put(id, request);
        return request;
    }
    void clear() {
        for (Pending request : pending.values().toArray(new Pending[0])) request.cancel();
        session = null;
        lastCounter = 0;
    }
    static boolean isMethod(String method) {
        return "getConnectState".equals(method) || "getConnectToken".equals(method)
                || "openConnectSignIn".equals(method) || "signOutConnect".equals(method);
    }
    static boolean mutates(String method) {
        return "openConnectSignIn".equals(method) || "signOutConnect".equals(method);
    }
}
