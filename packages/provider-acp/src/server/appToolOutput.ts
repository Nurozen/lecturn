import { claimServedAppToolResult } from "@lecturn/shared/appToolResults";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isMcpToolResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    (Array.isArray(value.content) || value.structuredContent != null || isRecord(value._meta))
  );
}

/** The provider's own report carries an MCP result: `{ content, … }`, or one under `result`. */
function reportsMcpToolResult(output: unknown): boolean {
  return isMcpToolResult(output) || (isRecord(output) && isMcpToolResult(output.result));
}

/**
 * The raw output of an MCP call on Lecturn's own server. When the agent ends
 * the call without its MCP result (Grok reports text content, or nothing), the
 * result Lecturn served for it stands in, under `result` as ACP agents report
 * one, so an app tool row keeps its card and summary.
 */
export function acpLecturnMcpToolRawOutput(input: {
  readonly threadId: string;
  readonly callId: string;
  readonly server: string;
  readonly tool: string;
  /** The call's arguments as the agent reported them, if it did. */
  readonly args: unknown;
  readonly status: string;
  readonly startedAtMillis: number;
  readonly nowMillis: number;
  readonly rawOutput: unknown;
}): unknown {
  if (
    !/^lecturn$/i.test(input.server) ||
    (input.status !== "completed" && input.status !== "failed") ||
    reportsMcpToolResult(input.rawOutput)
  ) {
    return input.rawOutput;
  }
  const served = claimServedAppToolResult(
    {
      threadId: input.threadId,
      tool: input.tool,
      args: input.args,
      callId: input.callId,
      startedAt: input.startedAtMillis,
    },
    input.nowMillis,
  );
  return served === undefined ? input.rawOutput : { result: served };
}

/** Where ACP agents put an MCP call's arguments: the call itself, or Grok's `tool_input`. */
export function acpMcpToolCallArgs(
  identityInput: unknown,
  rawInput: Readonly<Record<string, unknown>> | undefined,
): unknown {
  if (identityInput !== undefined) return identityInput;
  if (isRecord(rawInput?.arguments)) return rawInput.arguments;
  if (isRecord(rawInput?.tool_input)) return rawInput.tool_input;
  return undefined;
}
