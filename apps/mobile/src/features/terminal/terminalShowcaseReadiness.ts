import type { TerminalOutputState } from "@lecturn/client-runtime/state/terminal";

/** Waits for the first attach snapshot; streaming native surfaces never materialize `buffer`. */
export function hasTerminalSceneContent(input: {
  readonly version: number;
  readonly buffer: string;
  readonly output: TerminalOutputState;
}): boolean {
  if (input.version === 0) return false;
  return input.buffer.length > 0 || input.output.retainedBytes > 0;
}
