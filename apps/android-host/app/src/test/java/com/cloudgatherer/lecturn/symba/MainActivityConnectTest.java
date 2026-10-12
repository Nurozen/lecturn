package com.cloudgatherer.lecturn.symba;

import android.app.KeyguardManager;
import android.content.Intent;
import android.os.Handler;
import android.os.PowerManager;
import android.webkit.CookieManager;
import android.webkit.WebView;
import java.lang.reflect.Field;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.function.Consumer;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.mockito.MockedStatic;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Exercises the real host handler with synthetic local-session transport and SDK receipts. */
public final class MainActivityConnectTest {
    private MainActivity activity;
    private WebView web;
    private HostController host;
    private NativeConnect connect;
    private UiSessionClient sessions;
    private CookieManager cookies;
    private PowerManager power;
    private KeyguardManager keyguard;
    private MockedStatic<CookieManager> cookieStatic;
    private final ArrayDeque<Runnable> io = new ArrayDeque<>(), main = new ArrayDeque<>();
    private final List<JSONObject> replies = new ArrayList<>();
    private final Map<String, Integer> requestIds = new HashMap<>();
    private Consumer<JSONObject> sdkReply;
    private static final String URL = OriginPolicy.ORIGIN + "/local/settings";

    @Before public void setup() throws Exception {
        activity = mock(MainActivity.class, CALLS_REAL_METHODS);
        web = mock(WebView.class); host = mock(HostController.class); connect = mock(NativeConnect.class);
        sessions = mock(UiSessionClient.class); cookies = mock(CookieManager.class);
        power = mock(PowerManager.class); keyguard = mock(KeyguardManager.class);
        Handler handler = mock(Handler.class);
        ExecutorService executor = mock(ExecutorService.class);
        doAnswer(call -> { io.add(call.getArgument(0)); return null; }).when(executor).execute(any(Runnable.class));
        when(handler.post(any(Runnable.class))).thenAnswer(call -> { main.add(call.getArgument(0)); return true; });
        set("web", web); set("host", host); set("connect", connect); set("main", handler);
        set("pairingIo", executor); set("sessions", sessions); set("bridgeAvailable", true);
        set("connectRequests", new ConnectRequests()); set("resumed", true);
        doReturn(power).when(activity).getSystemService(PowerManager.class);
        doReturn(keyguard).when(activity).getSystemService(KeyguardManager.class);
        doReturn(false).when(activity).isDestroyed();
        when(power.isInteractive()).thenReturn(true);
        when(web.getUrl()).thenReturn(URL);
        host.state = HostState.parse("""
            {"schemaVersion":1,"runtime":{"status":"ready","message":"Synthetic"},"uiUrl":null,
            "activity":{"state":"idle","threadId":null,"title":"","detail":"","taskUrl":null,"completedSteps":null,"totalSteps":null},
            "policy":{"revision":1,"fullAccess":false,"computerUse":false},
            "capabilities":{"appData":false,"computerUse":false}}
            """);
        when(host.verified()).thenReturn(true);
        when(cookies.getCookie(OriginPolicy.ORIGIN)).thenReturn("synthetic-local-session");
        when(sessions.authenticated("synthetic-local-session")).thenReturn(true);
        cookieStatic = mockStatic(CookieManager.class);
        cookieStatic.when(CookieManager::getInstance).thenReturn(cookies);
        doAnswer(call -> { sdkReply = call.getArgument(1); return null; }).when(connect).getToken(anyString(), any());
        doAnswer(call -> { sdkReply = call.getArgument(0); return null; }).when(connect).getState(any());
        doAnswer(call -> { sdkReply = call.getArgument(0); return null; }).when(connect).signOut(any());
        when(connect.deliveryContext("user-a")).thenReturn("generation:session-a");
        when(connect.open()).thenReturn(new JSONObject().put("state", "authorizing"));
    }
    @After public void cleanup() { cookieStatic.close(); }
    private void set(String name, Object value) throws Exception {
        Field field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(activity, value);
    }
    private JSONObject request(String id, String method) throws Exception {
        // Reusing a label must replay the same ID, including across different methods.
        int counter = requestIds.computeIfAbsent(id, ignored -> requestIds.size() + 1);
        return new JSONObject().put("requestId", "session_" + counter).put("method", method)
                .put("payload", new JSONObject().put("accountId", "user-a"));
    }
    private void call(String id, String method) throws Exception {
        activity.handleConnect(web, request(id, method), true, OriginPolicy.ORIGIN, replies::add);
    }
    private void authenticate() { io.remove().run(); main.remove().run(); }
    private JSONObject token() throws Exception { return new JSONObject().put("token", "synthetic-jwt"); }

    @Test public void stateChangeNotifiesLocalWebWithoutFocusChangeButNeverRemoteOrDestroyedWeb() throws Exception {
        set("resumed", false);
        activity.notifyConnectChanged();
        verify(web).evaluateJavascript("window.dispatchEvent(new Event('lecturn:connect-changed'))", null);
        clearInvocations(web);
        when(web.getUrl()).thenReturn("https://example.invalid");
        activity.notifyConnectChanged();
        when(web.getUrl()).thenReturn(URL);
        doReturn(true).when(activity).isDestroyed();
        activity.notifyConnectChanged();
        verify(web, never()).evaluateJavascript(anyString(), any());
        verifyNoInteractions(connect, sessions);
    }

