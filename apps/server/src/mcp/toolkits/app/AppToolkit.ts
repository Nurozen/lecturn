/**
 * A connected app's tools on Lecturn's `/mcp`, for threads in that app's
 * projects (R4). The interceptor (AppToolInterceptor.ts) reaches this through
 * `AppToolSource`.
 *
 * `call` runs in a fixed order, and each later step's policy lives in its own
 * file so its owner never edits this one:
 *   1. resolve the app and the tool's tier;
 *   2. live tools: check the lease;
 *   3. AppToolGate.decide;
 *   4. ask for approval if the gate says so (appToolApproval.ts);
 *   5. forward with Lecturn's `_meta`;
 *   6. if the app answers `lecturn/approval-required`, gate and ask again, then
 *      re-send with `{ approved: true, requestId }`;
 *   7. wrap the result for cards (AppCardEnvelope.ts).
 */
import {
  APP_TOOL_APPROVAL_META_KEY,
  APP_TOOL_APPROVAL_REQUIRED_META_KEY,
  APP_TOOL_CONTEXT_META_KEY,
  type AppId,
  type AppRegistration,
  AppsError,
  type AppToolApprovalMeta,
  type AppToolContextMeta,
  type ToolActivitySource,
} from "@lecturn/contracts";
import { MCP_APP_OUTPUT_KEY } from "@lecturn/shared/mcpApp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import {
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  type AppRecord,
  AppsNotImplemented,
  type AppToolCallRequest,
  AppToolkit,
  type AppToolTier,
  HeadlessToolHost,
  LiveToolClient,
} from "../../../apps/services.ts";
import * as AppToolGate from "../../../apps/AppToolGate.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as RuntimePolicy from "../../../orchestration-v2/RuntimePolicy.ts";
import { appInvocationScope, type McpAppInvocationScope } from "../../McpInvocationContext.ts";
import * as AppCardEnvelope from "./AppCardEnvelope.ts";
import * as AppToolApproval from "./appToolApproval.ts";
import { AppToolSource } from "./AppToolInterceptor.ts";

/** Where the work log reads the app's name and icon for its tool rows. */
export const APP_TOOL_SOURCE_META_KEY = "lecturn/toolSource";

/** `ToolActivityIcon.logoUrl` caps URLs here; larger icons are left out. */
const MAX_TOOL_SOURCE_ICON_LENGTH = 4096;

export interface AppToolkitExtensions {
  readonly decide: (input: AppToolGate.AppToolGateInput) => AppToolGate.AppToolGateDecision;
  readonly requestApproval: AppToolApproval.RequestAppToolApproval;
  readonly wrapResult: AppCardEnvelope.WrapAppToolResult;
}

interface AppTool {
  readonly tier: AppToolTier;
  readonly tool: McpSchema.Tool;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const uiMeta = (tool: McpSchema.Tool) => (isRecord(tool._meta?.ui) ? tool._meta.ui : undefined);

/** MCP Apps: a tool without "model" in its visibility is for cards only. */
const visibleToModel = (tool: McpSchema.Tool) => {
  const visibility = uiMeta(tool)?.visibility;
  return !Array.isArray(visibility) || visibility.includes("model");
};

/**
 * D6: other `_meta` keys are provider hints Lecturn has not vetted, and an
 * adapter could change how it treats the tool because of one.
 */
const presentTool = (prefix: string, tool: McpSchema.Tool): McpSchema.Tool => {
  const ui = uiMeta(tool);
  const passedUi = {
    ...(typeof ui?.resourceUri === "string" ? { resourceUri: ui.resourceUri } : {}),
    ...(Array.isArray(ui?.visibility) ? { visibility: ui.visibility } : {}),
  };
  return new McpSchema.Tool({
    name: `${prefix}_${tool.name}`,
    inputSchema: tool.inputSchema,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    ...(Object.keys(passedUi).length === 0 ? {} : { _meta: { ui: passedUi } }),
  });
};

/** Lecturn's own keys come from Lecturn only; an agent cannot pre-approve a call. */
const withoutLecturnKeys = (meta: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(meta).filter(([key]) => !key.startsWith("lecturn/")));

const approvalRequiredReason = (result: McpSchema.CallToolResult) => {
  const required = result._meta?.[APP_TOOL_APPROVAL_REQUIRED_META_KEY];
  if (required === undefined) return undefined;
  return isRecord(required) && typeof required.reason === "string" ? required.reason : null;
};

const omit = <T extends Readonly<Record<string, unknown>>>(
  record: T,
  keys: ReadonlyArray<string>,
) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

/**
 * The approval signal is Lecturn's to act on, and a card reference is
 * Lecturn's to attach: an app-supplied one would point a card at any
 * attachment.
 */
const sanitizeResult = (
  result: McpSchema.CallToolResult,
  toolSource: ToolActivitySource,
): McpSchema.CallToolResult => {
  const structured = result.structuredContent;
  return new McpSchema.CallToolResult({
    content: result.content,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(structured === undefined
      ? {}
      : {
          structuredContent: isRecord(structured)
            ? omit(structured, [MCP_APP_OUTPUT_KEY])
            : structured,
        }),
    _meta: {
      ...omit(result._meta ?? {}, [APP_TOOL_APPROVAL_REQUIRED_META_KEY, MCP_APP_OUTPUT_KEY]),
      [APP_TOOL_SOURCE_META_KEY]: toolSource,
    },
  });
};

const errorResult = (text: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text }] });

