/**
 * Wraps an app tool result for MCP Apps cards: the last step of
 * AppToolkit.call, after Lecturn's own `_meta` handling.
 *
 * A tool that declares `_meta.ui.resourceUri` gets its card document captured
 * into an attachment now, while the app can still serve it, and the result
 * carries `structuredContent: { lecturnMcpApp, result }`. That is the envelope
 * every client already reads from tool output, so the card shows on every
 * provider and survives the app closing, the thread stopping and a copy.
 */
import type { AppId } from "@lecturn/contracts";
import {
  MCP_APP_CANCELLED_KEY,
  MCP_APP_OUTPUT_KEY,
  readMcpAppResourceUri,
} from "@lecturn/shared/mcpApp";
import { LECTURN_MCP_APP_SERVER, omitToolOutputImageData } from "@lecturn/shared/toolOutput";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import {
  AppRegistryService,
  type AppToolCallRequest,
  type AppToolTier,
} from "../../../apps/services.ts";
import { ServerConfig } from "../../../config.ts";
import * as AppMcpAppRoute from "../../../mcpApps/AppMcpAppRoute.ts";
import { snapshotMcpApp } from "../../../mcpApps/McpAppSnapshot.ts";
import type { McpAppInvocationScope } from "../../McpInvocationContext.ts";

// Reading the document is one MCP round trip; an app that hangs must not hold
// the agent's call open (the Codex capture uses the same bound).
const CAPTURE_TIMEOUT = "20 seconds";

export interface AppCardEnvelopeInput {
  readonly scope: McpAppInvocationScope;
  readonly appId: AppId;
  readonly tier: AppToolTier;
  /** As the app declared it: unprefixed, `_meta` intact. */
  readonly tool: McpSchema.Tool;
  readonly request: AppToolCallRequest;
  readonly result: McpSchema.CallToolResult;
  /**
   * Set when Lecturn refused the call (declined, cancelled or expired
   * approval, or a Read-only ceiling): the card still shows, and is told the
   * call was cancelled instead of given a result.
   */
  readonly refusal?: string;
}

export type WrapAppToolResult = (
  input: AppCardEnvelopeInput,
) => Effect.Effect<McpSchema.CallToolResult>;

const encodeResult = Schema.encodeSync(McpSchema.CallToolResult);
// The snapshot reads resources as they travel: a blob is still base64 there.
const encodeRead = Schema.encodeSync(McpSchema.ReadResourceResult);

export const make = Effect.gen(function* () {
  // AppToolkit builds this once per AppsLayer, which is what the route needs.
  yield* AppMcpAppRoute.register;
  const registry = yield* AppRegistryService;
  const readAppResource = yield* AppMcpAppRoute.makeAppResourceReader;
  const { attachmentsDir } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;

  const capture = (input: AppCardEnvelopeInput, resourceUri: string) =>
    Effect.gen(function* () {
      const record = yield* registry.get(input.appId);
      if (Option.isNone(record)) return undefined;
      const { registration } = record.value;
      const read = yield* readAppResource(registration, input.scope.app.projectId, resourceUri);
      if (Option.isNone(read)) return undefined;
      return yield* snapshotMcpApp({
        attachmentsDir,
        threadId: input.scope.thread.threadId,
        server: LECTURN_MCP_APP_SERVER,
        tool: `${registration.toolPrefix}_${input.tool.name}`,
        resourceUri,
        contents: encodeRead(read.value).contents,
      });
    }).pipe(
      Effect.timeout(CAPTURE_TIMEOUT),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      // A card that cannot be captured leaves a plain tool row, never a failed call.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("Could not capture a connected-app card; showing a plain tool row.", {
            appId: input.appId,
            tool: input.tool.name,
            resourceUri,
            cause,
          }).pipe(Effect.as(undefined)),
      ),
      Effect.orDie,
    );

  const wrap: WrapAppToolResult = (input) =>
    Effect.gen(function* () {
      const resourceUri = readMcpAppResourceUri(input.tool._meta);
      // A failed call has no output for its card to show; a refused one is
      // still shown, as cancelled.
      if (
        resourceUri === undefined ||
        (input.result.isError === true && input.refusal === undefined)
      ) {
        return input.result;
      }
      const reference = yield* capture(input, resourceUri);
      if (reference === undefined) return input.result;
      const { _meta: _ignored, ...result } = encodeResult(input.result);
      return new McpSchema.CallToolResult({
        content: input.result.content,
        ...(input.result.isError === undefined ? {} : { isError: input.result.isError }),
        ...(input.result._meta === undefined ? {} : { _meta: input.result._meta }),
        structuredContent: {
          [MCP_APP_OUTPUT_KEY]: reference,
          // No reader gets this copy's image bytes (storage keeps only the
          // top-level ones), and carried twice an image can push the result
          // past Codex's 1 MiB limit, where Codex keeps only its head and tail.
          ...(input.refusal === undefined
            ? { result: omitToolOutputImageData(result) }
            : { [MCP_APP_CANCELLED_KEY]: { reason: input.refusal } }),
        },
      });
    });

  return wrap;
});
