import { describe, expect, it } from "@effect/vitest";
import {
  AppId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AppStatus,
  type OrchestrationProjectShell,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { AppRegistryService } from "../../../apps/services.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as AppsHandlers from "./handlers.ts";
import { AppsToolkit } from "./tools.ts";

const rocketwright = AppId.make("dev.rocketwright.app");
const other = AppId.make("dev.other.app");
const rocketProject = ProjectId.make("project:rocket");
const rocketSecond = ProjectId.make("project:rocket-2");
const otherProject = ProjectId.make("project:other");
const normalProject = ProjectId.make("project:normal");

const status = (appId: AppId, fields: Partial<AppStatus> = {}) =>
  ({
    appId,
    name: appId,
    iconDataUrl: "data:image/png;base64,AA==",
    toolPrefix: appId === rocketwright ? "rw" : "ot",
    refPrefixes: ["part:"],
    openUrlTemplate: null,
    state: "granted",
    live: null,
    lastSeenAt: null,
    runtimeCeiling: null,
    headlessTools: null,
    gatedTools: [],
    embedOrigins: [],
    pendingRequest: null,
    ...fields,
  }) as AppStatus;

const shell = (id: ProjectId, appId?: AppId) =>
  ({
    id,
    title: `Title ${id}`,
    workspaceRoot: `/work/${id}`,
    defaultModelSelection: null,
    scripts: [],
    ...(appId === undefined ? {} : { appBinding: { appId, workspaceRoot: `/work/${id}` } }),
  }) as unknown as OrchestrationProjectShell;

const statuses = [
  status(rocketwright, { live: { expiresAt: "2026-10-25T00:01:00.000Z" } as AppStatus["live"] }),
  status(other, { state: "pairing-requested", pendingRequest: {} as AppStatus["pendingRequest"] }),
];
const shells = [
  shell(rocketProject, rocketwright),
  shell(rocketSecond, rocketwright),
  shell(otherProject, other),
  shell(normalProject),
];

const scope = (
  app?: McpInvocationContext.McpAppCaller,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "provider:thread",
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "provider:thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(app === undefined ? ["orchestration"] : ["orchestration", "app"]),
  ...(app === undefined ? {} : { app }),
  issuedAt: 0,
});

describe("lecturn_apps_list", () => {
  it("lists every app with its projects for an ordinary caller", () => {
    const apps = AppsHandlers.connectedApps(scope(), statuses, shells);
    expect(apps).toEqual([
      {
        appId: rocketwright,
        name: rocketwright,
        toolPrefix: "rw",
        state: "granted",
        live: true,
        pairingPending: false,
        runtimeCeiling: null,
        lastSeenAt: null,
        projects: [
          {
            projectId: rocketProject,
            title: `Title ${rocketProject}`,
            workspaceRoot: "/work/project:rocket",
          },
          {
            projectId: rocketSecond,
            title: `Title ${rocketSecond}`,
            workspaceRoot: "/work/project:rocket-2",
          },
        ],
      },
      {
        appId: other,
        name: other,
        toolPrefix: "ot",
        state: "pairing-requested",
        live: false,
        pairingPending: true,
        runtimeCeiling: null,
        lastSeenAt: null,
        projects: [
          {
            projectId: otherProject,
            title: `Title ${otherProject}`,
            workspaceRoot: "/work/project:other",
          },
        ],
      },
    ]);
  });

  it("shows an app thread only its own app and project", () => {
    const apps = AppsHandlers.connectedApps(
      scope({ appId: rocketwright, projectId: rocketProject }),
      statuses,
      shells,
    );
    expect(apps.map((app) => app.appId)).toEqual([rocketwright]);
    expect(apps[0]?.projects.map((project) => project.projectId)).toEqual([rocketProject]);
  });

  const handle = (registry: Layer.Layer<never> | Layer.Layer<AppRegistryService>) =>
    Effect.gen(function* () {
      const dependencies = Layer.mergeAll(
        registry,
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope()),
        Layer.mock(ProjectService.ProjectService)({ listShells: () => Effect.succeed(shells) }),
      );
      const toolkit = yield* AppsToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(AppsHandlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const result = yield* toolkit
        .handle("lecturn_apps_list", {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      return result.at(-1)?.result;
    });

  it.effect("reads the registry without exposing icons or pairing details", () =>
    Effect.gen(function* () {
      const result = yield* handle(
        Layer.mock(AppRegistryService)({ list: Effect.succeed(statuses) }),
      );
      expect(result).toMatchObject({ apps: [{ appId: rocketwright }, { appId: other }] });
      expect(JSON.stringify(result)).not.toContain("iconDataUrl");
    }),
  );

  it.effect("lists no apps on a server built without the apps services", () =>
    Effect.gen(function* () {
      expect(yield* handle(Layer.empty)).toEqual({ apps: [] });
    }),
  );
});
