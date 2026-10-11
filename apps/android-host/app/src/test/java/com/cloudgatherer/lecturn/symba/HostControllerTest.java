package com.cloudgatherer.lecturn.symba;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

public final class HostControllerTest {
    @Test public void stopClearsBackgroundConversationWithoutActivityListeners() throws Exception {
        assertStopClearsWidget(false);
    }

    @Test public void stopClearsImmediatelyWhileWaitingForAnInFlightControlRequest() throws Exception {
        assertStopClearsWidget(true);
    }

    private void assertStopClearsWidget(boolean busy) throws Exception {
        Context context = mock(Context.class);
        when(context.getApplicationContext()).thenReturn(context);
        AppWidgetManager manager = mock(AppWidgetManager.class);
        when(manager.getAppWidgetIds(any(ComponentName.class))).thenReturn(new int[0]);
        ExecutorService io = mock(ExecutorService.class);
        try (var loopers = mockStatic(Looper.class);
             var clock = mockStatic(SystemClock.class);
             var handlers = mockConstruction(Handler.class);
             var components = mockConstruction(ComponentName.class);
             var widgets = mockStatic(AppWidgetManager.class);
             var executors = mockStatic(Executors.class)) {
            widgets.when(() -> AppWidgetManager.getInstance(context)).thenReturn(manager);
            executors.when(Executors::newSingleThreadExecutor).thenReturn(io);
            HostController controller = new HostController(context);
            String url = "http://127.0.0.1:3773/local/thread";
            assertTrue(ChatWidget.publish(context, new JSONObject()
                    .put("threadId", "thread").put("title", "Synthetic chat")
                    .put("messages", new org.json.JSONArray().put(new JSONObject()
                            .put("role", "user").put("text", "Private synthetic message"))), url));
            assertEquals(url, ChatWidget.selectedUrl());
            assertTrue(ChatWidget.messages().get(0).contains("Private synthetic message"));
            controller.busy = busy;
            controller.stop();
            assertTrue(controller.stopping);
            assertNull(ChatWidget.selectedUrl());
            assertEquals(List.of("Open a conversation in Lecturn to see its latest messages here."), ChatWidget.messages());
            if (busy) verifyNoInteractions(io);
            else verify(io).execute(any(Runnable.class));
        }
    }
}
