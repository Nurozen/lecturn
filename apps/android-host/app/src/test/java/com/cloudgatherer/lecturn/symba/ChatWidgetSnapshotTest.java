package com.cloudgatherer.lecturn.symba;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class ChatWidgetSnapshotTest {
    private JSONObject payload() throws Exception {
        return new JSONObject().put("threadId", "thread-1").put("title", "Plan")
                .put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("text", "Question"))
                        .put(new JSONObject().put("role", "assistant").put("text", "Answer\nNext line")));
    }
    @Test public void rendersConversationWithSpeakerAndNewlines() throws Exception {
        ChatWidgetSnapshot state = ChatWidgetSnapshot.parse(payload());
        assertEquals("thread-1", state.threadId);
        assertEquals(java.util.List.of("You: Question", "Agent: Answer\nNext line"), state.messages);
    }
    @Test public void rejectsToolReasoningAndOversizePayloads() throws Exception {
        for (String role : new String[]{"tool", "system", "reasoning", "assistant "}) {
            JSONObject value = payload(); value.getJSONArray("messages").getJSONObject(0).put("role", role);
            assertThrows(JSONException.class, () -> ChatWidgetSnapshot.parse(value));
        }
        JSONObject huge = payload(); huge.getJSONArray("messages").getJSONObject(0).put("text", "x".repeat(501));
        assertThrows(JSONException.class, () -> ChatWidgetSnapshot.parse(huge));
        JSONObject many = payload();
        for (int i = 0; i < 5; i++) many.getJSONArray("messages").put(new JSONObject().put("role", "user").put("text", "x"));
        assertThrows(JSONException.class, () -> ChatWidgetSnapshot.parse(many));
    }
    @Test public void rejectsCoercedTypesAndEmptyThread() throws Exception {
        for (Object id : new Object[]{4, JSONObject.NULL, "", " ", "x".repeat(257)}) {
            JSONObject value = payload().put("threadId", id);
            assertThrows(JSONException.class, () -> ChatWidgetSnapshot.parse(value));
        }
        assertThrows(JSONException.class, () -> ChatWidgetSnapshot.parse("{}"));
    }
}
