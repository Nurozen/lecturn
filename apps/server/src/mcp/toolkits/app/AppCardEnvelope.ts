/**
 * Wraps an app tool result for MCP Apps cards (D3): the last step of
 * AppToolkit.call, after Lecturn's own `_meta` handling.
 *
 * Stub until A21 builds the envelope: results pass through unchanged.
 */
import type { AppId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import type { McpSchema } from "effect/ai";

import type { AppToolCallRequest, AppToolTier } from "../../../apps/services.ts";
import type { McpAppInvocationScope } from "../../McpInvocationContext.ts";

export interface AppCardEnvelopeInput {
  readonly scope: McpAppInvocationScope;
  readonly appId: AppId;
  readonly tier: AppToolTier;
  /** As the app declared it: unprefixed, `_meta` intact. */
  readonly tool: McpSchema.Tool;
  readonly request: AppToolCallRequest;
  readonly result: McpSchema.CallToolResult;
}

export type WrapAppToolResult = (
  input: AppCardEnvelopeInput,
) => Effect.Effect<McpSchema.CallToolResult>;

export const make = Effect.succeed<WrapAppToolResult>(({ result }) => Effect.succeed(result));
