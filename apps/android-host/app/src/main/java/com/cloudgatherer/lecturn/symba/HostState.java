package com.cloudgatherer.lecturn.symba;

import org.json.JSONException;
import org.json.JSONObject;
import java.util.List;
import java.util.Arrays;

final class HostState {
    final String runtime, message, uiUrl, activity, threadId, title, detail, taskUrl;
    final Integer completedSteps, totalSteps;
    final boolean hasWorkingTasks;
    final int workingCount;
    final long revision;
    final boolean fullAccess, computerUse, appDataCapable, computerUseCapable;

    private HostState(JSONObject root) throws JSONException {
        if (integer(root, "schemaVersion") != 1) throw new JSONException("Unsupported schema");
        JSONObject r = root.getJSONObject("runtime");
        runtime = enumeration(r, "status", Arrays.asList("stopped", "starting", "ready", "error"));
        message = string(r, "message");
        uiUrl = localUrl(root, "uiUrl");
        JSONObject a = root.getJSONObject("activity");
        activity = enumeration(a, "state", Arrays.asList("idle", "working", "waiting", "monitoring", "completed", "error", "stale"));
        // Older brokers omit both aggregate fields; their selected working thread is the only evidence.
        if (!a.has("hasWorkingTasks") && !a.has("workingCount")) {
            hasWorkingTasks = "working".equals(activity);
            workingCount = hasWorkingTasks ? 1 : 0;
        } else {
            hasWorkingTasks = bool(a, "hasWorkingTasks");
            long count = integer(a, "workingCount");
            if (count < 0 || count > Integer.MAX_VALUE || hasWorkingTasks != (count > 0))
                throw new JSONException("Invalid working aggregate");
            workingCount = (int) count;
        }
        threadId = nullableString(a, "threadId");
        title = string(a, "title");
        detail = string(a, "detail");
        taskUrl = localUrl(a, "taskUrl");
        completedSteps = nullableCount(a, "completedSteps");
        totalSteps = nullableCount(a, "totalSteps");
        if (completedSteps != null && totalSteps != null && completedSteps > totalSteps) throw new JSONException("Invalid progress");
        JSONObject p = root.getJSONObject("policy");
        revision = integer(p, "revision");
        if (revision < 0) throw new JSONException("Invalid revision");
        fullAccess = bool(p, "fullAccess");
        computerUse = bool(p, "computerUse");
        JSONObject c = root.getJSONObject("capabilities");
        appDataCapable = bool(c, "appData");
        computerUseCapable = bool(c, "computerUse");
    }

    static HostState parse(String json) throws JSONException { return new HostState(new JSONObject(json)); }
    boolean working() { return "ready".equals(runtime) && !"stale".equals(activity) && hasWorkingTasks; }
    boolean effectiveFullAccess() { return fullAccess && appDataCapable; }
    boolean effectiveComputerUse() { return effectiveFullAccess() && computerUse && computerUseCapable; }
    boolean allowsPolicy(boolean full, boolean computer) {
        return (!full || appDataCapable) && (!computer || (full && computerUseCapable));
    }
    boolean canApplyPolicy(long expectedRevision, boolean verified, boolean full, boolean computer) {
        return verified && revision == expectedRevision && allowsPolicy(full, computer);
    }
    String progress() {
        if (completedSteps == null) return "";
        return totalSteps == null ? completedSteps + " steps completed" : completedSteps + " / " + totalSteps + " steps";
    }
    private static String localUrl(JSONObject o, String k) throws JSONException {
        String v = nullableString(o, k);
        if (v != null && (!OriginPolicy.isStateUrl(v) || ("uiUrl".equals(k)
                && !v.equals(OriginPolicy.ORIGIN) && !v.equals(OriginPolicy.ORIGIN + "/")))) throw new JSONException("Untrusted UI origin");
        return v;
    }
    private static String enumeration(JSONObject o, String k, List<String> values) throws JSONException {
        String v = string(o, k);
        if (!values.contains(v)) throw new JSONException("Invalid state");
        return v;
    }
    private static String nullableString(JSONObject o, String k) throws JSONException {
        Object v = o.get(k);
        return v == JSONObject.NULL ? null : string(o, k);
    }
    private static String string(JSONObject o, String k) throws JSONException {
        Object v = o.get(k);
        if (!(v instanceof String) || ((String) v).length() > 8192) throw new JSONException("Invalid text");
        return (String) v;
    }
    private static boolean bool(JSONObject o, String k) throws JSONException {
        Object v = o.get(k);
        if (!(v instanceof Boolean)) throw new JSONException("Invalid boolean");
        return (Boolean) v;
    }
    private static long integer(JSONObject o, String k) throws JSONException {
        Object v = o.get(k);
        if (!(v instanceof Integer) && !(v instanceof Long)) throw new JSONException("Invalid integer");
        return ((Number) v).longValue();
    }
    private static Integer nullableCount(JSONObject o, String k) throws JSONException {
        if (o.get(k) == JSONObject.NULL) return null;
        long v = integer(o, k);
        if (v < 0 || v > Integer.MAX_VALUE) throw new JSONException("Invalid count");
        return (int) v;
    }
}
