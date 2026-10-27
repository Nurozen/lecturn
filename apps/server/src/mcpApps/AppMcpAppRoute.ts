/**
 * Requests from connected-app cards (D3): `McpAppRequests` hands every card
 * whose server is Lecturn's own here. The app serves them, headless first and
 * then live, so cards keep working in stopped, non-Codex and copied threads,
 * none of which has a provider session that could.
 *
 * A card's `tools/call` is gated exactly like the agent's: same gate, same
 * approval, same `_meta`. Cards know their app's tools by bare name, the agent
 * by prefixed name; both are accepted.
 */
import {
  APP_TOOL_APPROVAL_META_KEY,
  APP_TOOL_APPROVAL_REQUIRED_META_KEY,
  APP_TOOL_CONTEXT_META_KEY,
  type AppId,
  type AppRegistration,
  type AppToolApprovalMeta,
  type AppToolContextMeta,
  type McpAppCallToolResult,
  McpAppRequestError,
  type McpAppReadResourceResult,
  type McpAppToolInfo,
  type OrchestrationV2AppThread,
  type ProjectId,
  type ThreadId,
} from "@lecturn/contracts";
import { expandAppOpenUrl } from "@lecturn/shared/appReferences";
import {
  MCP_APP_OUTPUT_KEY,
  mcpAppToolCallableByApp,
  type McpAppReference,
} from "@lecturn/shared/mcpApp";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import { refusalMessage } from "../apps/AppToolApprovalService.ts";
import * as AppToolGate from "../apps/AppToolGate.ts";
import { AppRuntimeState } from "../apps/AppRuntimeState.ts";
import {
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  type AppsFailure,
  AppToolApprovalService,
  type AppToolCallRequest,
  type AppToolTier,
  HeadlessToolHost,
  LiveToolClient,
} from "../apps/services.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";

interface CardTarget {
  readonly threadId: ThreadId;
  readonly app: McpAppReference;
}

export interface AppMcpAppRoute {
  readonly toolInfo: (
    input: CardTarget & { readonly name: string },
  ) => Effect.Effect<McpAppToolInfo, McpAppRequestError>;
  readonly callTool: (
    input: CardTarget & {
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    },
  ) => Effect.Effect<McpAppCallToolResult, McpAppRequestError>;
  readonly readResource: (
    input: CardTarget & { readonly uri: string },
  ) => Effect.Effect<McpAppReadResourceResult, McpAppRequestError>;
}

const encodeTool = Schema.encodeSync(McpSchema.Tool);
const encodeCallResult = Schema.encodeSync(McpSchema.CallToolResult);
const encodeReadResult = Schema.encodeSync(McpSchema.ReadResourceResult);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Predicate.isObject(value) && !Array.isArray(value);

