/**
 * A showcase card is authorized by the item ids its own publish call recorded, never by the thread it is shown in.
 * Its two tools are app-only and exist only here, never on /mcp, so no agent can call them. Each acts as the user
 * after the client's confirm and the Operate scope `mcpApps.callTool` requires.
 */
import {
  McpAppRequestError,
  SquireCardId,
  type McpAppCallToolResult,
  type ThreadId,
} from "@lecturn/contracts";
import { readMcpAppToolOutcome } from "@lecturn/shared/mcpApp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { AppRuntimeState } from "../apps/AppRuntimeState.ts";
import * as SquireActions from "./SquireActions.ts";
import * as SquireRepository from "./SquireRepository.ts";
import {
  SQUIRE_CARD_ACCEPT_TOOL,
  SQUIRE_CARD_DISMISS_TOOL,
  type SquireMcpAppRoute,
  type SquireShowcaseCard,
} from "./showcase/showcaseApp.ts";

const cardTool = (name: string, title: string, description: string) => ({
  name,
  title,
  description,
  inputSchema: {
    type: "object",
    properties: { cardId: { type: "string", description: "An item the showcase shows." } },
    required: ["cardId"],
    additionalProperties: false,
  },
  _meta: { ui: { visibility: ["app"] } },
});

const TOOLS = {
  [SQUIRE_CARD_ACCEPT_TOOL]: {
    action: "accept",
    tool: cardTool(SQUIRE_CARD_ACCEPT_TOOL, "Accept item", "Accept a Squire item, as the user."),
  },
  [SQUIRE_CARD_DISMISS_TOOL]: {
    action: "dismiss",
    tool: cardTool(SQUIRE_CARD_DISMISS_TOOL, "Dismiss item", "Dismiss a Squire item, as the user."),
  },
} as const;

const toolOf = (name: string) =>
  Object.hasOwn(TOOLS, name) ? TOOLS[name as keyof typeof TOOLS] : undefined;

const decodeCardId = Schema.decodeUnknownOption(SquireCardId);

/** The ids the publish call put in its result (`SquireShowcase`). */
const shownItemIds = (output: unknown): ReadonlySet<string> => {
  const result = readMcpAppToolOutcome(output).result;
  const structured = Predicate.isObject(result) ? result.structuredContent : undefined;
  const showcase = Predicate.isObject(structured) ? structured.showcase : undefined;
  const ids = Predicate.isObject(showcase) ? showcase.itemIds : undefined;
  return new Set(
    Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
  );
};

const text = (
  value: string,
  structuredContent: Record<string, unknown>,
  isError = false,
): McpAppCallToolResult => ({
  content: [{ type: "text", text: value }],
  structuredContent,
  ...(isError ? { isError: true } : {}),
});

const outdated = (cardId: string, status: string) =>
  text("This item is no longer open.", { cardId, status, outdated: true });

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const actions = yield* SquireActions.SquireActions;

  const fail = (threadId: ThreadId, reason: McpAppRequestError["reason"], cause?: unknown) =>
    new McpAppRequestError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  const toolInfo: SquireMcpAppRoute["toolInfo"] = (input) => {
    const found = toolOf(input.name);
    return Effect.succeed(
      found === undefined
        ? { callable: false, readOnly: false }
        : { callable: true, readOnly: false, title: found.tool.title, tool: found.tool },
    );
  };

  // The document is the captured attachment; the page reads nothing else.
  const readResource: SquireMcpAppRoute["readResource"] = (input) =>
    Effect.fail(fail(input.threadId, "not-an-app"));

  const act = Effect.fn("SquireMcpAppRoute.act")(function* (
    card: SquireShowcaseCard,
    action: "accept" | "dismiss",
    cardId: SquireCardId,
  ) {
    const found = yield* repository.getCard(cardId);
    if (Option.isNone(found)) return outdated(cardId, "missing");
    const row = found.value;
    // Re-read at the click: the page is a snapshot and may be days old.
    if (row.status !== "open") return outdated(cardId, row.status);
    const owner = yield* repository.getSquire(row.owner_squire_id);
    if (Option.isNone(owner) || owner.value.lifecycle === "deleting") {
      return text("This item's Squire no longer exists.", { cardId }, true);
    }
    const { results } = yield* actions.act({
      // Deterministic, so a retried click is the same request.
      requestId: `showcase:${action}:${cardId}:${card.itemId}`.slice(0, 200),
      cardIds: [cardId],
      action,
    });
    const outcome = results[0];
    if (outcome === undefined) return text("Nothing happened.", { cardId }, true);
    if (outcome.error !== null) {
      const again = yield* repository.getCard(cardId);
      if (Option.isSome(again) && again.value.status !== "open") {
        return outdated(cardId, again.value.status);
      }
      return text(outcome.error.message, { cardId, status: outcome.status }, true);
    }
    return text(action === "accept" ? "Accepted." : "Dismissed.", {
      cardId,
      status: action === "accept" ? "accepted" : outcome.status,
    });
  });

  const callTool: SquireMcpAppRoute["callTool"] = Effect.fn("SquireMcpAppRoute.callTool")(
    function* (input) {
      const found = toolOf(input.name);
      if (found === undefined) return yield* fail(input.threadId, "tool-not-callable");
      const cardId = decodeCardId(input.arguments.cardId);
      if (Option.isNone(cardId) || !shownItemIds(input.output).has(cardId.value)) {
        return text("This showcase does not show that item.", {}, true);
      }
      return yield* act(input, found.action, cardId.value).pipe(
        Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)),
      );
    },
  );

  return { toolInfo, callTool, readResource } satisfies SquireMcpAppRoute;
});

/** Publishes the route for `McpAppRequests`, which is built below the Squire layer. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { squireMcpAppRoute } = yield* AppRuntimeState;
    const route = yield* make;
    yield* Effect.acquireRelease(Ref.set(squireMcpAppRoute, Option.some(route)), () =>
      Ref.set(squireMcpAppRoute, Option.none()),
    );
  }),
);
