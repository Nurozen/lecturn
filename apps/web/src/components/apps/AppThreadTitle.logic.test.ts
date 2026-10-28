import { describe, expect, it } from "vite-plus/test";

import { appThreadTitleRowId } from "./AppThreadTitle.logic";

const opening = { id: "m-1", kind: "message", message: { role: "user" } };
const reply = { id: "m-2", kind: "message", message: { role: "assistant" } };
const loaded = { hasMoreHistory: false, error: null };

describe("appThreadTitleRowId", () => {
  it("sets the title beside the thread's opening message", () => {
    expect(
      appThreadTitleRowId({
        rows: [opening, reply],
        historyControls: loaded,
        importHistoryTruncated: false,
      }),
    ).toBe("m-1");
    expect(appThreadTitleRowId({ rows: [opening], importHistoryTruncated: false })).toBe("m-1");
  });

  it("keeps the title above when the first row is not a user message", () => {
    expect(appThreadTitleRowId({ rows: [reply, opening], importHistoryTruncated: false })).toBe(
      null,
    );
    expect(
      appThreadTitleRowId({
        rows: [{ id: "setup", kind: "worktree-setup" }, opening],
        importHistoryTruncated: false,
      }),
    ).toBe(null);
    expect(appThreadTitleRowId({ rows: [], importHistoryTruncated: false })).toBe(null);
  });

  it("keeps the title above while earlier history is unloaded or cut", () => {
    expect(
      appThreadTitleRowId({
        rows: [opening],
        historyControls: { hasMoreHistory: true, error: null },
        importHistoryTruncated: false,
      }),
    ).toBe(null);
    expect(
      appThreadTitleRowId({
        rows: [opening],
        historyControls: { hasMoreHistory: false, error: "Could not load" },
        importHistoryTruncated: false,
      }),
    ).toBe(null);
    expect(appThreadTitleRowId({ rows: [opening], importHistoryTruncated: true })).toBe(null);
  });
});
