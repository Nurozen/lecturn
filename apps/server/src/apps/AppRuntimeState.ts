/**
 * Connected-app state that orchestration hooks must reach. The orchestration runtime is built below
 * AppsLayer, so RuntimeLayer provides these refs once and the AppsLayer services that own them
 * (AppHostContextStore, HeadlessToolHost) wrap the same refs. State only: no logic.
 */
import type { AppId, ProjectId, ThreadId } from "@lecturn/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { AppMcpAppRoute } from "../mcpApps/AppMcpAppRoute.ts";
import type { SquireMcpAppRoute } from "../squire/showcase/showcaseApp.ts";

export type AppHostContextKey = `thread:${ThreadId}` | `project:${ProjectId}`;

export const hostContextKey = (
  target: { readonly threadId: ThreadId } | { readonly projectId: ProjectId },
): AppHostContextKey =>
  "threadId" in target ? `thread:${target.threadId}` : `project:${target.projectId}`;

/** `None` for a project no granted app owns, or whose app registered no instructions. */
export type AppInstructionsLookup = (projectId: ProjectId) => Effect.Effect<Option.Option<string>>;

/** A granted app's tool prefix and its cached tool names, prefixed as agents see them. */
export interface AppCredentialTools {
  readonly toolPrefix: string;
  readonly toolNames: ReadonlyArray<string>;
}

/** `None` for an app that is not granted. */
export type AppToolsLookup = (appId: AppId) => Effect.Effect<Option.Option<AppCredentialTools>>;

/** Processes are keyed by app project, never by credential. */
export type HeadlessProcessKey = `${AppId} ${ProjectId}`;

/** One live call-path process, as the idle reaper needs to see it. */
export interface HeadlessProcessEntry {
  readonly appId: AppId;
  readonly projectId: ProjectId;
  /** The reaper never closes a process that is still finishing a call. */
  readonly inFlightCalls: number;
  readonly lastCallEndedAt: DateTime.Utc | null;
  /** Closes stdin and waits; the app's own owner may keep serving. */
  readonly close: Effect.Effect<void>;
  /** Revoke and shutdown only. */
  readonly kill: Effect.Effect<void>;
}

/** Starts the idle reaper's watch on one process unless it already has one. */
export type HeadlessIdleWatch = (key: HeadlessProcessKey) => Effect.Effect<void>;

export class AppRuntimeState extends Context.Service<
  AppRuntimeState,
  {
    /** Written by AppHostContextStore, read by the beforeTurnStart contribution. */
    readonly hostContext: Ref.Ref<ReadonlyMap<AppHostContextKey, string>>;
    /** Written by HeadlessToolHost, read by the onRunTerminal reaper contribution. */
    readonly headlessProcesses: Ref.Ref<ReadonlyMap<HeadlessProcessKey, HeadlessProcessEntry>>;
    /**
     * Set while the reaper is up (headlessReaper.ts). HeadlessToolHost arms it
     * when a call leaves a process idle: a card's call outside any run has no
     * run end to do so.
     */
    readonly headlessIdleWatch: Ref.Ref<Option.Option<HeadlessIdleWatch>>;
    /**
     * Set while an AppsLayer is built over this state. A second build would
     * split lease, registry and process state between transports, so it dies.
     */
    readonly appsLayerBuilt: Ref.Ref<boolean>;
    /**
     * Connected-app cards' requests, set while AppsLayer is up: McpAppRequests
     * is built below AppsLayer and reaches the route through here.
     */
    readonly mcpAppRoute: Ref.Ref<Option.Option<AppMcpAppRoute>>;
    /** Lecturn: showcase cards' requests, set while the Squire layer is up. */
    readonly squireMcpAppRoute: Ref.Ref<Option.Option<SquireMcpAppRoute>>;
    /**
     * A granted app's instructions for turns in its projects, set while
     * AppsOrchestrationHooks is up: RunExecutionService cannot see the
     * registry, so it asks through here (appTurnInstructions.ts).
     */
    readonly appInstructions: Ref.Ref<Option.Option<AppInstructionsLookup>>;
    /**
     * Set while AppsOrchestrationHooks is up: the session manager mints a
     * thread's MCP credential below AppsLayer and reads the app's tool names
     * through here (appMcpCredential.ts).
     */
    readonly appTools: Ref.Ref<Option.Option<AppToolsLookup>>;
  }
>()("lecturn/apps/AppRuntimeState") {}

export const layer = Layer.effect(
  AppRuntimeState,
  Effect.all({
    hostContext: Ref.make<ReadonlyMap<AppHostContextKey, string>>(new Map()),
    headlessProcesses: Ref.make<ReadonlyMap<HeadlessProcessKey, HeadlessProcessEntry>>(new Map()),
    headlessIdleWatch: Ref.make(Option.none<HeadlessIdleWatch>()),
    appsLayerBuilt: Ref.make(false),
    mcpAppRoute: Ref.make(Option.none<AppMcpAppRoute>()),
    squireMcpAppRoute: Ref.make(Option.none<SquireMcpAppRoute>()),
    appInstructions: Ref.make(Option.none<AppInstructionsLookup>()),
    appTools: Ref.make(Option.none<AppToolsLookup>()),
  }),
);
