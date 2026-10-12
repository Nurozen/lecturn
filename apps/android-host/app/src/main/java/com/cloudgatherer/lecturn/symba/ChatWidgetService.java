package com.cloudgatherer.lecturn.symba;

import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

/** Collection fallback for Android 10/11; newer hosts receive the bounded rows directly. */
public final class ChatWidgetService extends RemoteViewsService {
    @Override public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new RemoteViewsFactory() {
            private java.util.List<String> messages = java.util.List.of();
            @Override public void onCreate() { onDataSetChanged(); }
            @Override public void onDataSetChanged() { messages = ChatWidget.messages(); }
            @Override public void onDestroy() { messages = java.util.List.of(); }
            @Override public int getCount() { return messages.size(); }
            @Override public RemoteViews getViewAt(int position) {
                return position < 0 || position >= messages.size() ? null : ChatWidget.row(ChatWidgetService.this, messages.get(position));
            }
            @Override public RemoteViews getLoadingView() { return null; }
            @Override public int getViewTypeCount() { return 1; }
            @Override public long getItemId(int position) { return position; }
            @Override public boolean hasStableIds() { return false; }
        };
    }
}
