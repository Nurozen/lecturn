package com.cloudgatherer.lecturn.symba;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class HostController {
    private static final String STOP_UNCONFIRMED = "Stop was not confirmed. Refresh status or try Stop again.";
    interface Listener { void changed(); }
    interface Completion { void complete(HostState state); }
    interface BootstrapCompletion { void complete(UiBootstrap result); }
    private long stopEpoch;
    private long stopRetryDeadline;
    private int stopRetries;
    private final ControlClient client;
    private final Context context;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<Listener> listeners = new HashSet<>();
    HostState state;
    String error = "Status has not been checked.";
    String stopFailure;
    boolean busy, monitoring, stopping;
    long receivedAt;
    final StartupLease startupLease = new StartupLease();
    private final Runnable poll = this::refresh;
    private final Runnable expire = () -> {
        if (!fresh()) { error = "Control status is stale. Runtime and device access are unverified."; notifyListeners(); }
    };

    HostController(Context context) {
        this.context = context.getApplicationContext();
        client = new ControlClient(this.context);
    }
    void add(Listener listener) { listeners.add(listener); }
    void remove(Listener listener) { listeners.remove(listener); }
    boolean fresh() { return state != null && SystemClock.elapsedRealtime() - receivedAt < 20000; }
    boolean verified() { return fresh() && error == null && !stopping; }
    void monitor(boolean enabled) {
        monitoring = enabled;
        main.removeCallbacks(poll);
        if (enabled && !busy) main.post(poll);
    }
    void refresh() { if (!busy) request("GET", "/v1/state", null); }
    void start() {
        if (busy) { pendingStart = true; return; }
        stopFailure = null;
        request("POST", "/v1/runtime/start", new JSONObject());
    }
    void stop() {
        stopEpoch++;
        stopRetries = 0;
        stopRetryDeadline = SystemClock.elapsedRealtime() + 6000;
        pendingStart = false;
        stopFailure = null;
        stopping = true;
        ChatWidget.clear(context);
        notifyListeners();
        if (busy) {
            // A stop must not disappear behind a slow start/poll. It is the next serialized command.
            pendingStop = true;
            return;
        }
        request("POST", "/v1/runtime/stop", new JSONObject());
    }
    boolean bootstrap(BootstrapCompletion completion) {
        if (busy || !verified() || !"ready".equals(state.runtime)) return false;
        long epoch = stopEpoch;
        busy = true;
        main.removeCallbacks(poll);
        notifyListeners();
        io.execute(() -> {
            UiBootstrap result = null;
            try { result = client.bootstrap(); }
            catch (ControlClient.Failure ignored) { /* Pairing errors are shown without response data. */ }
            UiBootstrap returned = result;
            main.post(() -> {
                busy = false;
                completion.complete(epoch == stopEpoch && !pendingStop && verified() ? returned : null);
                notifyListeners();
                nextRequest(false);
            });
        });
        return true;
    }
    private void nextRequest(boolean failed) {
        if (pendingStop) { pendingStop = false; pendingStart = false; stop(); }
        else if (pendingStart) { pendingStart = false; start(); }
        else if (monitoring) main.postDelayed(poll, failed ? 10000 : state != null && state.working() ? 3000 : 8000);
    }
    private boolean pendingStop, pendingStart;
    boolean hasPendingStop() { return pendingStop; }
    void readAccess(Completion completion) {
        if (busy || pendingStop) { completion.complete(null); return; }
        request("GET", "/v1/state", null, completion);
    }
    void policy(long revision, boolean full, boolean computer, Completion completion) {
        if (busy) {
            completion.complete(null);
            notice = "A control request is in progress. Review device access again after it completes.";
            notifyListeners();
            return;
        }
        if (state == null || (full && !"ready".equals(state.runtime)) || !state.canApplyPolicy(revision, verified(), full, computer)) {
            completion.complete(null);
            error = "Access review expired or requested capability is unavailable. Refresh and review again.";
            notifyListeners();
            refresh();
            return;
        }
        try {
            JSONObject body = new JSONObject().put("expectedRevision", revision)
                    .put("fullAccess", full).put("computerUse", computer);
            request("POST", "/v1/policy", body, applied -> completion.complete(
                    AccessProtocol.applied(applied, revision, full, computer) ? applied : null));
        } catch (org.json.JSONException e) { throw new IllegalStateException(e); }
    }
    private void request(String method, String path, JSONObject body) {
        request(method, path, body, state -> {});
    }
    private void request(String method, String path, JSONObject body, Completion completion) {
        long epoch = stopEpoch;
        busy = true;
        main.removeCallbacks(poll);
        notifyListeners();
        io.execute(() -> {
            HostState result = null;
            ControlClient.Failure failure = null;
            try { result = client.request(method, path, body); }
            catch (ControlClient.Failure e) { failure = e; }
            HostState returned = result;
            ControlClient.Failure failed = failure;
            main.post(() -> {
                busy = false;
                boolean stop = "/v1/runtime/stop".equals(path);
                state = returned;
                error = failed == null ? null : failed.getMessage();
                receivedAt = returned == null ? 0 : SystemClock.elapsedRealtime();
                main.removeCallbacks(expire);
                if (returned != null) main.postDelayed(expire, 20000);
                if (stop && epoch == stopEpoch && !pendingStop && !pendingStart
                        && failed != null && failed.transitionConflict && stopRetries < 3
                        && SystemClock.elapsedRealtime() + 1000 < stopRetryDeadline) {
                    // Only this pre-execution refusal is replayable. Keep the explicit Stop serialized.
                    stopRetries++;
                    busy = true;
                    main.postDelayed(() -> {
                        busy = false;
                        if (epoch != stopEpoch || pendingStop || pendingStart) {
                            if (!pendingStop) stopping = false;
                            nextRequest(false);
                        } else if (SystemClock.elapsedRealtime() >= stopRetryDeadline) {
                            stopping = false;
                            stopFailure = STOP_UNCONFIRMED;
                            notifyListeners();
                            nextRequest(true);
                        } else request(method, path, body, completion);
                    }, 1000);
                    notifyListeners();
                    return;
                }
                if (stop && epoch == stopEpoch && !pendingStop) {
                    stopping = false;
                    if (failed != null || returned == null || !"stopped".equals(returned.runtime))
                        stopFailure = STOP_UNCONFIRMED;
                }
                completion.complete(failed == null && epoch == stopEpoch && !pendingStop ? returned : null);
                notifyListeners();
                if (pendingStop) { pendingStop = false; pendingStart = false; stop(); }
                else if (pendingStart) { pendingStart = false; start(); }
                else if (failed != null && failed.conflict && "/v1/policy".equals(path)) {
                    // Refresh only; never retry a grant after a revision conflict.
                    String conflict = error;
                    refreshWithNotice = conflict;
                    refresh();
                } else {
                    if (refreshWithNotice != null && returned != null) {
                        notice = refreshWithNotice;
                        refreshWithNotice = null;
                        notifyListeners();
                    }
                    nextRequest(returned == null);
                }
            });
        });
    }
    String notice;
    private String refreshWithNotice;
    private void notifyListeners() { for (Listener listener : new HashSet<>(listeners)) listener.changed(); }
}