    @Test public void tokenAndStateReadsWorkOnHomeButStillAuthenticateTwice() throws Exception {
        set("resumed", false);
        call("read", "getConnectToken"); authenticate();
        verify(connect).getToken(eq("user-a"), any());
        sdkReply.accept(token()); assertTrue(replies.isEmpty()); authenticate();
        assertEquals("synthetic-jwt", replies.get(0).getString("token"));
        verify(sessions, times(2)).authenticated("synthetic-local-session");
        call("state", "getConnectState"); authenticate();
        sdkReply.accept(new JSONObject().put("state", "signed-out")); authenticate();
        assertEquals("signed-out", replies.get(1).getString("state"));
    }
    @Test public void foregroundMutationsAreDeniedOnHomeAndWhileLocked() throws Exception {
        set("resumed", false); call("one", "openConnectSignIn"); call("two", "signOutConnect");
        set("resumed", true); when(keyguard.isKeyguardLocked()).thenReturn(true);
        call("three", "openConnectSignIn"); call("four", "signOutConnect");
        assertEquals(4, replies.size()); assertTrue(io.isEmpty()); verifyNoInteractions(connect);
    }
    @Test public void mutationRechecksForegroundAfterSessionAuthentication() throws Exception {
        call("one", "signOutConnect"); set("resumed", false); authenticate();
        verifyNoInteractions(connect); assertEquals("error", replies.get(0).getString("state"));
    }
    @Test public void authOpenSettlesBeforeActivityLaunchAndDoesNotWaitForLogin() throws Exception {
        try (var intents = mockConstruction(Intent.class)) {
            doAnswer(call -> { assertEquals("authorizing", replies.get(0).getString("state")); return null; })
                    .when(activity).startActivity(any(Intent.class));
            call("open", "openConnectSignIn"); authenticate();
            verify(activity).startActivity(any(Intent.class));
            verify(connect).open(); assertEquals(1, replies.size()); assertTrue(io.isEmpty());
        }
    }
    @Test public void unauthenticatedOrStaleHostNeverInvokesSdk() throws Exception {
        when(sessions.authenticated("synthetic-local-session")).thenReturn(false);
        call("one", "getConnectToken"); authenticate();
        assertTrue(replies.get(0).isNull("token")); verifyNoInteractions(connect);
        when(host.verified()).thenReturn(false); call("two", "getConnectState");
        assertTrue(io.isEmpty()); verifyNoInteractions(connect);
    }
    @Test public void frameOriginAndViewMustMatchTrustedTopDocument() throws Exception {
        activity.handleConnect(web, request("one", "getConnectState"), false, OriginPolicy.ORIGIN, replies::add);
        activity.handleConnect(web, request("two", "getConnectState"), true, "https://example.invalid", replies::add);
        activity.handleConnect(mock(WebView.class), request("three", "getConnectState"), true, OriginPolicy.ORIGIN, replies::add);
        when(web.getUrl()).thenReturn("https://example.invalid"); call("four", "getConnectState");
        assertTrue(io.isEmpty()); assertTrue(replies.isEmpty()); verifyNoInteractions(connect);
    }
    @Test public void navigationOrCookieReplacementDuringSdkAwaitCannotReceiveToken() throws Exception {
        call("one", "getConnectToken"); authenticate(); set("pageEpoch", 1L);
        sdkReply.accept(token()); assertTrue(io.isEmpty()); assertTrue(replies.isEmpty());
        call("two", "getConnectToken"); authenticate();
        when(cookies.getCookie(OriginPolicy.ORIGIN)).thenReturn("different-cookie");
        sdkReply.accept(token()); assertTrue(io.isEmpty()); assertTrue(replies.isEmpty());
    }
    @Test public void localLogoutDuringTokenRequestDropsTheResult() throws Exception {
        call("one", "getConnectToken"); authenticate(); sdkReply.accept(token());
        when(sessions.authenticated("synthetic-local-session")).thenReturn(false); authenticate();
        assertTrue(replies.get(0).isNull("token"));
    }
    @Test public void sdkLogoutOrAccountSwitchDuringFinalSessionCheckDropsTheResult() throws Exception {
        call("one", "getConnectToken"); authenticate(); sdkReply.accept(token());
        when(connect.deliveryContext("user-a")).thenReturn(null); authenticate();
        assertTrue(replies.get(0).isNull("token"));
    }
    @Test public void replayCannotReopenAuthOrFetchAnotherToken() throws Exception {
        call("one", "getConnectToken"); call("one", "getConnectToken");
        assertEquals(1, io.size()); authenticate(); sdkReply.accept(token()); authenticate();
        call("one", "openConnectSignIn"); assertTrue(io.isEmpty());
        verify(connect, never()).open(); assertEquals(1, replies.size());
    }
}
