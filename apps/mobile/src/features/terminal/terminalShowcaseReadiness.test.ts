import {
  applyTerminalAttachStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
} from "@lecturn/client-runtime/state/terminal";
import { describe, expect, it } from "vite-plus/test";

import { hasTerminalSceneContent } from "./terminalShowcaseReadiness";

const streamed = applyTerminalAttachStreamEvent(
  EMPTY_TERMINAL_BUFFER_STATE,
  { type: "output", threadId: "thread", terminalId: "term-1", data: "$ ls\r\nREADME.md\r\n" },
  1024,
).output;
const empty = EMPTY_TERMINAL_BUFFER_STATE.output;

describe("hasTerminalSceneContent", () => {
  it("counts streamed output when the native surface leaves the buffer unmaterialized", () => {
    expect(hasTerminalSceneContent({ version: 1, buffer: "", output: streamed })).toBe(true);
  });

  it("counts a materialized buffer for the text fallback", () => {
    expect(hasTerminalSceneContent({ version: 1, buffer: "$ ", output: empty })).toBe(true);
  });

  it("waits for the first attach snapshot and for any output", () => {
    expect(hasTerminalSceneContent({ version: 0, buffer: "", output: streamed })).toBe(false);
    expect(hasTerminalSceneContent({ version: 0, buffer: "$ ", output: streamed })).toBe(false);
    expect(hasTerminalSceneContent({ version: 1, buffer: "", output: empty })).toBe(false);
  });
});
