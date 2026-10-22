// Project commands run through the fork hook registry even when ProjectService is
// built before (and outside) the layer that provides the registry, as server.ts does
// for the PR-watch observer. Found by the boot smoke: ProjectService resolved no-op hooks.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@lecturn/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as RuntimeLayer from "../runtimeLayer.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import * as LecturnOrchestrationHooks from "./LecturnOrchestrationHooks.ts";

const admittedScopes: Array<string> = [];

const ProbeRegistrationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* LecturnOrchestrationHooks.LecturnOrchestrationHooks;
    yield* hooks.register({
      name: "probe",
      aroundCommand: (input, commit) =>
        Effect.sync(() => admittedScopes.push(input.scope)).pipe(Effect.andThen(commit)),
    });
  }),
);

// Server order: ProjectService first (outer provide), registrations afterwards.
const TestLayer = ProbeRegistrationLive.pipe(
  Layer.provide(RuntimeLayer.layerLecturnOrchestrationHooks),
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-project-service-hooks-" }),
  ),
  Layer.provide(NodeServices.layer),
);

it.layer(TestLayer)("ProjectService fork hooks", (it) => {
  it.effect("admits project commands through hooks registered after it was built", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      yield* projects.create({
        commandId: CommandId.make("project-service-hooks-create"),
        projectId: ProjectId.make("project-service-hooks"),
        title: "Hooks",
        workspaceRoot: "/work/project-service-hooks",
      });
      expect(admittedScopes).toContain("project");
    }),
  );
});
