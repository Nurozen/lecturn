package com.cloudgatherer.lecturn.symba;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity implements HostController.Listener {
    private static final int FILES = 1, SAVE = 2, NOTIFICATIONS = 3;
    private HostController host;
    private WebView web;
    private BlobDownloads blobDownloads;
    private HostSurface surface;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingDownload, downloadCookie;
    private String lastUiUrl, widgetThreadUrl;
    static final String FLOAT_CHAT = "com.cloudgatherer.lecturn.symba.FLOAT_CHAT";
    static final String COMPOSE = "com.cloudgatherer.lecturn.symba.COMPOSE";
    private boolean openTask, resumed, bridgeAvailable, floatRequested, composeRequested;
    private FloatingChatWindow floating;
    private boolean unlocked() {
        return getSystemService(PowerManager.class).isInteractive()
                && !getSystemService(android.app.KeyguardManager.class).isKeyguardLocked();
    }
    private boolean interactive() {
        return web != null && unlocked()
                && (floating != null ? floating.interactive() : resumed);
    }
    private final UiPairing pairing = new UiPairing();
    private final UiSessionClient sessions = new UiSessionClient();
    private final ExecutorService pairingIo = Executors.newSingleThreadExecutor();
    private boolean sessionBusy, sessionNeeded = true;
    private long pageEpoch;
    private int widgetRequests;
    private long widgetPublication;
    private boolean widgetHostReady;
    private final android.content.BroadcastReceiver widgetScreen = new android.content.BroadcastReceiver() {
        @Override public void onReceive(android.content.Context context, Intent intent) {
            updateWidgetVisibility();
        }
    };
    // Widget text may advance on Home. This does not authorize interactive bridge actions.
    private boolean widgetAllowed() {
        return !isDestroyed() && web != null && unlocked() && bridgeAvailable
                && host.verified() && !host.stopping && host.state != null && "ready".equals(host.state.runtime);
    }
    private void clearWidget() { widgetPublication++; ChatWidget.clear(this); }
    void updateWidgetVisibility() {
        if (web == null) return;
        if (unlocked()) {
            web.onResume();
            refreshChatWidget();
        } else {
            clearWidget();
            web.onPause();
        }
    }
    private void refreshChatWidget() {
        if (widgetAllowed() && OriginPolicy.chatStateUrl(web.getUrl()) != null)
            web.evaluateJavascript("window.dispatchEvent(new Event('lecturn:chat-visible'))", null);
    }
    void publishChatWidget(WebView view, Object payload, boolean mainFrame, String origin,
            java.util.function.Consumer<Boolean> acknowledge) {
        if (view != web || !AccessProtocol.acceptsDocument(mainFrame, origin, view.getUrl())) {
            acknowledge.accept(false); return;
        }
        if (payload == null || payload == JSONObject.NULL) {
            clearWidget(); acknowledge.accept(true); return;
        }
        String pageUrl = OriginPolicy.chatStateUrl(view.getUrl());
        if (!widgetAllowed() || pageUrl == null || widgetRequests >= 2) { acknowledge.accept(false); return; }
        long epoch = pageEpoch, publication = ++widgetPublication;
        String cookie = CookieManager.getInstance().getCookie(OriginPolicy.ORIGIN);
        widgetRequests++;
        pairingIo.execute(() -> {
            boolean authenticated = false;
            try { authenticated = sessions.authenticated(cookie); }
            catch (Exception ignored) { /* No publication without a verified session. */ }
            boolean verified = authenticated;
            main.post(() -> {
                widgetRequests--;
                boolean pending = epoch == pageEpoch && publication == widgetPublication && view == web;
                boolean current = pending && pageUrl.equals(OriginPolicy.chatStateUrl(view.getUrl()))
                        && java.util.Objects.equals(cookie, CookieManager.getInstance().getCookie(OriginPolicy.ORIGIN));
                if (pending && (!current || !verified || !widgetAllowed())) clearWidget();
                acknowledge.accept(current && verified && widgetAllowed() && ChatWidget.publish(this, payload, pageUrl));
            });
        });
    }
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable checkPairing = this::checkPairing;
    private final Runnable expirePairing = () -> {
        if (pairing.expired(android.os.SystemClock.elapsedRealtime())) {
            cancelPairing("Pairing expired or did not complete. Use More → Retry pairing.");
            changed();
        }
    };
    private final AccessRequests accessRequests = new AccessRequests();
    private AccessRequests.Pending accessReview;
    private void clearAccessRequests() {
        accessRequests.drain(); accessReview = null; accessDialog.close();
    }
    private final DeviceAccessDialog accessDialog = new DeviceAccessDialog();
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (saved != null && saved.getBoolean("pairingAttempted")) {
            pairing.attempted = true;
        }
        if (Build.VERSION.SDK_INT >= 31) getWindow().setHideOverlayWindows(true);
        host = ((HostApplication) getApplication()).controller;
        openTask = RuntimeService.OPEN_TASK.equals(getIntent().getAction());
        floatRequested = FLOAT_CHAT.equals(getIntent().getAction()) || COMPOSE.equals(getIntent().getAction());
        composeRequested = COMPOSE.equals(getIntent().getAction());
        widgetThreadUrl = widgetUrl(getIntent());
        surface = new HostSurface(this);
        surface.actions(v -> requestStart(), v -> requestStop(),
                v -> accessDialog.show(this, host, null), v -> more());
        surface.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                var edges = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(edges.left, edges.top, edges.right, edges.bottom);
            } else v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        web = new WebView(this); web.setBackgroundColor(Color.rgb(18, 39, 53));
        configureWebView();
        android.content.IntentFilter screen = new android.content.IntentFilter(Intent.ACTION_SCREEN_OFF);
        screen.addAction(Intent.ACTION_SCREEN_ON); screen.addAction(Intent.ACTION_USER_PRESENT);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(widgetScreen, screen, RECEIVER_NOT_EXPORTED);
        else registerReceiver(widgetScreen, screen);
        blobDownloads = new BlobDownloads(this, web, this::interactive);
        surface.content.addView(web, 0, new android.widget.FrameLayout.LayoutParams(-1, -1));
        setContentView(surface);
        if (saved != null && saved.getBundle("webState") != null
                && web.restoreState(saved.getBundle("webState")) != null)
            lastUiUrl = saved.getString("lastUiUrl", OriginPolicy.ORIGIN);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
    }

    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (OriginPolicy.isUi(url)) return false;
                if (request.isForMainFrame() && (request.hasGesture() || request.isRedirect())) external(url);
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (OriginPolicy.isUi(request.getUrl().toString())) return null;
                if (OriginPolicy.isConnectRequest(request.getUrl().toString(), request.isForMainFrame(), request.getRequestHeaders())) return null;
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked origin", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                clearAccessRequests();
                clearWidget();
                pageEpoch++; sessionBusy = false; sessionNeeded = true; pairing.authenticated = false;
                main.removeCallbacks(checkPairing);
                if (!OriginPolicy.isUi(url)) { view.stopLoading(); toast("Navigation blocked."); }
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (OriginPolicy.isUi(url)) { sessionNeeded = true; checkPairing(); }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    cancelPairing("Lecturn page unavailable. Use More → Retry pairing.");
                    clearAccessRequests(); changed(); surface.status.setText(R.string.page_unavailable);
                }
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (request.isForMainFrame()) {
                    cancelPairing("Lecturn page failed to load. Use More → Retry pairing.");
                    clearAccessRequests(); changed(); surface.status.setText(R.string.page_error);
                }
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                if (floating != null) floating.close();
                cancelPairing("Web page stopped. Reopen Lecturn and retry pairing.");
                clearAccessRequests();
                blobDownloads.close();
                ((android.view.ViewGroup) view.getParent()).removeView(view); view.destroy(); web = null;
                changed(); toast("Web page stopped. Reopen Lecturn to reconnect."); return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message) { return true; }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!OriginPolicy.isUi(view.getUrl())) return false;
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                String[] types = java.util.Arrays.stream(params.getAcceptTypes()).filter(t -> t.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.*+-]+")).toArray(String[]::new);
                if (types.length > 0) pick.putExtra(Intent.EXTRA_MIME_TYPES, types);
                try { startActivityForResult(pick, FILES); }
                catch (ActivityNotFoundException e) { fileCallback.onReceiveValue(null); fileCallback = null; toast("No file picker available."); }
                return true;
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message message) {
                if (!gesture || !OriginPolicy.isUi(view.getUrl())) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.getSettings().setAllowFileAccess(false); popup.getSettings().setAllowContentAccess(false);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                        String url = r.getUrl().toString();
                        if (OriginPolicy.isUi(url)) web.loadUrl(url); else external(url);
                        popup.destroy(); return true;
                    }
                    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    }
                });
                ((WebView.WebViewTransport) message.obj).setWebView(popup); message.sendToTarget();
                return true;
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, length) -> {
            if (OriginPolicy.isExternal(url)) { external(url); return; }
            if (!OriginPolicy.isUi(url) || pendingDownload != null) { toast("This download is unavailable."); return; }
            pendingDownload = url; downloadCookie = CookieManager.getInstance().getCookie(url);
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mime != null && mime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+") ? mime : "application/octet-stream")
                    .putExtra(Intent.EXTRA_TITLE, "lecturn-download");
            try { startActivityForResult(save, SAVE); }
            catch (ActivityNotFoundException e) { pendingDownload = null; downloadCookie = null; toast("No document picker available."); }
        });
        bridgeAvailable = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "__lecturnNative", Collections.singleton(OriginPolicy.ORIGIN), (view, message, origin, mainFrame, reply) -> {
                if (!AccessProtocol.acceptsDocument(mainFrame, origin.toString(), view.getUrl())) return;
                if (message.getType() != androidx.webkit.WebMessageCompat.TYPE_STRING) return;
                String data = message.getData();
                if (data == null || data.length() > 24000) return;
                try {
                    JSONObject request = new JSONObject(data);
                    if (!Integer.valueOf(2).equals(request.opt("protocolVersion")) || !AccessProtocol.validId(request.opt("requestId"))) return;
                    String id = request.getString("requestId");
                    String method = request.optString("method");
                    if ("publishChatWidget".equals(method)) {
                        publishChatWidget(view, request.opt("payload"), mainFrame, origin.toString(), published -> {
                            try { reply.postMessage(new JSONObject().put("protocolVersion", 2).put("requestId", id)
                                    .put("state", new JSONObject().put("published", published)).toString()); }
                            catch (org.json.JSONException | IllegalStateException ignored) { /* Departed document. */ }
                        });
                        return;
                    }
                    if (!AccessProtocol.acceptsSource(interactive(), mainFrame, origin.toString(), view.getUrl())) return;
                    if (data.length() > 1024) return;
                    AccessRequests.Pending pending = accessRequests.add(id, state -> {
                        try {
                            reply.postMessage(new JSONObject().put("protocolVersion", 2).put("requestId", id)
                                    .put("state", AccessProtocol.state(state)).toString());
                        } catch (org.json.JSONException | IllegalStateException ignored) { /* Departed document. */ }
                    });
                    if (pending == null) return; // Duplicate IDs cannot cancel or replace another request.
                    Runnable timeout = () -> {
                        if (!pending.active()) return;
                        pending.finish(null);
                        if (accessReview == pending) { accessReview = null; accessDialog.close(); }
                    };
                    pending.cleanup = () -> main.removeCallbacks(timeout);
                    main.postDelayed(timeout, 85000);
                    if ("getAccessState".equals(method)) {
                        host.readAccess(pending::finish);
                    } else if ("requestFullAccess".equals(method) || "openDeviceAccess".equals(method)) {
                        Object thread = request.opt("threadId");
                        boolean full = "requestFullAccess".equals(method);
                        if (accessReview != null || (full && (!(thread instanceof String)
                                || ((String) thread).length() > 256 || ((String) thread).trim().isEmpty()))) {
                            pending.finish(null); return;
                        }
                        accessReview = pending;
                        host.readAccess(state -> {
                            if (!pending.active()) return;
                            if (state == null || !"ready".equals(state.runtime)) {
                                accessReview = null; pending.finish(null); return;
                            }
                            if (full && state.effectiveFullAccess()) {
                                accessReview = null; pending.finish(state); return;
                            }
                            if (!resumed) {
                                // Native grant review belongs to a foreground Activity. Retry there.
                                accessReview = null; pending.finish(null); openFromFloating();
                                toast("Review device access in Lecturn, then retry your action."); return;
                            }
                            accessDialog.show(this, host, full ? ((String) thread).replaceAll("[\\p{Cntrl}]", "") : null, applied -> {
                                if (accessReview == pending) accessReview = null;
                                pending.finish(applied);
                            });
                        });
                    } else pending.finish(null);
                } catch (org.json.JSONException ignored) { /* Malformed bridge requests have no effect. */ }
            });
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                try (var script = getAssets().open("android-host-access.js")) {
                    java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
                    byte[] buffer = new byte[4096];
                    int count;
                    while ((count = script.read(buffer)) != -1) bytes.write(buffer, 0, count);
                    WebViewCompat.addDocumentStartJavaScript(web,
                            bytes.toString(java.nio.charset.StandardCharsets.UTF_8.name()),
                            Collections.singleton(OriginPolicy.ORIGIN));
                } catch (java.io.IOException e) { throw new IllegalStateException("Missing host bridge", e); }
            }
        }
    }

    private void requestStart() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATIONS); return;
        }
        if (!getSystemService(NotificationManager.class).areNotificationsEnabled()) {
            toast("Enable Lecturn notifications before starting so Stop stays visible.");
            startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())); return;
        }
        var channel = getSystemService(NotificationManager.class).getNotificationChannel("local-runtime");
        if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) {
            toast("Enable the local runtime notification channel before starting.");
            startActivity(new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()).putExtra(Settings.EXTRA_CHANNEL_ID, "local-runtime")); return;
        }
        startForegroundService(new Intent(this, RuntimeService.class).setAction(RuntimeService.START));
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == NOTIFICATIONS && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) requestStart();
        else if (request == NOTIFICATIONS) toast("Runtime not started. Notifications are needed for a visible Stop control.");
    }
    private void requestStop() {
        ChatWidget.clear(this);
        cancelPairing("Runtime stopped. Use More → Retry pairing after restarting.");
        clearAccessRequests();
        if (host.monitoring) startService(new Intent(this, RuntimeService.class).setAction(RuntimeService.STOP));
        else host.stop();
    }
    private void more() {
        new AlertDialog.Builder(this).setTitle("Lecturn on this phone")
                .setItems(new String[]{"Refresh runtime status", "Reload Lecturn", Settings.canDrawOverlays(this) ? "Overlay permission: on" : "Enable activity overlay", "About device access", "Retry pairing", host.monitoring ? "Check background runtime" : "Keep running", "Stop Lecturn", "Set up agents", ignoringBatteryOptimizations() ? "Background battery: exempt" : "Background battery: optimized", "Float chat"}, (d, which) -> {
                    if (which == 9) { floatRequested = true; changed(); }
                    if (which == 0) host.refresh();
                    if (which == 5) { if (host.monitoring) host.refresh(); else requestStart(); }
                    if (which == 6) requestStop();
                    if (which == 8) backgroundBattery();
                    if (which == 7) {
                        if (web != null && host.verified() && "ready".equals(host.state.runtime)
                                && host.state.uiUrl != null) web.loadUrl(host.state.uiUrl + "/welcome");
                        else toast("Start Lecturn before setting up agents.");
                    }
                    if (which == 1 && web != null && host.verified() && host.state.uiUrl != null) web.loadUrl(host.state.uiUrl);
                    if (which == 2) {
                        try { startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))); }
                        catch (ActivityNotFoundException e) { toast("Overlay permission settings are unavailable."); }
                    }
                    if (which == 4) {
                        pageEpoch++; sessionBusy = false; sessionNeeded = true; pairing.retry();
                        if (web != null && host.verified() && host.state.uiUrl != null) web.loadUrl(host.state.uiUrl);
                        else toast("Start the local runtime before retrying pairing.");
                        changed();
                    }
                    if (which == 3) new AlertDialog.Builder(this).setTitle("Device access")
                            .setMessage(R.string.access_risks)
                            .setPositiveButton("Close", null).show();
                }).show();
    }
    private boolean ignoringBatteryOptimizations() {
        return getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
    }
    private void backgroundBattery() {
        boolean exempt = ignoringBatteryOptimizations();
        new AlertDialog.Builder(this).setTitle("Background battery")
                .setMessage((exempt
                        ? "Lecturn is exempt from battery optimization. The Lecturn host can use network and CPU wake locks during Android Doze. Other system limits still apply; uninterrupted execution is not guaranteed."
                        : "Battery optimization is on. Android may pause background network and CPU work during Doze with the screen off. You can ask Android to exempt Lecturn for background agent work. This may use more battery; other system limits still apply.")
                        + "\n\nThis choice is optional. It does not start or stop agents or change device access. You can change it later in Android battery settings.")
                .setNegativeButton(exempt ? "Close" : "Not now", null)
                .setPositiveButton(exempt ? "Battery settings" : "Continue to Android", (d, which) -> {
                    // Re-read: only Android's current exemption state determines the request.
                    if (!ignoringBatteryOptimizations()) {
                        try {
                            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                    Uri.parse("package:" + getPackageName())));
                            return;
                        } catch (ActivityNotFoundException | SecurityException ignored) { /* Try the system list. */ }
                    }
                    try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
                    catch (ActivityNotFoundException | SecurityException e) {
                        toast("Battery settings unavailable. Open Android Settings → Apps → Lecturn → Battery.");
                    }
                }).show();
    }
    private void external(String url) {
        if (!OriginPolicy.isExternal(url)) { toast("Only local Lecturn pages and external HTTPS links are allowed."); return; }
        if (floating != null) floating.minimize(true);
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException e) { toast("No browser available."); }
    }
    @Override public void changed() {
        HostState state = host.state;
        if (floating != null) floating.working(host.verified() && state != null && state.working());
        boolean ready = host.verified() && !host.stopping && state != null && "ready".equals(state.runtime);
        if (!ready) clearWidget();
        else if (!widgetHostReady) refreshChatWidget();
        widgetHostReady = ready;
        if (host.stopping && floating != null) floating.close();
        if (host.stopping) cancelPairing("Runtime stopping. Retry pairing after restarting.");
        surface.render(host, web != null && lastUiUrl != null, bridgeAvailable, pairing);
        if (host.stopping || (!host.busy && !host.verified()) || (state != null && !"ready".equals(state.runtime))) clearAccessRequests();
        if (!host.verified()) return;
        if (host.notice != null) { toast(host.notice); host.notice = null; }
        if (!bridgeAvailable) return;
        if (!interactive()) return;
        if (web != null && "ready".equals(state.runtime) && state.uiUrl != null && !state.uiUrl.equals(lastUiUrl)) {
            lastUiUrl = state.uiUrl; web.loadUrl(state.uiUrl);
            surface.render(host, true, bridgeAvailable, pairing);
        }
        if (sessionNeeded) checkPairing();
        if (widgetThreadUrl != null && pairing.authenticated && !sessionNeeded && web != null && web.getProgress() == 100) {
            String target = widgetThreadUrl; widgetThreadUrl = null;
            if (!target.equals(web.getUrl())) { web.loadUrl(target); return; }
        }
        if (floatRequested && widgetThreadUrl == null && pairing.authenticated && !sessionNeeded
                && web != null && web.getProgress() == 100) showFloating();
        if (composeRequested && pairing.authenticated && !sessionNeeded && web != null && web.getProgress() == 100) {
            composeRequested = false;
            web.evaluateJavascript("window.__lecturnComposeRequested=true;window.dispatchEvent(new Event('lecturn:compose'))", null);
        }
        if (openTask && pairing.authenticated && !sessionNeeded && web != null
                && "ready".equals(state.runtime) && state.taskUrl != null && web.getProgress() == 100) {
            openTask = false;
            if (!state.taskUrl.equals(web.getUrl())) web.loadUrl(state.taskUrl);
        }
    }
    private void cancelPairing(String message) {
        clearWidget();
        pageEpoch++; sessionBusy = false; sessionNeeded = false;
        main.removeCallbacks(checkPairing);
        main.removeCallbacks(expirePairing);
        pairing.fail(message);
    }
    private void checkPairing() {
        main.removeCallbacks(checkPairing);
        if (!interactive() || web == null || sessionBusy || !sessionNeeded || !bridgeAvailable
                || !host.verified() || !"ready".equals(host.state.runtime)
                || web.getProgress() < 100 || !OriginPolicy.isUi(web.getUrl())) return;
        long epoch = pageEpoch;
        sessionBusy = true;
        String cookie = CookieManager.getInstance().getCookie(OriginPolicy.ORIGIN);
        pairingIo.execute(() -> {
            Boolean authenticated = null;
            try { authenticated = sessions.authenticated(cookie); }
            catch (Exception ignored) { /* Never display cookie or transport exception data. */ }
            Boolean result = authenticated;
            main.post(() -> {
                if (isDestroyed() || !interactive() || epoch != pageEpoch) return;
                sessionBusy = false;
                if (!host.verified() || !"ready".equals(host.state.runtime)) return;
                if (Boolean.TRUE.equals(result)) {
                    boolean completedBootstrap = pairing.confirm(); sessionNeeded = false;
                    if (completedBootstrap) web.clearHistory();
                    changed();
                    if (epoch == pageEpoch) refreshChatWidget();
                } else if (result == null) {
                    pairing.fail("Lecturn session unavailable. Use More → Retry pairing.");
                    sessionNeeded = false; changed();
                } else if (pairing.waiting && !pairing.expired(android.os.SystemClock.elapsedRealtime())) {
                    main.postDelayed(checkPairing, 1000);
                } else if (pairing.waiting || pairing.attempted || pairing.error != null) {
                    pairing.fail("Pairing expired, was consumed, or did not complete. Use More → Retry pairing.");
                    sessionNeeded = false; changed();
                } else if (host.busy) {
                    main.postDelayed(checkPairing, 500);
                } else if (pairing.begin()) {
                    sessionBusy = true;
                    boolean accepted = host.bootstrap(bootstrap -> {
                        if (isDestroyed() || !interactive() || epoch != pageEpoch) return;
                        sessionBusy = false;
                        long remaining = bootstrap == null ? 0 : java.time.Duration.between(
                                java.time.Instant.now(), bootstrap.expiresAt).toMillis();
                        if (remaining <= 0 || !host.verified() || !OriginPolicy.isUi(web.getUrl())) {
                            pairing.fail("Pairing unavailable or expired. Use More → Retry pairing.");
                            sessionNeeded = false;
                        } else {
                            pairing.await(android.os.SystemClock.elapsedRealtime(), remaining);
                            main.removeCallbacks(expirePairing);
                            main.postDelayed(expirePairing, Math.min(30000, remaining));
                            web.loadUrl(bootstrap.navigationUrl());
                            main.postDelayed(checkPairing, 1000);
                        }
                        changed();
                    });
                    if (!accepted) {
                        sessionBusy = false; sessionNeeded = false;
                        pairing.fail("Runtime unavailable. Use More → Retry pairing."); changed();
                    }
                }
            });
        });
    }
    @Override protected void onResume() {
        super.onResume(); resumed = true; sessionNeeded = true;
        if (floating != null) floating.close();
        if (web != null) web.onResume(); host.add(this); changed(); host.refresh(); refreshChatWidget();
    }
    @Override protected void onPause() {
        resumed = false;
        if (!unlocked()) clearWidget();
        if (floating == null) {
            pageEpoch++; sessionBusy = false;
            // Keep this trusted document receiving chat updates while Home is visible.
            // The interaction epoch still cancels pending foreground work.
            if (web != null) { if (unlocked()) web.onResume(); else web.onPause(); }
            main.removeCallbacks(checkPairing);
            clearAccessRequests();
        }
        super.onPause();
    }
    @Override protected void onSaveInstanceState(Bundle saved) {
        saved.putBoolean("pairingAttempted", pairing.attempted);
        if (web != null && pairing.authenticated) {
            var history = web.copyBackForwardList();
            boolean safe = history.getSize() > 0;
            for (int i = 0; i < history.getSize(); i++) safe &= OriginPolicy.isStateUrl(history.getItemAtIndex(i).getUrl());
            if (safe) {
                Bundle state = new Bundle();
                web.saveState(state); saved.putBundle("webState", state);
                saved.putString("lastUiUrl", lastUiUrl);
            }
        }
        super.onSaveInstanceState(saved);
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        openTask = RuntimeService.OPEN_TASK.equals(intent.getAction());
        floatRequested = FLOAT_CHAT.equals(intent.getAction()) || COMPOSE.equals(intent.getAction());
        composeRequested = COMPOSE.equals(intent.getAction());
        widgetThreadUrl = widgetUrl(intent);
        sessionNeeded = true;
    }
    private static String widgetUrl(Intent intent) {
        String url = intent.getStringExtra("widget_thread_url");
        return OriginPolicy.isStateUrl(url) ? url : null;
    }
    private void goBack() {
        if (web == null || !OriginPolicy.isUi(web.getUrl())) { moveTaskToBack(true); return; }
        long epoch = pageEpoch;
        web.evaluateJavascript("window.dispatchEvent(new Event('lecturn:native-back', {cancelable:true}))", result -> {
            if (isDestroyed() || epoch != pageEpoch || !interactive()) return;
            if ("false".equals(result)) return;
            if (floating != null) floating.minimize(true);
            else if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }
    private void showFloating() {
        floatRequested = false;
        if (!Settings.canDrawOverlays(this)) { toast("Enable the activity overlay in More first."); return; }
        if (floating != null || web == null || !resumed) return;
        if (Build.VERSION.SDK_INT >= 31) getWindow().setHideOverlayWindows(false);
        ((android.view.ViewGroup) web.getParent()).removeView(web);
        floating = new FloatingChatWindow(this, web, this::openFromFloating, this::goBack, active -> {
            if (!active) {
                pageEpoch++; sessionBusy = false; clearAccessRequests(); main.removeCallbacks(checkPairing);
                updateWidgetVisibility();
            } else {
                sessionNeeded = true; changed();
                refreshChatWidget();
            }
        }, () -> {
            floating = null;
            ((HostApplication) getApplication()).floatingChat = false;
            if (web != null) {
                var parent = (android.view.ViewGroup) web.getParent();
                if (parent != null) parent.removeView(web);
                surface.content.addView(web, 0, new android.widget.FrameLayout.LayoutParams(-1, -1));
                if (!resumed) { if (unlocked()) web.onResume(); else web.onPause(); }
            }
            if (!resumed) clearAccessRequests();
            if (Build.VERSION.SDK_INT >= 31) getWindow().setHideOverlayWindows(true);
        });
        ((HostApplication) getApplication()).floatingChat = true;
        if (floating.show()) moveTaskToBack(true);
        else { floating.close(); toast("Floating chat unavailable. Check overlay permission."); }
    }
    private void openFromFloating() {
        if (floating != null) floating.close();
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
    }
    @Override public void onBackPressed() { goBack(); }
    @Override protected void onDestroy() {
        unregisterReceiver(widgetScreen);
        host.remove(this);
        clearWidget();
        if (floating != null) floating.close();
        clearAccessRequests();
        main.removeCallbacks(checkPairing);
        main.removeCallbacks(expirePairing);
        accessDialog.close();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        blobDownloads.close();
        if (web != null) { web.stopLoading(); web.destroy(); }
        downloads.shutdown();
        pairingIo.shutdownNow();
        pendingDownload = null; downloadCookie = null;
        super.onDestroy();
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == BlobDownloads.SAVE_BLOB) blobDownloads.result(result, data);
        if (request == FILES && fileCallback != null) {
            ArrayList<Uri> selected = new ArrayList<>();
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) for (int i = 0; i < Math.min(32, data.getClipData().getItemCount()); i++) selected.add(data.getClipData().getItemAt(i).getUri());
                else if (data.getData() != null) selected.add(data.getData());
            }
            selected.removeIf(uri -> uri == null || !"content".equals(uri.getScheme()));
            fileCallback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0])); fileCallback = null;
        }
        if (request == SAVE) {
            String source = pendingDownload, cookie = downloadCookie; pendingDownload = null; downloadCookie = null;
            Uri destination = data == null ? null : data.getData();
            if (result == RESULT_OK && source != null && destination != null && "content".equals(destination.getScheme())) {
                var resolver = getApplicationContext().getContentResolver();
                downloads.execute(() -> {
                    boolean success;
                    try { PrivateDownload.save(resolver, destination, source, cookie); success = true; }
                    catch (Exception e) { success = false; }
                    boolean saved = success;
                    runOnUiThread(() -> { if (!isDestroyed()) toast(saved ? "Download saved." : "Download failed. The selected document may be incomplete."); });
                });
            }
        }
    }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
}
