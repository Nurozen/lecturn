package com.cloudgatherer.lecturn.symba;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import org.json.JSONObject;

public final class ChatWidget extends AppWidgetProvider {
    // No conversation or credential is persisted by the host; republish after process restart.
    private static volatile ChatWidgetSnapshot snapshot;
    private static String snapshotUrl;
    static boolean publish(Context context, Object payload, String url) {
        try {
            if (payload != null && payload != JSONObject.NULL && !OriginPolicy.isStateUrl(url)) return false;
            snapshot = payload == null || payload == JSONObject.NULL ? null : ChatWidgetSnapshot.parse(payload);
            snapshotUrl = snapshot == null ? null : url;
            refresh(context); return true;
        } catch (org.json.JSONException ignored) { return false; }
    }
    static String selectedUrl() { return snapshotUrl; }
    static java.util.List<String> messages() {
        ChatWidgetSnapshot current = snapshot;
        return current == null ? java.util.List.of("Open a conversation in Lecturn to see its latest messages here.")
                : current.messages.isEmpty() ? java.util.List.of("No messages yet. Reply to start this conversation.") : current.messages;
    }
    static RemoteViews row(Context context, String text) {
        RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.chat_widget_message);
        row.setTextViewText(R.id.widget_message, text);
        return row;
    }
    static void clear(Context context) { snapshot = null; snapshotUrl = null; refresh(context); }
    private static void refresh(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        render(context, manager, manager.getAppWidgetIds(new ComponentName(context, ChatWidget.class)));
    }
    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) { render(context, manager, ids); }
    private static void render(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.chat_widget);
            views.setTextViewText(R.id.widget_title, snapshot == null ? "Lecturn chat" : snapshot.title);
            if (android.os.Build.VERSION.SDK_INT >= 31) {
                RemoteViews.RemoteCollectionItems.Builder items = new RemoteViews.RemoteCollectionItems.Builder()
                        .setViewTypeCount(1);
                java.util.List<String> messages = messages();
                for (int i = 0; i < messages.size(); i++) items.addItem(i, row(context, messages.get(i)));
                views.setRemoteAdapter(R.id.widget_messages, items.build());
            } else {
                Intent adapter = new Intent(context, ChatWidgetService.class)
                        .setData(android.net.Uri.parse("lecturn-widget://messages/" + id));
                views.setRemoteAdapter(R.id.widget_messages, adapter);
            }
            views.setTextViewText(R.id.widget_status, snapshot == null ? "Waiting for Lecturn" : "Recent messages · Reply opens floating chat");
            views.setOnClickPendingIntent(R.id.widget_open, entry(context, id * 2, Intent.ACTION_MAIN));
            views.setOnClickPendingIntent(R.id.widget_reply, entry(context, id * 2 + 1, MainActivity.COMPOSE));
            manager.updateAppWidget(id, views);
            if (android.os.Build.VERSION.SDK_INT < 31) manager.notifyAppWidgetViewDataChanged(id, R.id.widget_messages);
        }
    }
    private static PendingIntent entry(Context context, int code, String action) {
        // Explicit, immutable, credential-free entry. Reply focuses the authenticated host;
        // it does not contain a message and never initiates an agent turn.
        return PendingIntent.getActivity(context, code, new Intent(context, MainActivity.class).setAction(action)
                        .putExtra("widget_thread_url", snapshotUrl)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
