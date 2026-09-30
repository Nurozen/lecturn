import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { AiError, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { MemoryDemoError } from "@lecturn/contracts";

import { ServerConfig } from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MemoryToolkitHandlersLive } from "./handlers.ts";
import { MemoryToolkit } from "./tools.ts";

const textResult = (text: string, isError: boolean) =>
  new McpSchema.CallToolResult({ isError, content: [{ type: "text", text }] });

const isMemoryDemoError = Schema.is(MemoryDemoError);

/** Handler failures become agent-readable error text; defects stay opaque. */
const failureResult = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause)) return Effect.failCause(cause).pipe(Effect.orDie);
  const error = cause.reasons.find(Cause.isFailReason)?.error;
  if (isMemoryDemoError(error)) return Effect.succeed(textResult(error.message, true));
  if (AiError.isAiError(error) && error.reason._tag === "ToolParameterValidationError") {
    return Effect.succeed(textResult(error.reason.message, true));
  }
  return Effect.logWarning("memory tool failed", { cause }).pipe(
    Effect.as(textResult("Memory tool failed due to an internal server error.", true)),
  );
};

/**
 * Registers the memory tools so their string results reach the agent as plain
 * text. `McpServer.toolkit` would JSON-encode them into one quoted line.
 */
const registerMemoryTools = Effect.fn("McpHttpServer.registerMemoryTools")(function* () {
  const server = yield* McpServer.McpServer;
  const built = yield* MemoryToolkit;
  for (const tool of Object.values(built.tools)) {
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) =>
          built.handle(tool.name, payload).pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              Context.getUnsafe(fiber.context, McpInvocationContext.McpInvocationContext),
            ),
            Effect.matchCauseEffect({
              onFailure: failureResult,
              onSuccess: ({ result }) => Effect.succeed(textResult(String(result), false)),
            }),
          ),
        ),
    });
  }
});

const MemoryToolsLive = Layer.effectDiscard(registerMemoryTools()).pipe(
  Layer.provide(MemoryToolkitHandlersLive),
);

/** `memory_query` and `memory_write`, only when the server runs with
    `memoryDemoEnabled`; otherwise no memory tools are listed. */
export const MemoryToolkitRegistrationLive = Layer.unwrap(
  ServerConfig.pipe(
    Effect.map((config) => (config.memoryDemoEnabled === true ? MemoryToolsLive : Layer.empty)),
  ),
);