const toolSourceFor = (registration: AppRegistration): ToolActivitySource => ({
  key: `app:${registration.appId}`,
  name: registration.name,
  kind: "integration",
  ...(registration.iconDataUrl.length <= MAX_TOOL_SOURCE_ICON_LENGTH
    ? { icon: { _tag: "themed-logo", logoUrl: registration.iconDataUrl } }
    : {}),
});

const notImplemented = (method: string) =>
  new AppsNotImplemented({ service: "AppToolkit", method });

export const makeAppToolkit = Effect.fn("AppToolkit.make")(function* (
  extensions: AppToolkitExtensions,
) {
  const registry = yield* AppRegistryService;
  const projects = yield* AppProjectService;
  const leases = yield* AppLeaseService;
  const headless = yield* HeadlessToolHost;
  const live = yield* LiveToolClient;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;

  const grantedApp = (appId: AppId) =>
    registry
      .get(appId)
      .pipe(Effect.map(Option.filter((record: AppRecord) => record.status.state === "granted")));

  const headlessTools = (
    scope: McpAppInvocationScope,
    record: AppRecord,
    cached: AppCachedHeadless,
  ) =>
    record.registration.headlessTools === undefined
      ? Effect.succeed([])
      : Option.isSome(cached)
        ? Effect.succeed(cached.value)
        : headless.listForEmptyCache(scope.app.appId, scope.app.projectId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("App headless tools could not be listed", {
                appId: scope.app.appId,
                cause,
              }).pipe(Effect.as([])),
            ),
          );

  const appTools = (scope: McpAppInvocationScope, record: AppRecord) =>
    Effect.gen(function* () {
      const cached = yield* registry.cachedTools(scope.app.appId);
      const tools: Array<AppTool> = [];
      const seen = new Set<string>();
      const add = (tier: AppToolTier, list: ReadonlyArray<McpSchema.Tool>) => {
        for (const tool of list) {
          if (seen.has(tool.name)) continue;
          seen.add(tool.name);
          tools.push({ tier, tool });
        }
      };
      add("headless", yield* headlessTools(scope, record, cached.headless));
      if (record.registration.liveTools)
        add(
          "live",
          Option.getOrElse(cached.live, () => []),
        );
      return tools;
    });

  const listFor: AppToolkit["Service"]["listFor"] = (invocation) =>
    Effect.gen(function* () {
      const scope = appInvocationScope(invocation);
      if (scope === undefined) return [];
      const record = yield* grantedApp(scope.app.appId);
      if (Option.isNone(record)) return [];
      const prefix = record.value.registration.toolPrefix;
      return (yield* appTools(scope, record.value))
        .filter(({ tool }) => visibleToModel(tool))
        .map(({ tool }) => presentTool(prefix, tool));
    });

  const contextMeta = (scope: McpAppInvocationScope) =>
    Effect.gen(function* () {
      const binding = yield* projects.resolveAppForProject(scope.app.projectId);
      if (Option.isNone(binding) || binding.value.appId !== scope.app.appId) {
        return yield* new AppsError({
          code: "forbidden",
          message: `Project ${scope.app.projectId} does not belong to ${scope.app.appId}.`,
        });
      }
      const running = Option.getOrUndefined(
        yield* projection.getRunningTurnContext(scope.thread.threadId).pipe(Effect.option),
      );
      return {
        meta: {
          projectId: scope.app.projectId,
          threadId: scope.thread.threadId,
          workspaceRoot: binding.value.workspaceRoot,
          turnId: running?.providerTurn?.id ?? null,
        } satisfies AppToolContextMeta,
        runModelSelection: running?.run?.modelSelection,
      };
    });

  const call: AppToolkit["Service"]["call"] = (invocation, name, args, meta) =>
    Effect.gen(function* () {
      const scope = appInvocationScope(invocation);
      if (scope === undefined) {
        return yield* new AppsError({
          code: "forbidden",
          message: "Only threads in a connected app's project can call its tools.",
        });
      }
      const { appId, projectId } = scope.app;
      const found = yield* grantedApp(appId);
      if (Option.isNone(found)) {
        return yield* new AppsError({
          code: "forbidden",
          message: `${appId} is not a granted connected app.`,
        });
      }
      const record = found.value;
      const { registration } = record;
      const toolSource = toolSourceFor(registration);
      const bare = name.startsWith(`${registration.toolPrefix}_`)
        ? name.slice(registration.toolPrefix.length + 1)
        : undefined;

      // 1. App and tier.
      const appTool = (yield* appTools(scope, record)).find(
        ({ tool }) => tool.name === bare && visibleToModel(tool),
      );
      if (bare === undefined || appTool === undefined) {
        return yield* new AppsError({ code: "not-found", message: `Unknown app tool ${name}.` });
      }

      // 2. Lease, before any gating: a closed app is never contacted.
      if (appTool.tier === "live" && Option.isNone(yield* leases.current(appId))) {
        return errorResult(`${registration.name} is closed; open it to use ${name}.`);
      }

      const thread = yield* projection
        .getThread(scope.thread.threadId)
        .pipe(
          Effect.mapError(
            () =>
              new AppsError({ code: "unavailable", message: "Could not read the calling thread." }),
          ),
        );
      const context = yield* contextMeta(scope);
      // The stored mode is what the user picked; the provider may run a lower
      // one (RuntimePolicy downgrades unsupported modes), and app tools must
      // not be more permissive than the provider's own tools.
      const policy = yield* runtimePolicy
        .resolve({ thread, modelSelection: context.runModelSelection ?? thread.modelSelection })
        .pipe(
          Effect.mapError(
            () =>
              new AppsError({
                code: "unavailable",
                message: "Could not resolve the calling thread's runtime mode.",
              }),
          ),
        );
      const gate = (stage: AppToolGate.AppToolGateInput["stage"]) =>
        extensions.decide({
          stage,
          gated: stage === "app" || registration.gatedTools.includes(bare),
          runtimeMode: policy.runtimeMode,
          interactionMode: policy.interactionMode,
          ceiling: record.status.runtimeCeiling,
        });
      const approve = (
        decision: AppToolGate.AppToolGateDecision,
        source: "static" | "app",
        reason: string | null,
      ) =>
        Effect.gen(function* () {
          switch (decision.kind) {
            case "refuse":
              return { refused: decision.reason } as const;
            case "forward":
              return { approval: { approved: decision.approved } satisfies AppToolApprovalMeta };
            case "ask": {
              const answer = yield* extensions.requestApproval({
                scope,
                info: { appId, appName: registration.name, toolName: name, reason, source },
              });
              return answer.approved
                ? {
                    approval: {
                      approved: true,
                      requestId: answer.requestId,
                    } satisfies AppToolApprovalMeta,
                  }
                : ({ refused: answer.message } as const);
            }
          }
        });

      const forward = (approval: AppToolApprovalMeta) =>
        Effect.gen(function* () {
          const request: AppToolCallRequest = {
            name: bare,
            arguments: args,
            meta: {
              ...withoutLecturnKeys(meta),
              [APP_TOOL_CONTEXT_META_KEY]: context.meta,
              [APP_TOOL_APPROVAL_META_KEY]: approval,
            },
          };
          // An approval can wait for minutes, so the grant and lease read
          // before it are stale: an app revoked or closed meanwhile is not contacted.
          if (Option.isNone(yield* grantedApp(appId))) {
            return yield* new AppsError({
              code: "forbidden",
              message: `${appId} is not a granted connected app.`,
            });
          }
          if (appTool.tier === "headless") {
            return { request, result: yield* headless.call(appId, projectId, request) };
          }
          const current = yield* leases.current(appId);
          if (Option.isNone(current)) {
            return {
              request,
              result: errorResult(`${registration.name} is closed; open it to use ${name}.`),
            };
          }
          return { request, result: yield* live.call(current.value, request) };
        });

      // A refused call still gets its card, shown as cancelled.
      const refuse = (request: AppToolCallRequest, reason: string) =>
        extensions.wrapResult({
          scope,
          appId,
          tier: appTool.tier,
          tool: appTool.tool,
          request,
          result: errorResult(reason),
          refusal: reason,
        });

      // 3 and 4. Static gate.
      const first = yield* approve(gate("static"), "static", null);
      if ("refused" in first) {
        return yield* refuse(
          { name: bare, arguments: args, meta: withoutLecturnKeys(meta) },
          first.refused,
        );
      }

      // 5. Forward.
      let sent = yield* forward(first.approval);

      // 6. App-decided gate.
      const reason = approvalRequiredReason(sent.result);
      if (reason !== undefined && !first.approval.approved) {
        const second = yield* approve(gate("app"), "app", reason);
        if ("refused" in second) return yield* refuse(sent.request, second.refused);
        // The app already said it needs approval; a gate that lets the call
        // through without asking (Full access) is approving it.
        sent = yield* forward({ ...second.approval, approved: true });
      }

      // 7. Envelope.
      return yield* extensions.wrapResult({
        scope,
        appId,
        tier: appTool.tier,
        tool: appTool.tool,
        request: sent.request,
        result: sanitizeResult(sent.result, toolSource),
      });
    });

  return AppToolkit.of({
    listFor,
    call,
    readResource: () => Effect.fail(notImplemented("readResource")),
    cardToolCall: () => Effect.fail(notImplemented("cardToolCall")),
  });
});