const omit = (record: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

/** As in AppToolkit: the approval signal and card references are Lecturn's alone. */
const sanitize = (result: McpSchema.CallToolResult): McpAppCallToolResult => {
  const { _meta, structuredContent, ...rest } = encodeCallResult(result);
  return {
    ...rest,
    ...(structuredContent === undefined
      ? {}
      : {
          structuredContent: isRecord(structuredContent)
            ? omit(structuredContent, [MCP_APP_OUTPUT_KEY])
            : structuredContent,
        }),
    ...(isRecord(_meta)
      ? { _meta: omit(_meta, [APP_TOOL_APPROVAL_REQUIRED_META_KEY, MCP_APP_OUTPUT_KEY]) }
      : {}),
  };
};

const errorResult = (text: string): McpAppCallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

const approvalRequiredReason = (result: McpSchema.CallToolResult) => {
  const required = result._meta?.[APP_TOOL_APPROVAL_REQUIRED_META_KEY];
  if (required === undefined) return undefined;
  return isRecord(required) && typeof required.reason === "string" ? required.reason : null;
};

/** Under the name the agent knows it by, as the card's `hostContext.toolInfo`. */
const presentTool = (prefix: string, tool: McpSchema.Tool) => ({
  ...encodeTool(tool),
  name: `${prefix}_${tool.name}`,
});

const toolTitle = (tool: McpSchema.Tool) =>
  tool.title ?? (typeof tool.annotations?.title === "string" ? tool.annotations.title : undefined);

/**
 * Reads one of a granted app's resources, from its headless process first and
 * then from its live endpoint. `None` means the app has no tier that can
 * answer right now (no headless tools, and closed).
 */
export const makeAppResourceReader = Effect.gen(function* () {
  const headless = yield* HeadlessToolHost;
  const live = yield* LiveToolClient;
  const leases = yield* AppLeaseService;
  return (
    registration: AppRegistration,
    projectId: ProjectId,
    uri: string,
  ): Effect.Effect<Option.Option<McpSchema.ReadResourceResult>, AppsFailure> =>
    Effect.gen(function* () {
      const fromLive = Effect.gen(function* () {
        const lease = yield* leases.current(registration.appId);
        if (!registration.liveTools || Option.isNone(lease)) return Option.none();
        return Option.some(yield* live.readResource(lease.value, uri));
      });
      if (registration.headlessTools === undefined) return yield* fromLive;
      // A live answer stands in for a failed headless one; with no live tier
      // the headless failure is the one worth reporting.
      return yield* headless.readResource(registration.appId, projectId, uri).pipe(
        Effect.asSome,
        Effect.catch((error) => fromLive.pipe(Effect.filterOrFail(Option.isSome, () => error))),
      );
    });
});

export const make = Effect.gen(function* () {
  const registry = yield* AppRegistryService;
  const projects = yield* AppProjectService;
  const leases = yield* AppLeaseService;
  const headless = yield* HeadlessToolHost;
  const live = yield* LiveToolClient;
  const approvals = yield* AppToolApprovalService;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
  const readAppResource = yield* makeAppResourceReader;

  const fail = (threadId: ThreadId, reason: McpAppRequestError["reason"], cause?: unknown) =>
    new McpAppRequestError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  /**
   * The thread's own project decides the app, so a card can only reach the
   * app whose project it is in, and only tools under that app's prefix.
   */
  const resolveCard = Effect.fn("AppMcpAppRoute.resolveCard")(function* ({
    threadId,
    app,
  }: CardTarget) {
    const thread = yield* projection
      .getThread(threadId)
      .pipe(Effect.mapError((cause) => fail(threadId, "request-failed", cause)));
    const binding = yield* projects
      .resolveAppForProject(thread.projectId)
      .pipe(Effect.mapError((cause) => fail(threadId, "request-failed", cause)));
    if (Option.isNone(binding)) return yield* fail(threadId, "not-an-app");
    const record = yield* registry
      .get(binding.value.appId)
      .pipe(Effect.mapError((cause) => fail(threadId, "request-failed", cause)));
    if (Option.isNone(record) || record.value.status.state !== "granted") {
      return yield* fail(threadId, "app-unavailable");
    }
    const prefix = `${record.value.registration.toolPrefix}_`;
    if (!app.tool.startsWith(prefix)) return yield* fail(threadId, "not-an-app");
    return {
      thread,
      record: record.value,
      appId: binding.value.appId,
      projectId: thread.projectId,
      workspaceRoot: binding.value.workspaceRoot,
    };
  });
  type Card = Effect.Success<ReturnType<typeof resolveCard>>;

  // Live definitions come from the cache whether or not the app is open, so a
  // closed app's card still learns its tools and is told why a call fails.
  const toolsFor = (card: Card) =>
    Effect.gen(function* () {
      const { registration } = card.record;
      const cached = yield* registry.cachedTools(card.appId);
      const headlessTools =
        registration.headlessTools === undefined
          ? []
          : Option.isSome(cached.headless)
            ? cached.headless.value
            : yield* headless.listForEmptyCache(card.appId, card.projectId);
      const liveTools = registration.liveTools ? Option.getOrElse(cached.live, () => []) : [];
      const tools: Array<{ readonly tier: AppToolTier; readonly tool: McpSchema.Tool }> = [];
      const seen = new Set<string>();
      for (const [tier, list] of [
        ["headless", headlessTools],
        ["live", liveTools],
      ] as const) {
        for (const tool of list) {
          if (seen.has(tool.name)) continue;
          seen.add(tool.name);
          tools.push({ tier, tool });
        }
      }
      return tools;
    }).pipe(Effect.mapError((cause) => fail(card.thread.id, "request-failed", cause)));

  const findTool = (card: Card, name: string) =>
    toolsFor(card).pipe(
      Effect.map((tools) => {
        const prefix = `${card.record.registration.toolPrefix}_`;
        return (
          tools.find(({ tool }) => tool.name === name) ??
          (name.startsWith(prefix)
            ? tools.find(({ tool }) => tool.name === name.slice(prefix.length))
            : undefined)
        );
      }),
    );

  const toolInfo: AppMcpAppRoute["toolInfo"] = Effect.fn("AppMcpAppRoute.toolInfo")(
    function* (input) {
      const card = yield* resolveCard(input);
      const found = yield* findTool(card, input.name);
      const { registration } = card.record;
      const title = found === undefined ? undefined : toolTitle(found.tool);
      return {
        callable: found !== undefined && mcpAppToolCallableByApp(found.tool._meta),
        readOnly: found?.tool.annotations?.readOnlyHint === true,
        ...(title === undefined ? {} : { title }),
        ...(found === undefined ? {} : { tool: presentTool(registration.toolPrefix, found.tool) }),
        connectedApp: {
          refPrefixes: registration.refPrefixes,
          openUrl:
            registration.openUrlTemplate === undefined
              ? null
              : expandAppOpenUrl(registration.openUrlTemplate, {
                  workspaceRoot: card.workspaceRoot,
                  threadId: card.thread.id,
                }),
        },
      } satisfies McpAppToolInfo;
    },
  );

  const readResource: AppMcpAppRoute["readResource"] = Effect.fn("AppMcpAppRoute.readResource")(
    function* (input) {
      const card = yield* resolveCard(input);
      const read = yield* readAppResource(card.record.registration, card.projectId, input.uri).pipe(
        Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)),
      );
      if (Option.isNone(read)) return yield* fail(input.threadId, "app-unavailable");
      return encodeReadResult(read.value) as McpAppReadResourceResult;
    },
  );

  const contextMeta = (card: Card) =>
    projection.getRunningTurnContext(card.thread.id).pipe(
      Effect.option,
      Effect.map((running): AppToolContextMeta => ({
        projectId: card.projectId,
        threadId: card.thread.id,
        workspaceRoot: card.workspaceRoot,
        turnId: Option.getOrUndefined(running)?.providerTurn?.id ?? null,
      })),
    );

  /**
   * Approval is raised inside the thread's running turn, where the user sees
   * it. A card in a thread that is not running has nobody to ask, so a call
   * that needs approval is refused rather than run unasked.
   */
  const ask = (
    thread: OrchestrationV2AppThread,
    info: {
      readonly appId: AppId;
      readonly appName: string;
      readonly toolName: string;
      readonly reason: string | null;
      readonly source: "static" | "app";
    },
  ) =>
    Effect.gen(function* () {
      const running = yield* projection.getRunningTurnContext(thread.id).pipe(Effect.option);
      const providerSessionId = Option.getOrUndefined(running)?.providerThread?.providerSessionId;
      if (providerSessionId == null) {
        return {
          refused: `${info.toolName} needs your approval, which Lecturn asks for in a running turn. Send a message in this thread, then try again.`,
        } as const;
      }
      const answer = yield* approvals.request({ threadId: thread.id, providerSessionId }, info);
      return answer.outcome === "approved" && answer.requestId !== null
        ? ({
            approval: { approved: true, requestId: answer.requestId } satisfies AppToolApprovalMeta,
          } as const)
        : ({
            refused: refusalMessage(
              info.toolName,
              answer.outcome === "approved" ? "cancelled" : answer.outcome,
              answer.reason,
            ),
          } as const);
    }).pipe(Effect.catch((error) => Effect.succeed({ refused: error.message } as const)));

  const callTool: AppMcpAppRoute["callTool"] = Effect.fn("AppMcpAppRoute.callTool")(
    function* (input) {
      const card = yield* resolveCard(input);
      const found = yield* findTool(card, input.name);
      if (found === undefined || !mcpAppToolCallableByApp(found.tool._meta)) {
        return yield* fail(input.threadId, "tool-not-callable");
      }
      const { registration, status } = card.record;
      const bare = found.tool.name;
      const prefixed = `${registration.toolPrefix}_${bare}`;

      if (found.tier === "live" && Option.isNone(yield* leases.current(card.appId))) {
        return errorResult(`${registration.name} is closed; open it to use ${prefixed}.`);
      }

      // As in AppToolkit.call: gate on the mode the provider actually runs.
      const running = yield* projection.getRunningTurnContext(card.thread.id).pipe(Effect.option);
      const policy = yield* runtimePolicy
        .resolve({
          thread: card.thread,
          modelSelection:
            Option.getOrUndefined(running)?.run?.modelSelection ?? card.thread.modelSelection,
        })
        .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
      const gate = (stage: AppToolGate.AppToolGateInput["stage"]) =>
        AppToolGate.decide({
          stage,
          gated: stage === "app" || registration.gatedTools.includes(bare),
          runtimeMode: policy.runtimeMode,
          interactionMode: policy.interactionMode,
          ceiling: status.runtimeCeiling,
        });
      const approve = (stage: "static" | "app", reason: string | null) => {
        const decision = gate(stage);
        switch (decision.kind) {
          case "refuse":
            return Effect.succeed({ refused: decision.reason } as const);
          case "forward":
            return Effect.succeed({
              approval: { approved: decision.approved } satisfies AppToolApprovalMeta,
            } as const);
          case "ask":
            return ask(card.thread, {
              appId: card.appId,
              appName: registration.name,
              toolName: prefixed,
              reason,
              source: stage,
            });
        }
      };

      const context = yield* contextMeta(card);
      const forward = (approval: AppToolApprovalMeta) =>
        Effect.gen(function* () {
          const request: AppToolCallRequest = {
            name: bare,
            arguments: input.arguments,
            meta: { [APP_TOOL_CONTEXT_META_KEY]: context, [APP_TOOL_APPROVAL_META_KEY]: approval },
          };
          // As in AppToolkit.call: an approval can wait for minutes, so an app
          // revoked or closed meanwhile is not contacted.
          const record = yield* registry
            .get(card.appId)
            .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
          if (Option.isNone(record) || record.value.status.state !== "granted") {
            return yield* fail(input.threadId, "app-unavailable");
          }
          if (found.tier === "headless") {
            return yield* headless
              .call(card.appId, card.projectId, request)
              .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
          }
          const current = yield* leases.current(card.appId);
          if (Option.isNone(current)) {
            return new McpSchema.CallToolResult({
              isError: true,
              content: [
                {
                  type: "text",
                  text: `${registration.name} is closed; open it to use ${prefixed}.`,
                },
              ],
            });
          }
          return yield* live
            .call(current.value, request)
            .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
        });

      const first = yield* approve("static", null);
      if ("refused" in first) return errorResult(first.refused);
      let result = yield* forward(first.approval);

      const reason = approvalRequiredReason(result);
      if (reason !== undefined && !first.approval.approved) {
        const second = yield* approve("app", reason);
        if ("refused" in second) return errorResult(second.refused);
        result = yield* forward({ ...second.approval, approved: true });
      }
      return sanitize(result);
    },
  );

  return { toolInfo, callTool, readResource } satisfies AppMcpAppRoute;
});

/**
 * Publishes the route for McpAppRequests while the caller's scope lasts.
 * AppsLayer builds this once, from `AppCardEnvelope.make`.
 */
export const register = Effect.gen(function* () {
  const { mcpAppRoute } = yield* AppRuntimeState;
  const route = yield* make;
  yield* Effect.acquireRelease(Ref.set(mcpAppRoute, Option.some(route)), () =>
    Ref.set(mcpAppRoute, Option.none()),
  );
});
