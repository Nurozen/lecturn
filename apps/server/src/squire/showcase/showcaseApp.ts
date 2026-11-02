/**
 * What `McpAppRequests` needs to route a showcase card: kept apart from
 * `SquireMcpAppRoute`, which is built with the switch, so the orchestration
 * runtime imports no Squire services.
 */
import type {
  McpAppCallToolResult,
  McpAppReadResourceResult,
  McpAppRequestError,
  McpAppToolInfo,
  ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import type { McpAppReference } from "@lecturn/shared/mcpApp";
import { LECTURN_MCP_APP_SERVER } from "@lecturn/shared/toolOutput";
import type * as Effect from "effect/Effect";

export const SQUIRE_SHOWCASE_TOOL = "squire_publish_showcase";
/** Names the captured document only: the tool declares no `resourceUri` and /mcp serves none (R54). */
export const SQUIRE_SHOWCASE_RESOURCE_URI = "ui://lecturn/squire/showcase";
export const SQUIRE_CARD_ACCEPT_TOOL = "squire_card_accept";
export const SQUIRE_CARD_DISMISS_TOOL = "squire_card_dismiss";

export const isSquireShowcaseApp = (app: McpAppReference) =>
  app.server === LECTURN_MCP_APP_SERVER && app.tool === SQUIRE_SHOWCASE_TOOL;

export interface SquireShowcaseCard {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly app: McpAppReference;
  /** The publish call's recorded output, which names the items the page shows. */
  readonly output: unknown;
}

export interface SquireMcpAppRoute {
  readonly toolInfo: (
    input: SquireShowcaseCard & { readonly name: string },
  ) => Effect.Effect<McpAppToolInfo, McpAppRequestError>;
  readonly callTool: (
    input: SquireShowcaseCard & {
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    },
  ) => Effect.Effect<McpAppCallToolResult, McpAppRequestError>;
  readonly readResource: (
    input: SquireShowcaseCard & { readonly uri: string },
  ) => Effect.Effect<McpAppReadResourceResult, McpAppRequestError>;
}
