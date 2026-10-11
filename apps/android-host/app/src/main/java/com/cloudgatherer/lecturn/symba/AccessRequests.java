package com.cloudgatherer.lecturn.symba;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;

/** Bounded document-owned requests. Late controller receipts cannot settle a replacement request. */
final class AccessRequests {
    private final Map<String, Pending> pending = new HashMap<>();
    final class Pending {
        final String id;
        final Consumer<HostState> reply;
        Runnable cleanup = () -> {};
        Pending(String id, Consumer<HostState> reply) { this.id = id; this.reply = reply; }
        boolean active() { return pending.get(id) == this; }
        void finish(HostState state) {
            if (!active()) return;
            pending.remove(id);
            cleanup.run();
            reply.accept(state);
        }
    }
    Pending add(String id, Consumer<HostState> reply) {
        if (pending.size() >= 16 || pending.containsKey(id)) return null;
        Pending request = new Pending(id, reply);
        pending.put(id, request);
        return request;
    }
    void drain() {
        for (Pending request : pending.values().toArray(new Pending[0])) request.finish(null);
    }
}
