import {
  applyTerminalAttachStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
} from "@lecturn/client-runtime/state/terminal";
import { describe, expect, it } from "vite-plus/test";

import { hasTerminalReplayContent } from "./terminalBufferReplay";

const streamed = applyTerminalAttachStreamEvent(
  EMPTY_TERMINAL_BUFFER_STATE,
  { type: "output", threadId: "thread", terminalId: "term-1", data: "$ ls\r\nREADME.md\r\n" },
  1024,
).output;
const empty = EMPTY_TERMINAL_BUFFER_STATE.output;

describe("hasTerminalReplayContent", () => {
  it("counts streamed output when the native surface leaves the buffer unmaterialized", () => {
    expect(
      hasTerminalReplayContent({
        buffer: "",
        output: streamed,
        replayKey: "k",
        readyReplayKey: "k",
      }),
    ).toBe(true);
  });

  it("counts a materialized buffer for the text fallback", () => {
    expect(
      hasTerminalReplayContent({
        buffer: "$ ",
        output: empty,
        replayKey: "k",
        readyReplayKey: "k",
      }),
    ).toBe(true);
  });

  it("waits for the replay key and for any output", () => {
    expect(
      hasTerminalReplayContent({
        buffer: "",
        output: streamed,
        replayKey: "k",
        readyReplayKey: null,
      }),
    ).toBe(false);
    expect(
      hasTerminalReplayContent({
        buffer: "",
        output: streamed,
        replayKey: "k",
        readyReplayKey: "j",
      }),
    ).toBe(false);
    expect(
      hasTerminalReplayContent({ buffer: "", output: empty, replayKey: "k", readyReplayKey: "k" }),
    ).toBe(false);
  });
});
