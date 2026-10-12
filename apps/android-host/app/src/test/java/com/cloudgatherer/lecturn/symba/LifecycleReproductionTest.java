package com.cloudgatherer.lecturn.symba;

import android.content.Context;
import android.content.Intent;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.os.PowerManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;
import org.junit.*;
import org.mockito.*;
import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

/** Real lifecycle code with synthetic transport and deterministic queues; no device or sleeps. */
public class LifecycleReproductionTest {
    final ArrayDeque<Runnable> ioQueue = new ArrayDeque<>(), mainQueue = new ArrayDeque<>();
    final Map<Runnable,Long> delayed = new LinkedHashMap<>();
    final List<AutoCloseable> mocks = new ArrayList<>();
    final List<String> calls = new ArrayList<>();
    final ArrayDeque<Object> replies = new ArrayDeque<>();
    HostController host;
    ControlClient.Failure runtimeConflict;
    long now = 1000;
    @Before public void setup() throws Exception {
        // Classify the real wire refusal before mocking the controller's transport.
        java.net.HttpURLConnection connection = mock(java.net.HttpURLConnection.class);
        when(connection.getResponseCode()).thenReturn(409);
        when(connection.getOutputStream()).thenReturn(new java.io.ByteArrayOutputStream());
        when(connection.getErrorStream()).thenReturn(new java.io.ByteArrayInputStream(
                "{\"error\":\"runtime_transition_in_progress\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        ControlClient wireClient = new ControlClient(
                () -> "{\"controlPort\":18768,\"controlToken\":\"" + "a".repeat(64) + "\"}", url -> connection);
        runtimeConflict = assertThrows(ControlClient.Failure.class,
                () -> wireClient.request("POST", "/v1/runtime/stop", new JSONObject()));
        Context context = mock(Context.class);
        when(context.getApplicationContext()).thenReturn(context);
        ExecutorService executor = mock(ExecutorService.class);
        doAnswer(i -> { ioQueue.add(i.getArgument(0)); return null; }).when(executor).execute(any());
        mocks.add(mockStatic(Looper.class));
        MockedStatic<SystemClock> clock = mockStatic(SystemClock.class);
        clock.when(SystemClock::elapsedRealtime).thenAnswer(i -> now); mocks.add(clock);
        mocks.add(mockStatic(ChatWidget.class));
        MockedStatic<Executors> executors = mockStatic(Executors.class);
        executors.when(Executors::newSingleThreadExecutor).thenReturn(executor); mocks.add(executors);
        mocks.add(mockConstruction(Handler.class, (h,c) -> {
            when(h.post(any())).thenAnswer(i -> { mainQueue.add(i.getArgument(0)); return true; });
            when(h.postDelayed(any(),anyLong())).thenAnswer(i -> { delayed.put(i.getArgument(0),i.getArgument(1)); return true; });
            doAnswer(i -> { Runnable r=i.getArgument(0); delayed.remove(r); mainQueue.remove(r); return null; }).when(h).removeCallbacks(any());
        }));
        mocks.add(mockConstruction(ControlClient.class, (c,ignored) -> {
            when(c.bootstrap()).thenReturn(UiBootstrap.parse(UiBootstrapTest.response(), java.time.Instant.now()));
            when(c.request(anyString(),anyString(),any())).thenAnswer(i -> {
                calls.add(i.getArgument(0)+" "+i.getArgument(1));
                Object reply=replies.remove();
                if(reply instanceof Exception e) throw e;
                return reply;
            });
        }));
        host = new HostController(context);
    }
    @After public void close() throws Exception { Collections.reverse(mocks); for(AutoCloseable m:mocks)m.close(); }
    HostState state(String runtime) throws Exception {
        return state(runtime, "working");
    }
    HostState state(String runtime, String activity) throws Exception {
        JSONObject f=new JSONObject("""
          {"schemaVersion":1,"runtime":{"status":"ready","message":"Synthetic"},"uiUrl":"http://127.0.0.1:3773",
          "activity":{"state":"working","threadId":null,"title":"Synthetic","detail":"Synthetic","taskUrl":null,"completedSteps":null,"totalSteps":null},
          "policy":{"revision":1,"fullAccess":false,"computerUse":false},"capabilities":{"appData":false,"computerUse":false}}
          """);
        f.getJSONObject("activity").put("state",activity);
        f.getJSONObject("runtime").put("status",runtime); return HostState.parse(f.toString());
    }
    void complete(Object reply) { replies.add(reply); ioQueue.remove().run(); mainQueue.remove().run(); }
    void poll(long delay) {
        Runnable r=delayed.entrySet().stream().filter(e->e.getValue()==delay).map(Map.Entry::getKey).findFirst().orElseThrow();
        delayed.remove(r); now += delay; r.run();
    }
    @Test public void oneShotResumeWithoutServiceExpiresWithoutAnotherRequest() throws Exception {
        host.refresh(); complete(state("ready"));
        poll(20000);
        assertFalse(host.verified()); assertNotNull(host.error);
        assertTrue(mainQueue.isEmpty()); assertTrue(ioQueue.isEmpty()); assertTrue(delayed.isEmpty());
        assertEquals(List.of("GET /v1/state"), calls);
    }
    @Test public void foregroundObservesExistingGuestBeyondExpiryWithoutStartingServiceOrRuntime() throws Exception {
        host.foreground(true); mainQueue.remove().run(); complete(state("ready", "idle"));
        for (int i = 0; i < 3; i++) {
            poll(8000); complete(state("ready", "idle"));
            assertTrue(host.verified()); assertFalse(host.monitoring);
        }
        assertEquals(Collections.nCopies(4, "GET /v1/state"), calls);
    }
    @Test public void browserReturnRetriesFailedRefreshAndRestoresVerificationOnlyAfterReceipt() throws Exception {
        host.foreground(true); mainQueue.remove().run(); complete(state("ready"));
        host.foreground(false); poll(20000);
        assertFalse(host.verified()); assertTrue(ioQueue.isEmpty());
        host.foreground(true); mainQueue.remove().run();
        assertFalse(host.verified());
        complete(new ControlClient.Failure("Synthetic return timeout", false));
        assertFalse(host.verified());
        poll(10000); assertFalse(host.verified()); complete(state("ready"));
        assertTrue(host.verified()); assertFalse(host.monitoring);
        assertEquals(Collections.nCopies(3, "GET /v1/state"), calls);
    }
    @Test public void resumeDuringInFlightFailureStillSchedulesRecovery() throws Exception {
        host.refresh(); host.foreground(true);
        assertTrue(mainQueue.isEmpty()); assertEquals(1, ioQueue.size());
        complete(new ControlClient.Failure("Synthetic in-flight failure", false));
        poll(10000); complete(state("ready"));
        assertTrue(host.verified());
        assertEquals(Collections.nCopies(2, "GET /v1/state"), calls);
    }
    @Test public void foregroundAndServiceReleaseOnlyTheirOwnPollingOwnership() throws Exception {
        host.foreground(true); mainQueue.remove().run(); complete(state("ready"));
        host.monitor(true); host.foreground(false);
        assertEquals(1, mainQueue.size()); mainQueue.remove().run(); complete(state("ready"));
        poll(3000); complete(state("ready"));
        host.foreground(true); host.monitor(false);
        assertEquals(1, mainQueue.size()); mainQueue.remove().run(); complete(state("ready"));
        poll(3000); complete(state("ready"));
        host.foreground(false);
        assertFalse(delayed.containsValue(3000L)); assertTrue(mainQueue.isEmpty());
        poll(20000); assertFalse(host.verified()); assertTrue(ioQueue.isEmpty());
        assertEquals(Collections.nCopies(5, "GET /v1/state"), calls);
    }
    @Test public void foregroundStopAndStaleStoppedReturnNeverRestartRuntime() throws Exception {
        host.foreground(true); mainQueue.remove().run(); complete(state("ready"));
        host.stop(); assertFalse(host.verified()); complete(state("stopped"));
        poll(8000); complete(state("stopped"));
        host.foreground(false); poll(20000); assertFalse(host.verified());
        host.foreground(true); mainQueue.remove().run(); complete(state("stopped"));
        assertTrue(host.verified()); assertEquals("stopped", host.state.runtime);
        assertEquals(List.of("GET /v1/state", "POST /v1/runtime/stop", "GET /v1/state", "GET /v1/state"), calls);
    }
    @Test public void monitoredErrorRecoversWithoutStartRetry() throws Exception {
        host.start(); host.monitor(true); complete(state("error"));
        assertTrue(host.verified()); assertEquals("error",host.state.runtime);
        poll(8000); complete(state("ready"));
        assertTrue(host.verified()); assertEquals("ready",host.state.runtime);
        assertEquals(List.of("POST /v1/runtime/start","GET /v1/state"),calls);
    }
    @Test public void failedStopRemainsVisibleAfterSuccessfulReadyPoll() throws Exception {
        host.state=state("ready"); host.error=null; host.receivedAt=1000;
        host.stop(); host.monitor(true);
        assertTrue(host.stopping);
        complete(new ControlClient.Failure("Synthetic stop timeout",false));
        assertFalse(host.stopping); assertEquals("Synthetic stop timeout",host.error);
        poll(10000); complete(state("ready"));
        assertTrue(host.verified()); assertNull(host.error); assertNotNull(stopFailure());
        assertTrue(stopFailure().contains("not confirmed"));
        poll(3000); complete(state("ready"));
        assertNotNull(stopFailure());
        assertEquals("ready",host.state.runtime);
        assertEquals(List.of("POST /v1/runtime/stop","GET /v1/state","GET /v1/state"),calls);
    }
    @Test public void pendingStopWinsOverPendingStartAndClearsAfterFailure() throws Exception {
        host.refresh(); host.start(); host.stop(); host.monitor(true);
        complete(state("ready"));
        assertTrue(host.stopping); assertTrue(host.busy);
        complete(new ControlClient.Failure("Synthetic failed stop",false));
        assertFalse(host.stopping); assertFalse(host.busy);
        poll(10000); complete(state("ready"));
        assertEquals(List.of("GET /v1/state","POST /v1/runtime/stop","GET /v1/state"),calls);
    }
    @Test public void disablingMonitorLeavesErrorUntilExplicitRefresh() throws Exception {
        host.start(); host.monitor(true); complete(state("error"));
        host.monitor(false);
        assertFalse(delayed.containsValue(8000L)); assertTrue(ioQueue.isEmpty());
        host.refresh(); complete(state("ready"));
        assertTrue(host.verified()); assertEquals("ready",host.state.runtime);
        assertEquals(List.of("POST /v1/runtime/start","GET /v1/state"),calls);
    }
    ControlClient.Failure transitionConflict() {
        return runtimeConflict;
    }

    @Test public void transitionConflictRetriesSameStopAfterDelayThenConfirmsStopped() throws Exception {
        ControlClient.Failure conflict = transitionConflict();
        host.stop(); host.monitor(true); complete(conflict);
        assertTrue(host.stopping); assertTrue(host.busy);
        assertTrue(ioQueue.isEmpty()); assertFalse(delayed.containsValue(10000L));
        poll(1000); complete(state("stopped"));
        assertFalse(host.stopping); assertTrue(host.verified()); assertNull(stopFailure());
        assertEquals(List.of("POST /v1/runtime/stop", "POST /v1/runtime/stop"), calls);
    }
    @Test public void repeatedConflictHasBoundedAttemptsAndLeavesFailureVisible() throws Exception {
        ControlClient.Failure conflict = transitionConflict();
        host.stop(); host.monitor(true); complete(conflict);
        for (int attempt = 0; attempt < 3; attempt++) { poll(1000); complete(conflict); }
        assertFalse(host.busy); assertFalse(host.stopping); assertNotNull(stopFailure());
        assertFalse(delayed.containsValue(1000L));
        assertEquals(Collections.nCopies(4, "POST /v1/runtime/stop"), calls);
        poll(10000); complete(state("ready"));
        assertTrue(host.verified()); assertNotNull(stopFailure());
    }
    @Test public void delayedCallbackPastDeadlineCannotReplayStop() throws Exception {
        ControlClient.Failure conflict = transitionConflict();
        host.stop(); host.monitor(true); complete(conflict);
        now += 6000;
        poll(1000);
        assertFalse(host.busy); assertFalse(host.stopping); assertNotNull(stopFailure());
        assertEquals(List.of("POST /v1/runtime/stop"), calls); assertTrue(ioQueue.isEmpty());
    }
    @Test public void slowConflictCannotExtendRetryWindow() throws Exception {
        ControlClient.Failure conflict = transitionConflict();
        host.stop(); now += 6000; complete(conflict);
        assertFalse(host.busy); assertNotNull(stopFailure());
        assertFalse(delayed.containsValue(1000L));
    }
    @Test public void startIsNeverReplayedEvenForTransitionConflict() throws Exception {
        ControlClient.Failure conflict = transitionConflict();
        host.start(); host.monitor(true); complete(conflict);
        assertFalse(host.busy); assertFalse(delayed.containsValue(1000L));
        poll(10000); complete(state("ready"));
        assertEquals(List.of("POST /v1/runtime/start", "GET /v1/state"), calls);
    }
    @Test public void newStartDuringStopDelaySupersedesRetryOnlyWhenExplicit() throws Exception {
        ControlClient.Failure conflict = transitionConflict();
        host.stop(); complete(conflict); host.start();
        poll(1000); complete(state("ready"));
        assertFalse(host.stopping); assertNull(stopFailure());
        assertEquals(List.of("POST /v1/runtime/stop", "POST /v1/runtime/start"), calls);
    }
    @Test public void newStopSupersedesQueuedStartAndOldRetryEpoch() throws Exception {
        ControlClient.Failure conflict = transitionConflict();
        host.stop(); complete(conflict); host.start(); host.stop();
        poll(1000); complete(state("stopped"));
        assertFalse(host.stopping); assertTrue(host.verified());
        assertEquals(List.of("POST /v1/runtime/stop", "POST /v1/runtime/stop"), calls);
    }
    @Test public void stopInvalidatesOldAccessCallbackAndNeverRegrants() throws Exception {
        List<HostState> callbacks = new ArrayList<>();
        host.readAccess(callbacks::add); host.start(); host.stop();
        complete(state("ready"));
        assertEquals(Collections.singletonList(null), callbacks);
        assertTrue(host.stopping);
        complete(state("stopped"));
        assertEquals(List.of("GET /v1/state", "POST /v1/runtime/stop"), calls);
    }
    @Test public void policyConflictRefreshesWithoutReplayingPolicy() throws Exception {
        host.state = state("ready"); host.error = null; host.receivedAt = now;
        List<HostState> callbacks = new ArrayList<>();
        host.policy(1, false, false, callbacks::add);
        complete(new ControlClient.Failure("Review refreshed policy", true));
        assertEquals(Collections.singletonList(null), callbacks);
        complete(state("ready"));
        assertTrue(host.verified()); assertEquals("Review refreshed policy", host.notice);
        assertEquals(List.of("POST /v1/policy", "GET /v1/state"), calls);
    }
    @Test public void bootstrapBeforeStopCannotDeliverOldPairing() throws Exception {
        host.state = state("ready"); host.error = null; host.receivedAt = now;
        List<UiBootstrap> callbacks = new ArrayList<>();
        assertTrue(host.bootstrap(callbacks::add)); host.stop();
        ioQueue.remove().run(); mainQueue.remove().run();
        assertEquals(Collections.singletonList(null), callbacks);
        assertTrue(host.stopping); complete(state("stopped"));
        assertEquals(List.of("POST /v1/runtime/stop"), calls);
    }
    @Test public void timeout503AndUnknownConflictNeverReplayStop() throws Exception {
        for (String message : List.of("Transport timeout", "HTTP 503", "Unknown HTTP 409")) {
            host.stop(); host.monitor(true); complete(new ControlClient.Failure(message, false));
            assertFalse(host.busy); assertFalse(host.stopping); assertNotNull(stopFailure());
            assertFalse(delayed.containsValue(1000L));
            poll(10000); complete(state("ready"));
        }
        assertEquals(List.of("POST /v1/runtime/stop", "GET /v1/state",
                "POST /v1/runtime/stop", "GET /v1/state", "POST /v1/runtime/stop", "GET /v1/state"), calls);
    }
    @Test public void nonStoppedSuccessCannotHideFailedStop() throws Exception {
        host.stop(); complete(state("ready"));
        assertFalse(host.stopping); assertEquals("ready", host.state.runtime); assertNotNull(stopFailure());
    }
    @Test public void failedStopBannerSurvivesReadyWorkspaceAndConsumedToast() throws Exception {
        host.stop(); host.monitor(true); complete(new ControlClient.Failure("Synthetic failure", false));
        poll(10000); complete(state("ready"));
        host.notice = null;
        assertNotNull(stopFailure());
        HostSurface surface = mock(HostSurface.class, CALLS_REAL_METHODS);
        android.widget.TextView banner = mock(android.widget.TextView.class);
        set(surface, "pairingStatus", banner); set(surface, "status", mock(android.widget.TextView.class));
        set(surface, "device", mock(android.widget.Button.class));
        set(surface, "content", mock(android.widget.FrameLayout.class));
        set(surface, "waiting", mock(android.widget.ScrollView.class));
        surface.render(host, true, true, new UiPairing());
        verify(banner).setVisibility(android.view.View.VISIBLE);
        verify(banner).setText("Stop was not confirmed. Refresh status or try Stop again.");
    }
    @Test public void confirmedStopStillStopsServiceAndNeverAcquiresWorkWake() throws Exception {
        RuntimeService service = service();
        Intent stop = mock(Intent.class); when(stop.getAction()).thenReturn(RuntimeService.STOP);
        service.onStartCommand(stop, 0, 1);
        complete(state("stopped"));
        verify(service).stopForeground(android.app.Service.STOP_FOREGROUND_REMOVE);
        verify(service).stopSelf();
        verify((PowerManager.WakeLock) field(service, "wake"), never()).acquire(anyLong());
    }
    @Test public void stopQueuedBehindPollStillStopsServiceWhenLaterStartIsDiscarded() throws Exception {
        RuntimeService service = service();
        Intent stop = mock(Intent.class); when(stop.getAction()).thenReturn(RuntimeService.STOP);
        Intent start = mock(Intent.class); when(start.getAction()).thenReturn(RuntimeService.START);
        host.refresh();
        service.onStartCommand(stop, 0, 1);
        service.onStartCommand(start, 0, 2);
        complete(state("ready"));
        verify(service, never()).stopSelf();
        complete(state("stopped"));
        assertEquals(List.of("GET /v1/state", "POST /v1/runtime/stop"), calls);
        assertTrue(host.verified()); assertEquals("stopped", host.state.runtime);
        assertFalse(host.busy); assertTrue(ioQueue.isEmpty());
        verify(service).stopForeground(android.app.Service.STOP_FOREGROUND_REMOVE);
        verify(service).stopSelf();
    }
    @Test public void explicitServiceStartQueuedDuringStopKeepsServiceAlive() throws Exception {
        RuntimeService service = service();
        Intent stop = mock(Intent.class); when(stop.getAction()).thenReturn(RuntimeService.STOP);
        Intent start = mock(Intent.class); when(start.getAction()).thenReturn(RuntimeService.START);
        service.onStartCommand(stop, 0, 1);
        service.onStartCommand(start, 0, 2);
        complete(state("stopped")); complete(state("ready"));
        verify(service, never()).stopSelf();
        assertEquals(List.of("POST /v1/runtime/stop", "POST /v1/runtime/start"), calls);
    }
    String stopFailure() throws Exception {
        try {
            var field = HostController.class.getDeclaredField("stopFailure");
            field.setAccessible(true); return (String) field.get(host);
        } catch (NoSuchFieldException e) { return host.notice; }
    }
    static void set(Object target, String name, Object value) throws Exception {
        var f=target.getClass().getDeclaredField(name); f.setAccessible(true); f.set(target,value);
    }
    @Test public void notificationStopFailureReleasesLatchAndRecoversWorkWakeAfterReadyPoll() throws Exception {
        RuntimeService service = service();
        PowerManager.WakeLock wake = (PowerManager.WakeLock) field(service, "wake");
        Intent stop=mock(Intent.class); when(stop.getAction()).thenReturn(RuntimeService.STOP);
        service.onStartCommand(stop,0,1);
        complete(new ControlClient.Failure("Synthetic stop timeout",false));
        poll(10000); complete(state("ready"));
        assertTrue(host.verified()); assertTrue(host.state.working()); assertFalse(host.stopping);
        assertFalse((boolean) field(service, "stopping"));
        verify(wake).acquire(WorkLease.TIMEOUT_MS);
        verify(service,never()).stopSelf();
        assertEquals(List.of("POST /v1/runtime/stop","GET /v1/state"),calls);
    }
    RuntimeService service() throws Exception {
        RuntimeService service=mock(RuntimeService.class, CALLS_REAL_METHODS);
        PowerManager.WakeLock wake=mock(PowerManager.WakeLock.class), startupWake=mock(PowerManager.WakeLock.class);
        set(service,"host",host); set(service,"lease",new WorkLease());
        set(service,"overlay",mock(ActivityOverlay.class)); set(service,"wake",wake); set(service,"startupWake",startupWake);
        doReturn(mock(NotificationManager.class)).when(service).getSystemService(NotificationManager.class);
        doNothing().when(service).startForeground(anyInt(),any());
        doNothing().when(service).startForeground(anyInt(),any(),anyInt());
        doNothing().when(service).stopForeground(anyInt()); doNothing().when(service).stopSelf();
        host.add(service);
        mocks.add(mockStatic(PendingIntent.class));
        mocks.add(mockConstruction(Intent.class, withSettings().defaultAnswer(RETURNS_SELF)));
        mocks.add(mockConstruction(Notification.Builder.class, withSettings().defaultAnswer(RETURNS_SELF)));
        mocks.add(mockConstruction(Notification.Action.Builder.class, withSettings().defaultAnswer(RETURNS_SELF)));
        return service;
    }
    static Object field(Object target, String name) throws Exception {
        var f = target.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(target);
    }
}
