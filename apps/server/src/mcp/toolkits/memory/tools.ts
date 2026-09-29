import { MemoryDemoError, MemoryNodeType } from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

export const MemoryQueryParameters = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
    description:
      "Keywords describing what you want to know, e.g. 'stripe webhook retry idempotency'. Lexical match, so use the words the code and docs would use.",
  }),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
      description: "Maximum hits to return, 1 to 20. Defaults to 8.",
    }),
  ),
});
export type MemoryQueryParameters = typeof MemoryQueryParameters.Type;

export const MemoryWriteParameters = Schema.Struct({
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)).annotate({
    description:
      "One self-contained sentence stating the fact, e.g. 'Stripe webhook handlers must be idempotent on event.id because Stripe retries for up to 3 days.'",
  }),
  context: Schema.optional(
    Schema.String.check(Schema.isMaxLength(2000)).annotate({
      description: "Optional supporting detail: why it holds, where it bit, what to do instead.",
    }),
  ),
  type: Schema.optional(
    MemoryNodeType.annotate({
      description:
        "What the fact is about. Use 'decision' for choices and conventions, 'concept' for how something works. Defaults to 'concept'.",
    }),
  ),
  tags: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(64)))
      .check(Schema.isMaxLength(8))
      .annotate({ description: "Up to 8 short lowercase keywords that aid recall." }),
  ),
  sourcePath: Schema.optional(
    Schema.String.check(Schema.isMaxLength(1024)).annotate({
      description: "Repository-relative path the fact is anchored to, if any.",
    }),
  ),
});
export type MemoryWriteParameters = typeof MemoryWriteParameters.Type;

/** Plain text for the agent; registration sends it verbatim rather than as JSON. */
const MemoryToolText = Schema.String;

export const MemoryQueryTool = Tool.make("memory_query", {
  description:
    "Search shared project memory: the warren (reviewed knowledge from every project, read-only) plus this project's den (facts recorded but not yet reviewed). Query before exploring unfamiliar code; a hit can save a long search. Returns ranked hits with node id, scope, and summary.",
  parameters: MemoryQueryParameters,
  success: MemoryToolText,
  failure: MemoryDemoError,
  dependencies,
})
  .annotate(Tool.Title, "Recall project memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MemoryWriteTool = Tool.make("memory_write", {
  description:
    "Record one lasting fact about this codebase into the project's den: a decision, convention, gotcha, or how a subsystem works. Not a work log; skip what you did this session and anything obvious from the code. Warren nodes are read-only; the den is reviewed by a human before it lands in the warren. One fact per call.",
  parameters: MemoryWriteParameters,
  success: MemoryToolText,
  failure: MemoryDemoError,
  dependencies,
})
  .annotate(Tool.Title, "Record project memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const MemoryToolkit = Toolkit.make(MemoryQueryTool, MemoryWriteTool);
