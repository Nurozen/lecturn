package com.cloudgatherer.lecturn.symba;

import android.app.KeyguardManager;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.os.Handler;
import android.os.PowerManager;
import android.webkit.CookieManager;
import android.webkit.WebView;
import java.lang.reflect.Field;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.mockito.MockedConstruction;
import org.mockito.MockedStatic;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Real Activity publication/session callbacks and widget state; synthetic Android/transport boundaries. */
public final class MainActivityWidgetTest {
    private MainActivity activity;
    private WebView web;
    private HostController host;
    private PowerManager power;
    private KeyguardManager keyguard;
    private CookieManager cookies;
    private UiSessionClient sessions;
    private final ArrayDeque<Runnable> io = new ArrayDeque<>(), main = new ArrayDeque<>();
    private final List<Boolean> receipts = new ArrayList<>();
    private MockedStatic<CookieManager> cookieStatic;
    private MockedStatic<AppWidgetManager> widgetStatic;
    private MockedConstruction<ComponentName> components;
    private static final String URL = OriginPolicy.ORIGIN + "/local/thread";

    @Before public void setup() throws Exception {
        activity = mock(MainActivity.class, CALLS_REAL_METHODS);
        web = mock(WebView.class); host = mock(HostController.class);
        power = mock(PowerManager.class); keyguard = mock(KeyguardManager.class);
        cookies = mock(CookieManager.class); sessions = mock(UiSessionClient.class);
        Handler handler = mock(Handler.class);
        ExecutorService executor = mock(ExecutorService.class);
        doAnswer(call -> { io.add(call.getArgument(0)); return null; }).when(executor).execute(any(Runnable.class));
        when(handler.post(any(Runnable.class))).thenAnswer(call -> { main.add(call.getArgument(0)); return true; });
        set("web", web); set("host", host); set("main", handler); set("pairingIo", executor);
        set("sessions", sessions); set("bridgeAvailable", true); set("pairing", new UiPairing());
        set("surface", mock(HostSurface.class)); set("accessRequests", new AccessRequests());
        set("accessDialog", mock(DeviceAccessDialog.class));
        doReturn(power).when(activity).getSystemService(PowerManager.class);
        doReturn(keyguard).when(activity).getSystemService(KeyguardManager.class);
        doReturn(false).when(activity).isDestroyed();
        when(power.isInteractive()).thenReturn(true);
        when(web.getUrl()).thenReturn(URL); when(web.getProgress()).thenReturn(100);
        host.state = state("ready");
        when(host.verified()).thenReturn(true);
        when(cookies.getCookie(OriginPolicy.ORIGIN)).thenReturn("synthetic-session");
        when(sessions.authenticated("synthetic-session")).thenReturn(true);
        cookieStatic = mockStatic(CookieManager.class);
        cookieStatic.when(CookieManager::getInstance).thenReturn(cookies);
        AppWidgetManager manager = mock(AppWidgetManager.class);
        when(manager.getAppWidgetIds(any(ComponentName.class))).thenReturn(new int[0]);
        widgetStatic = mockStatic(AppWidgetManager.class);
        widgetStatic.when(() -> AppWidgetManager.getInstance(activity)).thenReturn(manager);
        components = mockConstruction(ComponentName.class);
        ChatWidget.clear(activity);
    }
    @After public void cleanup() {
        ChatWidget.clear(activity);
        components.close(); widgetStatic.close(); cookieStatic.close();
    }
    private void set(String name, Object value) throws Exception {
        Field field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(activity, value);
    }
    private Object invoke(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); return method.invoke(activity);
    }
    private HostState state(String runtime) throws Exception {
        return HostState.parse("""
                {"schemaVersion":1,"runtime":{"status":"%s","message":"Synthetic"},"uiUrl":null,
                "activity":{"state":"idle","threadId":null,"title":"","detail":"","taskUrl":null,"completedSteps":null,"totalSteps":null},
                "policy":{"revision":1,"fullAccess":false,"computerUse":false},
                "capabilities":{"appData":false,"computerUse":false}}
                """.formatted(runtime));
    }
    private JSONObject snapshot(String text) throws Exception {
        return new JSONObject().put("threadId", "thread").put("title", "Synthetic chat")
                .put("messages", new JSONArray().put(new JSONObject().put("role", "assistant").put("text", text)));
    }
    private void publish(String text) throws Exception {
        activity.publishChatWidget(web, snapshot(text), true, OriginPolicy.ORIGIN, receipts::add);
    }
    private void complete() { io.remove().run(); main.remove().run(); }
    private void assertEmpty() { assertNull(ChatWidget.selectedUrl()); assertFalse(ChatWidget.messages().get(0).contains("Synthetic result")); }

    @Test public void homeCancelsOldEpochButNextBackgroundUpdatePublishesWithoutInteraction() throws Exception {
        set("resumed", true); publish("Synthetic result before Home");
        set("resumed", false); set("pageEpoch", 1L); complete();
        assertEquals(List.of(false), receipts); assertEmpty();
        assertEquals(false, invoke("interactive"));
        publish("Synthetic result while agent works on Home"); complete();
        assertEquals(List.of(false, true), receipts);
        assertEquals(URL, ChatWidget.selectedUrl());
        assertTrue(ChatWidget.messages().get(0).contains("while agent works on Home"));
        publish("Synthetic result completed in background"); complete();
        assertTrue(ChatWidget.messages().get(0).contains("completed in background"));
        assertEquals(false, invoke("interactive"));
    }
    @Test public void lockClearsRowsAndInvalidatesAnAuthenticationAlreadyInFlight() throws Exception {
        publish("Synthetic result visible"); complete();
        publish("Synthetic result pending");
        when(keyguard.isKeyguardLocked()).thenReturn(true);
        activity.updateWidgetVisibility(); assertEmpty();
        when(keyguard.isKeyguardLocked()).thenReturn(false);
        complete(); assertEmpty();
        assertEquals(List.of(true, false), receipts);
        when(keyguard.isKeyguardLocked()).thenReturn(true);
        publish("Synthetic result locked"); assertEmpty(); assertTrue(io.isEmpty());
        verify(web).onPause();
    }
    @Test public void screenOffAndDestroyedActivityCannotPublish() throws Exception {
        when(power.isInteractive()).thenReturn(false);
        publish("Synthetic result off");
        when(power.isInteractive()).thenReturn(true);
        doReturn(true).when(activity).isDestroyed();
        publish("Synthetic result destroyed");
        assertEquals(List.of(false, false), receipts); assertEmpty(); assertTrue(io.isEmpty());
    }
    @Test public void clearAndNavigationRejectLateSessionResults() throws Exception {
        publish("Synthetic result old");
        activity.publishChatWidget(web, JSONObject.NULL, true, OriginPolicy.ORIGIN, receipts::add);
        complete(); assertEquals(List.of(true, false), receipts); assertEmpty();
        publish("Synthetic result old page"); set("pageEpoch", 1L); complete(); assertEmpty();
        publish("Synthetic result old route"); when(web.getUrl()).thenReturn(OriginPolicy.ORIGIN + "/local/other");
        complete(); assertEmpty();
    }
    @Test public void currentCookieAndVerifiedRuntimeAreRecheckedAfterAuthentication() throws Exception {
        publish("Synthetic result cookie changed");
        when(cookies.getCookie(OriginPolicy.ORIGIN)).thenReturn("replacement-session");
        complete(); assertEmpty();
        when(cookies.getCookie(OriginPolicy.ORIGIN)).thenReturn("synthetic-session");
        publish("Synthetic result runtime stopped"); host.stopping = true; complete(); assertEmpty();
        host.stopping = false;
        publish("Synthetic result host stale"); when(host.verified()).thenReturn(false); complete(); assertEmpty();
        when(host.verified()).thenReturn(true);
        publish("Synthetic result no runtime"); host.state = state("stopped"); complete(); assertEmpty();
        assertEquals(List.of(false, false, false, false), receipts);
    }
    @Test public void stopThenRestartCannotRestoreAnOldPendingPublication() throws Exception {
        publish("Synthetic result visible"); complete();
        publish("Synthetic result before Stop");
        host.stopping = true; activity.changed(); assertEmpty();
        host.stopping = false; activity.changed();
        complete(); assertEmpty();
        assertEquals(List.of(true, false), receipts);
    }
    @Test public void requestsRemainBoundedWhileSessionAuthenticationIsSlow() throws Exception {
        publish("Synthetic result first"); publish("Synthetic result second"); publish("Synthetic result third");
        assertEquals(2, io.size()); assertEquals(List.of(false), receipts);
        complete(); complete();
        assertEquals(List.of(false, false, true), receipts);
        assertTrue(ChatWidget.messages().get(0).contains("second"));
    }
    @Test public void failedSessionRevokesPreviouslyPublishedRows() throws Exception {
        publish("Synthetic result visible"); complete();
        when(sessions.authenticated("synthetic-session")).thenReturn(false);
        publish("Synthetic result revoked"); complete(); assertEmpty();
        assertEquals(List.of(true, false), receipts);
    }
    @Test public void foreignFramesOriginsAndWebViewsCannotPublishOrClear() throws Exception {
        publish("Synthetic result retained"); complete();
        activity.publishChatWidget(web, JSONObject.NULL, false, OriginPolicy.ORIGIN, receipts::add);
        activity.publishChatWidget(web, snapshot("bad"), true, "https://example.invalid", receipts::add);
        activity.publishChatWidget(mock(WebView.class), JSONObject.NULL, true, OriginPolicy.ORIGIN, receipts::add);
        assertEquals(List.of(true, false, false, false), receipts);
        assertTrue(ChatWidget.messages().get(0).contains("retained")); assertTrue(io.isEmpty());
    }
    @Test public void newerPublicationWinsEvenIfOlderAuthenticationCompletesLast() throws Exception {
        publish("Synthetic result older"); publish("Synthetic result newer");
        io.removeLast().run(); main.remove().run();
        complete();
        assertEquals(List.of(true, false), receipts);
        assertTrue(ChatWidget.messages().get(0).contains("newer"));
    }
    @Test public void verifiedSessionRefreshRestoresRowsEvenWhenNoChatDataChanged() throws Exception {
        set("resumed", true); set("sessionNeeded", true);
        doNothing().when(activity).changed();
        // Model the existing web publisher's refresh subscription across the actual native callback.
        doAnswer(call -> {
            if (((String) call.getArgument(0)).contains("lecturn:chat-visible")) publish("Synthetic result recovered");
            return null;
        }).when(web).evaluateJavascript(anyString(), isNull());
        invoke("checkPairing"); complete();
        assertEmpty(); // Session verification only requests publication; it cannot trust cached text itself.
        complete();
        assertTrue(ChatWidget.messages().get(0).contains("recovered"));
        assertEquals(List.of(true), receipts);
    }
    @Test public void unlockingOnHomeRefreshesThroughAuthenticatedPublication() throws Exception {
        doAnswer(call -> { publish("Synthetic result after unlock"); return null; })
                .when(web).evaluateJavascript(anyString(), isNull());
        activity.updateWidgetVisibility(); complete();
        assertTrue(ChatWidget.messages().get(0).contains("after unlock"));
        assertEquals(false, invoke("interactive"));
        verify(web).onResume();
    }
}
