package com.cloudgatherer.lecturn.symba;

import org.json.JSONException;
import org.json.JSONObject;

/** Only capability state crosses into the page, never control credentials or policy methods. */
final class AccessProtocol {
    static boolean acceptsSource(boolean resumed, boolean mainFrame, String origin, String pageUrl) {
        return resumed && mainFrame && OriginPolicy.ORIGIN.equals(origin) && OriginPolicy.isUi(pageUrl);
    }
    static boolean applied(HostState state, long reviewedRevision, boolean full, boolean computer) {
        return state != null && state.revision > reviewedRevision && state.fullAccess == full
                && state.computerUse == computer && state.allowsPolicy(full, computer);
    }
    static JSONObject state(HostState state) {
        boolean verified = state != null && "ready".equals(state.runtime);
        try {
            return new JSONObject().put("verified", verified)
                    .put("revision", verified ? state.revision : JSONObject.NULL)
                    .put("fullAccess", verified && state.effectiveFullAccess())
                    .put("computerUse", verified && state.effectiveComputerUse())
                    .put("capabilities", new JSONObject()
                            .put("appData", verified && state.appDataCapable)
                            .put("computerUse", verified && state.computerUseCapable));
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }
    static boolean validId(Object id) {
        return id instanceof String && ((String) id).matches("[a-zA-Z0-9_-]{1,96}");
    }
}
