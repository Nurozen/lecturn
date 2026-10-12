package com.cloudgatherer.lecturn.symba;

import android.content.res.Resources;
import android.os.SystemClock;
import android.view.View;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.lang.reflect.Field;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.mockito.MockedStatic;
import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

/** Real rendering and freshness with synthetic state and mocked Android views; no WebView reloads. */
public final class HostSurfaceTest {
    private HostSurface surface;
    private HostController host;
    private final UiPairing pairing = new UiPairing();
    private WebView web;
    private ScrollView waiting;
    private Button start;
    private TextView banner;
    private MockedStatic<SystemClock> clock;
    private long now = 1000;

    @Before public void setup() throws Exception {
        surface = mock(HostSurface.class);
        doCallRealMethod().when(surface).render(any(), anyBoolean(), anyBoolean(), any());
        host = mock(HostController.class, CALLS_REAL_METHODS);
        clock = mockStatic(SystemClock.class);
        clock.when(SystemClock::elapsedRealtime).thenAnswer(call -> now);
        web = mock(WebView.class); waiting = mock(ScrollView.class); start = mock(Button.class);
        banner = mock(TextView.class);
        FrameLayout content = mock(FrameLayout.class);
        when(content.getChildCount()).thenReturn(2);
        when(content.getChildAt(0)).thenReturn(web);
        when(content.getChildAt(1)).thenReturn(waiting);
        set("content", content); set("waiting", waiting); set("start", start);
        set("pairingStatus", banner); set("status", mock(TextView.class));
        set("title", mock(TextView.class)); set("detail", mock(TextView.class));
        set("device", mock(Button.class)); set("stop", mock(Button.class));
        Resources resources = mock(Resources.class);
        when(resources.getString(R.string.host_pairing)).thenReturn("Pairing synthetic session");
        when(surface.getResources()).thenReturn(resources);
    }

    @After public void cleanup() { clock.close(); }

    private void set(String name, Object value) throws Exception {
        Field field = HostSurface.class.getDeclaredField(name);
        field.setAccessible(true); field.set(surface, value);
    }
    private void confirm(String runtime) throws Exception {
        host.state = HostState.parse("""
                {"schemaVersion":1,"runtime":{"status":"%s","message":"Synthetic"},"uiUrl":null,
                "activity":{"state":"idle","threadId":null,"title":"","detail":"","taskUrl":null,"completedSteps":null,"totalSteps":null},
                "policy":{"revision":1,"fullAccess":false,"computerUse":false},
                "capabilities":{"appData":false,"computerUse":false}}
                """.formatted(runtime));
        host.error = null; host.receivedAt = now;
        assertTrue(host.verified());
    }
    private void expire() {
        now += 20000;
        assertFalse(host.verified());
    }
    private void loseContact() {
        host.state = null; host.error = "Synthetic transport failure";
        assertFalse(host.verified());
    }
    private void render(boolean workspaceVisible) {
        clearInvocations(web, waiting, start, banner);
        surface.render(host, true, true, pairing);
        verify(web).setVisibility(workspaceVisible ? View.VISIBLE : View.INVISIBLE);
        verify(waiting).setVisibility(workspaceVisible ? View.GONE : View.VISIBLE);
        // Keeping the same view and document preserves its auth panel and composer draft.
        verifyNoMoreInteractions(web);
    }
    private void assertStartAvailable() {
        verify(start).setVisibility(View.VISIBLE);
        verify(start).setEnabled(true);
    }

    @Test public void readyWorkspaceSurvivesExpiryTransportLossAndVerifiedReconnect() throws Exception {
        confirm("ready"); render(true);
        expire(); render(true);
        loseContact(); render(true);
        confirm("ready"); render(true);
        assertTrue(host.verified());
    }

    @Test public void confirmedStopKeepsStartVisibleAfterExpiryAndContactLoss() throws Exception {
        confirm("ready"); render(true);
        confirm("stopped"); host.monitoring = false; render(false); assertStartAvailable();
        expire(); render(false); assertStartAvailable();
        loseContact(); render(false); assertStartAvailable();
        confirm("ready"); render(true);
    }

    @Test public void startingCannotRevealOldWorkspaceAfterExpiryOrContactLoss() throws Exception {
        confirm("ready"); render(true);
        confirm("starting"); host.monitoring = true; render(false);
        expire(); render(false); assertStartAvailable();
        loseContact(); render(false); assertStartAvailable();
        confirm("ready"); render(true);
    }

    @Test public void runtimeErrorCannotRevealOldWorkspaceAfterExpiryOrContactLoss() throws Exception {
        confirm("ready"); render(true);
        confirm("error"); render(false); assertStartAvailable();
        expire(); render(false); assertStartAvailable();
        loseContact(); render(false); assertStartAvailable();
    }

    @Test public void stoppingClearsWorkspaceRetentionBeforeAnyStopReceipt() throws Exception {
        confirm("ready"); render(true);
        host.stopping = true; render(false);
        verify(start).setEnabled(false);
        loseContact(); host.stopping = false;
        host.stopFailure = "Synthetic Stop was not confirmed";
        render(false); assertStartAvailable();
        verify(banner).setVisibility(View.VISIBLE);
        verify(banner).setText(host.stopFailure);
    }

    @Test public void oldPairingErrorStaysHiddenAfterConfirmedStopExpires() throws Exception {
        confirm("ready"); render(true);
        pairing.fail("Runtime stopping. Retry pairing after restarting.");
        confirm("stopped"); render(false);
        verify(banner).setVisibility(View.GONE);
        expire(); render(false);
        verify(banner).setVisibility(View.GONE);
        loseContact(); render(false);
        verify(banner).setVisibility(View.GONE);
    }

    @Test public void stopFailureRemainsVisibleWithHiddenOrReconnectedWorkspace() throws Exception {
        host.stopFailure = "Synthetic Stop was not confirmed";
        pairing.fail("Synthetic old pairing error");
        confirm("error"); render(false);
        verify(banner).setVisibility(View.VISIBLE);
        verify(banner).setText(host.stopFailure);
        expire(); render(false);
        verify(banner).setVisibility(View.VISIBLE);
        verify(banner).setText(host.stopFailure);
        confirm("ready"); render(true);
        verify(banner).setVisibility(View.VISIBLE);
        verify(banner).setText(host.stopFailure);
    }

    @Test public void unverifiedSurfaceDoesNotAssumeCachedWorkspaceWasReady() {
        loseContact(); render(false); assertStartAvailable();
    }

    @Test public void pairingProgressAndErrorsRemainVisibleForReadyWorkspace() throws Exception {
        confirm("ready"); pairing.waiting = true; render(true);
        verify(banner).setVisibility(View.VISIBLE);
        pairing.fail("Synthetic pairing failed"); render(true);
        verify(banner).setVisibility(View.VISIBLE);
        verify(banner).setText(pairing.error);
    }
}
