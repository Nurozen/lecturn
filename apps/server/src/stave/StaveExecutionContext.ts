import * as Context from "effect/Context";
import type { StaveBinaryResolution } from "./StaveBinary.ts";

export interface StaveExecutionSnapshot {
  readonly binary: StaveBinaryResolution;
  readonly configPath: string;
  readonly configurationIdentity?: string;
  readonly sourceConfigPath: string;
}

/** Fiber-local binding shared by preflight, CLI calls and reconciliation. */
export const StaveExecutionContext = Context.Reference<StaveExecutionSnapshot | undefined>(
  "lecturn/stave/StaveExecutionContext",
  { defaultValue: () => undefined },
);
