package com.cloudgatherer.lecturn.symba;

import java.time.Instant;
import org.json.JSONException;
import org.json.JSONObject;

final class UiBootstrap {
    final String pairingUrl;
    final Instant expiresAt;
    private UiBootstrap(String pairingUrl, Instant expiresAt) {
        this.pairingUrl = pairingUrl; this.expiresAt = expiresAt;
    }
    String navigationUrl() {
        // A fragment-only load on /pair is same-document: the existing React
        // pairing form has already read its initial token. Force a fresh document
        // using a non-secret nonce, keeping the credential only in the fragment.
        return pairingUrl.replace("/pair#", "/pair?native=" + java.util.UUID.randomUUID() + "#");
    }
    static UiBootstrap parse(String json, Instant now) throws JSONException {
        JSONObject value = new JSONObject(json);
        Object url = value.opt("pairingUrl"), expiry = value.opt("expiresAt");
        if (!Integer.valueOf(1).equals(value.opt("schemaVersion")) || value.length() != 3
                || !(url instanceof String) || !(expiry instanceof String)
                || !OriginPolicy.isUi((String) url)
                || !((String) url).matches("http://127\\.0\\.0\\.1:3773/pair#token=[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}"))
            throw new JSONException("Invalid pairing response");
        try {
            Instant expiresAt = Instant.parse((String) expiry);
            if (!expiresAt.isAfter(now)) throw new IllegalArgumentException();
            return new UiBootstrap((String) url, expiresAt);
        } catch (RuntimeException e) { throw new JSONException("Invalid pairing expiry"); }
    }
}
