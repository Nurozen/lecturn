package com.cloudgatherer.lecturn.symba;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;

final class BlobDownloads {
    static final int SAVE_BLOB = 4;
    private static final int MAX_BYTES = 16 * 1024 * 1024;
    private final Activity activity;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private String id;
    private boolean closed;
    private final Runnable timeout = () -> finish("Export timed out. Try again.");

    BlobDownloads(Activity activity, WebView web, BooleanSupplier active) {
        this.activity = activity; this.web = web;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "__lecturnDownload", Collections.singleton(OriginPolicy.ORIGIN), (v, message, origin, mainFrame, reply) -> {
                if (!active.getAsBoolean() || !mainFrame || !OriginPolicy.ORIGIN.equals(origin.toString())
                        || !OriginPolicy.isUi(v.getUrl()) || message.getType() != androidx.webkit.WebMessageCompat.TYPE_STRING) return;
                if ("ready".equals(message.getData()) && id == null) chooseDestination();
                else if ("failed".equals(message.getData())) toast("Export unavailable or exceeds the 16 MiB export limit.");
            });
            // Fullweb exports use short-lived blob URLs. Capture before their click handler revokes them.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, """
                    if(window===window.top){
                      document.addEventListener('click',function(event){
                        const anchor=event.target.closest&&event.target.closest('a[download]');
                        if(!anchor||!anchor.href.startsWith('blob:http://127.0.0.1:3773/'))return;
                        event.preventDefault();
                        if(window.__lecturnExport)return;
                        window.__lecturnExport={id:crypto.randomUUID(),data:null};
                        fetch(anchor.href).then(r=>r.blob()).then(async blob=>{
                          if(blob.size>16777216)throw Error();
                          window.__lecturnExport.data=new Uint8Array(await blob.arrayBuffer());
                          window.__lecturnDownload.postMessage('ready');
                        }).catch(()=>{window.__lecturnExport=null;window.__lecturnDownload.postMessage('failed');});
                      },true);
                    }
                    """, Collections.singleton(OriginPolicy.ORIGIN));
            }
        }
    }
    private void chooseDestination() {
        web.evaluateJavascript("window.__lecturnExport?window.__lecturnExport.id:null", value -> {
            if (closed || id != null) return;
            try {
                Object parsed = new org.json.JSONTokener(value).nextValue();
                if (!(parsed instanceof String) || !((String) parsed).matches("[a-fA-F0-9-]{36}")) return;
                id = (String) parsed;
                activity.startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, "lecturn-export"), SAVE_BLOB);
            } catch (org.json.JSONException | ActivityNotFoundException e) { finish("No document picker available."); }
        });
    }
    void result(int result, Intent data) {
        if (id == null) return;
        Uri destination = data == null ? null : data.getData();
        if (result != Activity.RESULT_OK || destination == null || !"content".equals(destination.getScheme())) { finish(null); return; }
        main.postDelayed(timeout, 120000);
        readChunk(destination, new ByteArrayOutputStream(), 0);
    }
    private void readChunk(Uri destination, ByteArrayOutputStream bytes, int offset) {
        if (closed || id == null || !OriginPolicy.isUi(web.getUrl())) { finish("Export interrupted. Try again."); return; }
        String requestId = id;
        String script = "(function(){const e=window.__lecturnExport;if(!e||e.id!==" + JSONObject.quote(id)
                + "||!e.data)return null;const chunk=e.data.subarray(" + offset + "," + (offset + 32768)
                + ");return {length:e.data.length,chunk:btoa(String.fromCharCode.apply(null,chunk))};})()";
        web.evaluateJavascript(script, result -> {
            if (closed || !requestId.equals(id)) return;
            try {
                JSONObject chunk = new JSONObject(result);
                int length = chunk.getInt("length");
                if (length < 0 || length > MAX_BYTES || length < offset) throw new IllegalArgumentException();
                byte[] decoded = Base64.decode(chunk.getString("chunk"), Base64.NO_WRAP);
                if (decoded.length != Math.min(32768, length - offset)) throw new IllegalArgumentException();
                bytes.write(decoded, 0, decoded.length);
                int next = offset + decoded.length;
                if (next < length) { readChunk(destination, bytes, next); return; }
                byte[] complete = bytes.toByteArray();
                var resolver = activity.getApplicationContext().getContentResolver();
                finish(null);
                io.execute(() -> {
                    boolean success;
                    try (var out = resolver.openOutputStream(destination, "wt")) {
                        if (out == null) throw new IllegalStateException();
                        out.write(complete); success = true;
                    } catch (Exception e) { success = false; }
                    boolean saved = success;
                    main.post(() -> { if (!closed) toast(saved ? "Export saved." : "Export failed. The selected document may be incomplete."); });
                });
            } catch (Exception e) { finish("Export interrupted. Try again."); }
        });
    }
    private void finish(String message) {
        main.removeCallbacks(timeout);
        id = null;
        if (!closed && OriginPolicy.isUi(web.getUrl())) web.evaluateJavascript("window.__lecturnExport=null", null);
        if (message != null && !closed) toast(message);
    }
    void close() { closed = true; id = null; main.removeCallbacks(timeout); io.shutdown(); }
    private void toast(String text) { Toast.makeText(activity, text, Toast.LENGTH_LONG).show(); }
}