type AppCachedHeadless = Option.Option<ReadonlyArray<McpSchema.Tool>>;

const layerToolkit = Layer.effect(
  AppToolkit,
  Effect.gen(function* () {
    return yield* makeAppToolkit({
      decide: AppToolGate.decide,
      requestApproval: yield* AppToolApproval.make,
      wrapResult: yield* AppCardEnvelope.make,
    });
  }),
);

const encodeTool = Schema.encodeSync(McpSchema.Tool);
const encodeResult = Schema.encodeSync(McpSchema.CallToolResult);

/** App failures become tool results so the agent sees why; the interceptor never drops built-ins. */
const layerToolSource = Layer.effect(
  AppToolSource,
  Effect.gen(function* () {
    const toolkit = yield* AppToolkit;
    return AppToolSource.of({
      listFor: (scope) =>
        toolkit.listFor(scope).pipe(
          Effect.map((tools) => tools.map((tool) => encodeTool(tool))),
          Effect.orDie,
        ),
      call: (scope, name, args, meta) =>
        toolkit.call(scope, name, isRecord(args) ? args : {}, meta ?? {}).pipe(
          Effect.catch((error) => Effect.succeed(errorResult(error.message))),
          Effect.map((result) => encodeResult(result)),
        ),
    });
  }),
);

/** The toolkit over a caller-supplied runtime policy. */
export const layerWithRuntimePolicy = layerToolSource.pipe(Layer.provideMerge(layerToolkit));

// RuntimeLayer keeps its RuntimePolicyV2 internal; this one is a stateless
// read over the same project store and provider registry.
const layerRuntimePolicy = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(ProjectStore.layer),
);

export const layer = layerWithRuntimePolicy.pipe(Layer.provide(layerRuntimePolicy));
