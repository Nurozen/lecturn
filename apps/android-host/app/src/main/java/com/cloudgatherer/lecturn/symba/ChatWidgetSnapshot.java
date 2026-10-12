package com.cloudgatherer.lecturn.symba;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Only user-visible text, bounded before crossing into launcher RemoteViews. */
final class ChatWidgetSnapshot {
    final String threadId, title;
    final java.util.List<String> messages;
    private ChatWidgetSnapshot(String threadId, String title, java.util.List<String> messages) {
        this.threadId = threadId; this.title = title; this.messages = java.util.List.copyOf(messages);
    }
    static ChatWidgetSnapshot parse(Object payload) throws JSONException {
        if (!(payload instanceof JSONObject)) throw new JSONException("Invalid widget snapshot");
        JSONObject value = (JSONObject) payload;
        String thread = text(value.opt("threadId"), 256), title = text(value.opt("title"), 100);
        if (thread.trim().isEmpty()) throw new JSONException("Missing thread");
        Object items = value.opt("messages");
        if (!(items instanceof JSONArray) || ((JSONArray) items).length() > 6) throw new JSONException("Invalid messages");
        JSONArray messages = (JSONArray) items;
        java.util.List<String> lines = new java.util.ArrayList<>();
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.getJSONObject(i);
            Object role = message.opt("role");
            if (!"user".equals(role) && !"assistant".equals(role)) throw new JSONException("Invalid role");
            lines.add(("user".equals(role) ? "You: " : "Agent: ") + text(message.opt("text"), 500));
        }
        return new ChatWidgetSnapshot(thread, title, lines);
    }
    private static String text(Object value, int max) throws JSONException {
        if (!(value instanceof String) || ((String) value).length() > max) throw new JSONException("Invalid text");
        return ((String) value).replaceAll("[\\p{Cntrl}&&[^\\n\\t]]", "");
    }
}
